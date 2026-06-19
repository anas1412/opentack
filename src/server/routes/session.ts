import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { db, schema } from "../../db";
import { startSessionServer, stopSessionServer, getSessionPort, getSessionPid } from "../opencode-manager";
import { emitSse } from "../sse";
import { enrichFromOpencode, getOpencodeDb, verifyOpencodeSession, fetchOpencodeSessionCost } from "./cost-utils";
import { createWorktreeForTicket } from "./worktree";

// Track which sessions are currently improving prompts (for client polling)
const improvingSessions = new Map<string, boolean>();

const createSessionSchema = z.object({
  ticketId: z.string().uuid(),
});

// ─── Opencode config helpers ──────────────────────────────────────────

function getOpencodeConfigPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(process.env.HOME!, ".config", "opencode");
  return join(configDir, "opencode.json");
}

function readOpencodeModel(): { providerID: string; id: string } | undefined {
  const path = getOpencodeConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const modelStr = config.model as string | undefined;
    if (!modelStr) return undefined;
    const parts = modelStr.split("/");
    if (parts.length === 2) return { providerID: parts[0], id: parts[1] };
    if (parts.length === 1) return { providerID: "", id: parts[0] };
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Opencode message injector ────────────────────────────────────────

/**
 * Send a plain text message to an opencode session.
 */
async function sendToSession(
  port: number,
  repoPath: string,
  sessionId: string,
  text: string,
  noReply = false,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/message?directory=${encodeURIComponent(repoPath)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      noReply,
      parts: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`Failed to send message: ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Use the AI itself to turn the raw ticket description into a better-structured
 * initial prompt, then send that to the session. Falls back to the raw description.
 */
async function generateAndSendImprovedPrompt(
  port: number,
  repoPath: string,
  opencodeSessionId: string,
  description: string,
  onInjecting?: () => void,
): Promise<void> {
  const tempLabel = `improve-${crypto.randomUUID().slice(0, 8)}`;

  try {
    // 1. Create a temporary session on the same server
    const createRes = await fetch(
      `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(repoPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: tempLabel }),
      },
    );
    if (!createRes.ok) throw new Error(`Failed to create temp session: ${createRes.status}`);
    const { id: tempSessionId } = await createRes.json() as { id: string };

    try {
      // 2. Build improvement prompt
      const improvementPrompt = `Rewrite the following task description into a detailed, well-structured prompt for an AI coding assistant.

Rules:
- Do NOT use any tools, read any files, or scan the repository.
- Only rewrite the text below. Do not add information from anywhere else.
- Return ONLY the rewritten prompt. No explanations, no prefixes, no markdown formatting.

Original description:
${description}

Prompt:`;

      // 3. Send to temp session
      const msgRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repoPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: improvementPrompt }],
          }),
        },
      );
      if (!msgRes.ok) throw new Error(`Failed to send improvement prompt: ${msgRes.status}`);

      // 4. Wait for AI to finish
      await fetch(
        `http://127.0.0.1:${port}/api/session/${tempSessionId}/wait`,
        { method: "POST" },
      );

      // 5. Read the AI response
      const msgListRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repoPath)}`,
      );
      type Msg = { info: { role: string }; parts: Array<{ type: string; text?: string }> };
      const messages = await msgListRes.json() as Msg[];

      const improved = (Array.isArray(messages) ? messages : [])
        .filter((m) => m.info?.role === "assistant")
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n");

      // 6. Save app-level cost before deleting
      try {
        const cost = fetchOpencodeSessionCost(tempSessionId);
        if (cost) {
          await db.insert(schema.appCost).values({
            id: crypto.randomUUID(),
            type: "improve_prompt",
            ticketId: null,
            costUsd: cost.costUsd,
            totalTokens: cost.totalTokens,
            createdAt: Date.now(),
          });
        }
      } catch { /* best-effort */ }

      // 7. Send the improved prompt (or original as fallback) to the real session
      // Fire onInjecting right when the HTTP request is sent (AI starts working), don't wait for full reply
      const sendPromise = sendToSession(port, repoPath, opencodeSessionId, improved || description);
      onInjecting?.();
      await sendPromise;
    } finally {
      // Clean up temp session
      fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}?directory=${encodeURIComponent(repoPath)}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
  } catch (err) {
    console.warn("Failed to generate improved prompt, sending raw description:", err);
    const sendPromise = sendToSession(port, repoPath, opencodeSessionId, description).catch(() => {});
    onInjecting?.();
    await sendPromise;
  }
}

export function registerSessionRoutes(app: FastifyInstance) {
  // Recent sessions activity feed (across all repos)
  app.get("/api/sessions/recent", async (req) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      repoId: z.string().uuid().optional(),
    }).parse(req.query);

    // Build the query — only ticket sessions (exclude chats), join with tickets (+ repos) for metadata
    const conditions = [isNotNull(schema.sessions.ticketId)];
    if (query.repoId) conditions.push(eq(schema.tickets.repoId, query.repoId));

    const rows = await db
      .select({
        id: schema.sessions.id,
        ticketId: schema.sessions.ticketId,
        ticketTitle: schema.tickets.title,
        repoId: schema.tickets.repoId,
        repoName: schema.repos.name,
        model: schema.sessions.model,
        opencodeSessionId: schema.sessions.opencodeSessionId,
        totalTokens: schema.sessions.totalTokens,
        costUsd: schema.sessions.costUsd,
        createdAt: schema.sessions.createdAt,
        endedAt: schema.sessions.endedAt,
        durationMs: schema.sessions.durationMs,
        exitCode: schema.sessions.exitCode,
        exitReason: schema.sessions.exitReason,
      })
      .from(schema.sessions)
      .innerJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
      .innerJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.sessions.createdAt))
      .limit(query.limit);

    // Batch-enrich with real token/cost data from opencode DB
    const ocDb = getOpencodeDb();
    if (ocDb) {
      try {
        const sessionIds = rows
          .map((r) => r.opencodeSessionId)
          .filter((id): id is string => id !== null);

        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => "?").join(",");
          const opencodeRows = ocDb
            .query(
              `SELECT id, cost, tokens_input + tokens_output as total_tokens
               FROM session WHERE id IN (${placeholders})`,
            )
            .all(...sessionIds) as { id: string; cost: number; total_tokens: number }[];

          const ocMap = new Map(opencodeRows.map((r) => [r.id, r]));

          for (const row of rows) {
            if (row.opencodeSessionId && ocMap.has(row.opencodeSessionId)) {
              const oc = ocMap.get(row.opencodeSessionId)!;
              row.costUsd = oc.cost;
              row.totalTokens = oc.total_tokens;
            }
          }
        }
      } finally {
        ocDb.close();
      }
    }

    return rows;
  });

  // List sessions for a ticket
  app.get("/api/tickets/:ticketId/sessions", async (req, reply) => {
    const { ticketId } = req.params as { ticketId: string };

    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId));

    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    const rows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.ticketId, ticketId))
      .orderBy(schema.sessions.createdAt);

    return rows.map((row) => {
      const s = deserializeSession(row);
      const enriched = enrichFromOpencode(s.opencodeSessionId ?? null, {
        costUsd: s.costUsd,
        totalTokens: s.totalTokens,
      });
      return { ...s, costUsd: enriched.costUsd, totalTokens: enriched.totalTokens };
    });
  });

  // Get session
  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id));
    if (!row)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });
    return deserializeSession(row);
  });

  // Create or re-use session (starts opencode serve for the repo)
  app.post("/api/sessions", async (req, reply) => {
    const input = createSessionSchema.parse(req.body);

    // Load ticket + repo
    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, input.ticketId));

    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    const [repo] = await db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, ticket.repoId));

    if (!repo)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });

    // Auto-create worktree on first session start if it doesn't exist yet.
    // If worktreePath is set but the directory was deleted out-of-band
    // (e.g. manual git worktree remove), clear it and create fresh.
    let sessionCwd: string;
    if (ticket.worktreePath && existsSync(ticket.worktreePath)) {
      sessionCwd = ticket.worktreePath;
    } else if (ticket.worktreePath) {
      app.log.warn({ ticketId: ticket.id, worktreePath: ticket.worktreePath }, "Worktree path missing — will create new");
      await db.update(schema.tickets).set({ worktreePath: null, updatedAt: Date.now() }).where(eq(schema.tickets.id, ticket.id));
      sessionCwd = await createWorktreeForTicket(ticket, repo, app.log);
    } else {
      app.log.info({ ticketId: ticket.id }, "No worktree yet — creating one");
      sessionCwd = await createWorktreeForTicket(ticket, repo, app.log);
    }

    // One session per ticket — find any existing session (active or ended)
    const [existingSession] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.ticketId, input.ticketId))
      .limit(1);

    let sessionId: string;
    let opencodeSessionId: string | null = null;

    if (existingSession) {
      // Reuse — reset end state so it appears active again
      sessionId = existingSession.id;
      opencodeSessionId = existingSession.opencodeSessionId;

      // If the opencode session was deleted, clear it so we create a fresh one
      if (opencodeSessionId && !verifyOpencodeSession(opencodeSessionId)) {
        app.log.warn({ sessionId, opencodeSessionId }, "Opencode session not found — will create new one");
        opencodeSessionId = null;
      }

      await db
        .update(schema.sessions)
        .set({
          exitCode: null,
          exitReason: null,
          endedAt: null,
          durationMs: null,
          cwd: sessionCwd,
          branch: ticket.branch,
          createdAt: Date.now(), // bump for timeline sort
        })
        .where(eq(schema.sessions.id, sessionId));
    } else {
      // Create new session row
      sessionId = crypto.randomUUID();
      await db.insert(schema.sessions).values({
        id: sessionId,
        ticketId: input.ticketId,
        opencodeVersion: "latest",
        model: "unknown",
        cwd: sessionCwd,
        branch: ticket.branch,
        initialPrompt: ticket.description,
        opencodeSessionId: null,
        transcript: "[]",
        diff: "[]",
        filesChanged: "[]",
        exitCode: null,
        exitReason: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        createdAt: Date.now(),
        endedAt: null,
        durationMs: null,
        approved: null,
        revisionNote: null,
      });
    }

    // Update ticket status + active session
    await db
      .update(schema.tickets)
      .set({
        status: "in_progress",
        activeSessionId: sessionId,
        updatedAt: Date.now(),
      })
      .where(eq(schema.tickets.id, input.ticketId));

    // Emit SSE event
    emitSse({ type: "session.started", sessionId, ticketId: input.ticketId });

    // Start opencode serve for this session (one server per session for parallel isolation)
    let port: number;
    try {
      port = await startSessionServer(sessionId, sessionCwd);
      // Persist PID + port for orphan recovery
      const pid = getSessionPid(sessionId);
      if (pid) {
        await db
          .update(schema.sessions)
          .set({ pid, serverPort: port })
          .where(eq(schema.sessions.id, sessionId));
      }
    } catch (err) {
      app.log.error({ err, sessionId }, "Failed to start opencode server");
      await db
        .update(schema.sessions)
        .set({ exitCode: -1, exitReason: "error", endedAt: Date.now() })
        .where(eq(schema.sessions.id, sessionId));

      await db
        .update(schema.tickets)
        .set({ status: "open", activeSessionId: null, updatedAt: Date.now() })
        .where(eq(schema.tickets.id, input.ticketId));

      return reply.status(500).send({
        error: "SERVER_START_FAILED",
        message: "Could not start opencode server. Check that opencode is installed and in your PATH.",
      });
    }

    // Read model from opencode.json config
    const opencodeModel = readOpencodeModel();
    const modelStr = opencodeModel
      ? `${opencodeModel.providerID}/${opencodeModel.id}`
      : "unknown";

    // Update model on the session row (new sessions) or skip (reused sessions keep old model)
    if (!existingSession) {
      await db
        .update(schema.sessions)
        .set({ model: modelStr })
        .where(eq(schema.sessions.id, sessionId));
    }

    // Create or reuse opencode session ID (preserves conversation history)
    if (!opencodeSessionId) {
      try {
        opencodeSessionId = await createOpencodeSession(port, sessionCwd, ticket.title, opencodeModel);
      } catch (err) {
        app.log.warn({ err, sessionId }, "Could not create opencode session — messages won't persist");
      }
    }

    // Persist opencodeSessionId on the session row (may be the same as before)
    await db
      .update(schema.sessions)
      .set({ opencodeSessionId })
      .where(eq(schema.sessions.id, sessionId));

    // Check if improvement would be needed (client will call /improve separately)
    let forwardEnabled = false;
    if (!existingSession && opencodeSessionId && ticket.description) {
      const [settingsRow] = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.id, "global"));
      forwardEnabled = settingsRow?.forwardDescription ?? true;
    }

    return {
      id: sessionId,
      ticketId: input.ticketId,
      cwd: sessionCwd,
      branch: ticket.branch,
      opencodeSessionId,
      opencodePort: port,
      forwardEnabled,
    };
  });

  // Fire-and-forget prompt improvement (non-blocking — client polls /improving for status)
  app.post("/api/sessions/:id/improve", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));
    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });

    if (!session.ticketId)
      return reply.status(400).send({ error: "NO_TICKET", message: "Session has no associated ticket" });
    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, session.ticketId));
    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    if (!session.opencodeSessionId)
      return reply.status(400).send({ error: "NO_OPENCODE_SESSION", message: "Session has no opencode session" });

    const port = getSessionPort(id);
    if (!port)
      return reply.status(400).send({ error: "SESSION_NOT_RUNNING", message: "Session is not running" });

    if (!ticket.description)
      return { improving: false };

    improvingSessions.set(id, true);

    const onDone = () => {
      improvingSessions.set(id, false);
      emitSse({ type: "session.improving_done", sessionId: id, ticketId: session.ticketId });
    };

    generateAndSendImprovedPrompt(
      port,
      session.cwd,
      session.opencodeSessionId,
      ticket.description,
      onDone,
    ).catch(() => onDone());

    return { improving: true };
  });

  // Pollable status endpoint for prompt improvement
  app.get("/api/sessions/:id/improving", async (req, reply) => {
    const { id } = req.params as { id: string };
    return { improving: improvingSessions.get(id) ?? false };
  });

  // Send a message to an active session
  const sendMessageSchema = z.object({
    text: z.string().min(1, "Message text is required"),
  });

  app.post("/api/sessions/:id/send-message", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = sendMessageSchema.parse(req.body);

    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));

    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });

    if (!session.opencodeSessionId)
      return reply.status(400).send({ error: "NO_OPENCODE_SESSION", message: "Session has no opencode session" });

    let port = getSessionPort(id);
    if (!port) {
      port = await startSessionServer(id, session.cwd);
      // Persist PID + port for orphan recovery
      const pid = getSessionPid(id);
      if (pid) {
        await db
          .update(schema.sessions)
          .set({ pid, serverPort: port })
          .where(eq(schema.sessions.id, id));
      }
    }

    await sendToSession(port, session.cwd, session.opencodeSessionId, text);

    return { success: true };
  });

  // Get the current git branch for a session's repo
  app.get("/api/sessions/:id/branch", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));

    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });

    try {
      const branch = execSync(
        `git -C "${session.cwd}" symbolic-ref --short HEAD 2>/dev/null`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (!branch) throw new Error("Not on a branch");
      return { branch };
    } catch {
      return reply.status(500).send({ error: "GIT_FAILED", message: "Could not determine git branch" });
    }
  });

  // Stop session (marks ended, clears ticket.activeSessionId, does NOT kill opencode serve)
  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));
    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });

    await db
      .update(schema.sessions)
      .set({ exitCode: 0, exitReason: "user_stopped", endedAt: Date.now(), pid: null, serverPort: null })
      .where(eq(schema.sessions.id, id));

    // Clear ticket's activeSessionId so sidebar updates and auto-resume is clean
    if (session.ticketId) {
      await db
        .update(schema.tickets)
        .set({ activeSessionId: null, updatedAt: Date.now() })
        .where(eq(schema.tickets.id, session.ticketId));
    }

    // Kill the per-session opencode serve process (free port)
    stopSessionServer(id);

    emitSse({ type: "session.stopped", sessionId: id, ticketId: session.ticketId });

    return reply.status(204).send();
  });

}

/**
 * Create a session on the opencode server for message persistence.
 */
async function createOpencodeSession(
  port: number,
  repoPath: string,
  title?: string,
  model?: { providerID: string; id: string },
): Promise<string> {
  const url = `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(repoPath)}`;
  const body: Record<string, unknown> = {};
  if (title) body.title = title;
  if (model) body.model = model;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Failed to create opencode session: ${res.status} ${text.slice(0, 200)}`);
  }

  const session = await res.json() as { id: string };
  return session.id;
}

function deserializeSession(row: typeof schema.sessions.$inferSelect) {
  return {
    ...row,
    transcript: JSON.parse(row.transcript),
    diff: JSON.parse(row.diff),
    filesChanged: JSON.parse(row.filesChanged),
  };
}
