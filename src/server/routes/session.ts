import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { existsSync } from "fs";
import { db, schema } from "../../db";
import { startSessionServer, getSessionPort, getSessionPid } from "../opencode-manager";
import { emitSse } from "../sse";
import { createSdkClient, getGlobalConfig } from "../../shared/opencode-client";
import { getSingleSessionCost, enrichSessions } from "../../shared/opencode-db";
import { updateOpencodeSessionDirectory } from "./sqlite-helpers";
import { createWorktreeForTicket } from "./worktree";
import { sendToSession, generateAndSendImprovedPrompt } from "../../shared/prompt-improver";
import { createOpencodeSession } from "../../bun/opencode-session";
import { finalizeSessionCost, markSessionEnded, findOrCreateTicketSessionRow } from "../../shared/session-lifecycle";
import type { TicketSessionRowResult } from "../../shared/session-lifecycle";
import type { Session } from "../../shared/types";

// Track which sessions are currently improving prompts (for client polling)
const improvingSessions = new Map<string, boolean>();

const createSessionSchema = z.object({
  ticketId: z.string().uuid(),
});

// ─── Opencode config helpers ──────────────────────────────────────────

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

    return enrichSessions(rows);
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

    const deserialized = rows.map(deserializeSession);
    return enrichSessions(deserialized);
  });

  // Get session
  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id));
    if (!row)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });
    const s = deserializeSession(row) as Session;
    if (s.opencodeSessionId) {
      const c = getSingleSessionCost(s.opencodeSessionId);
      if (c) {
        s.costUsd = c.costUsd;
        s.totalTokens = c.totalTokens;
      }
    }
    return s;
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

    // Find or create session row + start opencode server
    let result: TicketSessionRowResult;
    try {
      result = await findOrCreateTicketSessionRow(ticket, sessionCwd);
    } catch (err) {
      app.log.error({ err, ticketId: input.ticketId }, "Failed to start opencode server");
      return reply.status(500).send({
        error: "SERVER_START_FAILED",
        message: "Could not start opencode server. Check that opencode is installed and in your PATH.",
      });
    }

    const { sessionId, opencodePort: port, opencodeSessionId: existingId, existingSession } = result;
    let opencodeSessionId = existingId;

    // Read model from opencode config via SDK
    let opencodeModel: { providerID: string; id: string } | undefined;
    try {
      const client = createSdkClient(port);
      const config = await getGlobalConfig(client);
      if (config.model) {
        const parts = config.model.split("/");
        opencodeModel = parts.length === 2
          ? { providerID: parts[0], id: parts[1] }
          : parts.length === 1
            ? { providerID: "", id: parts[0] }
            : undefined;
      }
    } catch { /* best-effort */ }
    const modelStr = opencodeModel
      ? `${opencodeModel.providerID}/${opencodeModel.id}`
      : "unknown";

    // Update model on new sessions only (reused sessions keep old model)
    if (!existingSession) {
      await db
        .update(schema.sessions)
        .set({ model: modelStr })
        .where(eq(schema.sessions.id, sessionId));
    }

    // Create opencode session if we don't have one
    if (!opencodeSessionId) {
      try {
        opencodeSessionId = await createOpencodeSession(port, sessionCwd, ticket.title, 1, opencodeModel);
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
      { onInjecting: onDone },
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

    try {
      await sendToSession(port, session.cwd, session.opencodeSessionId, text);
    } catch {
      // Session may have been removed from opencode's DB — create a replacement
      app.log.warn({ sessionId: id, opencodeSessionId: session.opencodeSessionId }, "send failed — creating replacement");
      const newId = await createOpencodeSession(port, session.cwd, session.ticketId || id, 1);
      await db
        .update(schema.sessions)
        .set({ opencodeSessionId: newId })
        .where(eq(schema.sessions.id, id));
      await sendToSession(port, session.cwd, newId, text);
    }

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

    const result = Bun.spawnSync(["git", "-C", session.cwd, "symbolic-ref", "--short", "HEAD"]);
    const branch = result.stdout.toString().trim();
    if (result.exitCode === 0 && branch) {
      return { branch };
    }
    return reply.status(500).send({ error: "GIT_FAILED", message: "Could not determine git branch" });
  });

  // Stop session (marks ended, clears ticket.activeSessionId, kills server)
  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));
    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Session not found" });

    finalizeSessionCost(session.opencodeSessionId);
    await markSessionEnded(id, session.ticketId, session.createdAt);

    return reply.status(204).send();
  });

}

function deserializeSession(row: typeof schema.sessions.$inferSelect) {
  return {
    ...row,
    transcript: JSON.parse(row.transcript),
    diff: JSON.parse(row.diff),
    filesChanged: JSON.parse(row.filesChanged),
  };
}
