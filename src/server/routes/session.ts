import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { db, schema } from "../../db";
import { startServer } from "../opencode-manager";
import { emitSse } from "../sse";
import { enrichFromOpencode, getOpencodeDb, verifyOpencodeSession } from "./cost-utils";

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

async function sendDescriptionToOpencode(
  port: number,
  repoPath: string,
  opencodeSessionId: string,
  description: string,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${opencodeSessionId}/message?directory=${encodeURIComponent(repoPath)}`;
  const body = {
    noReply: false,
    parts: [{ type: "text" as const, text: description }],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      console.warn(`Failed to forward description to opencode: ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("Failed to forward description to opencode:", err);
  }
}

export function registerSessionRoutes(app: FastifyInstance) {
  // Recent sessions activity feed (across all repos)
  app.get("/api/sessions/recent", async (req) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      repoId: z.string().uuid().optional(),
    }).parse(req.query);

    // Build the query — join sessions with tickets (+ repos) for metadata
    const conditions = [];
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
        cwd: repo.localPath,
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

    // Start opencode serve for the repo (idempotent if already running)
    let port: number;
    try {
      port = await startServer(repo.localPath);
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
        opencodeSessionId = await createOpencodeSession(port, repo.localPath, ticket.title, opencodeModel);
      } catch (err) {
        app.log.warn({ err, sessionId }, "Could not create opencode session — messages won't persist");
      }
    }

    // Persist opencodeSessionId on the session row (may be the same as before)
    await db
      .update(schema.sessions)
      .set({ opencodeSessionId })
      .where(eq(schema.sessions.id, sessionId));

    // If this is a new session (not reuse), check if we should forward the description
    if (!existingSession && opencodeSessionId) {
      const [settingsRow] = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.id, "global"));

      const forwardEnabled = settingsRow?.forwardDescription ?? true;
      if (forwardEnabled && ticket.description) {
        // Fire-and-forget — don't block the response
        sendDescriptionToOpencode(port, repo.localPath, opencodeSessionId, ticket.description);
      }
    }

    return {
      id: sessionId,
      ticketId: input.ticketId,
      cwd: repo.localPath,
      branch: ticket.branch,
      opencodeSessionId,
      opencodePort: port,
    };
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
      .set({ exitCode: 0, exitReason: "user_stopped", endedAt: Date.now() })
      .where(eq(schema.sessions.id, id));

    // Clear ticket's activeSessionId so sidebar updates and auto-resume is clean
    await db
      .update(schema.tickets)
      .set({ activeSessionId: null, updatedAt: Date.now() })
      .where(eq(schema.tickets.id, session.ticketId));

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
