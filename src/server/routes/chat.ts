import type { FastifyInstance } from "fastify";
import { eq, isNull, and } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db";
import { startSessionServer, stopSessionServer, getSessionPort } from "../opencode-manager";
import { fetchOpencodeSessionCost } from "./cost-utils";
import { emitSse } from "../sse";

async function createOpencodeChatSession(
  port: number,
  repoPath: string,
  label: string,
): Promise<string> {
  const url = `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(repoPath)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: label }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Failed to create opencode chat session: ${res.status} ${text.slice(0, 200)}`);
  }
  const session = await res.json() as { id: string };
  return session.id;
}

export function registerChatRoutes(app: FastifyInstance) {
  // Create a chat session (no ticket, no worktree — just opencode in a repo)
  app.post("/api/chats", async (req, reply) => {
    const body = z.object({ repoId: z.string().uuid() }).parse(req.body);

    const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, body.repoId));
    if (!repo)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });

    const sessionId = crypto.randomUUID();

    // Start opencode serve in the repo directory
    let port: number;
    try {
      port = await startSessionServer(sessionId, repo.localPath);
    } catch {
      return reply.status(500).send({
        error: "SERVER_START_FAILED",
        message: "Could not start opencode server. Check that opencode is installed and in your PATH.",
      });
    }

    // Create an opencode session for messaging
    let opencodeSessionId: string;
    try {
      opencodeSessionId = await createOpencodeChatSession(port, repo.localPath, `Chat: ${repo.name}`);
    } catch (err) {
      stopSessionServer(sessionId);
      return reply.status(500).send({
        error: "SESSION_CREATE_FAILED",
        message: err instanceof Error ? err.message : "Could not create opencode session",
      });
    }

    // Insert session row (no ticketId — it's a chat)
    await db.insert(schema.sessions).values({
      id: sessionId,
      ticketId: null,
      opencodeVersion: "latest",
      model: "unknown",
      cwd: repo.localPath,
      branch: "",
      initialPrompt: "",
      opencodeSessionId,
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
      pid: null,
      serverPort: port,
      approved: null,
      revisionNote: null,
    });

    app.log.info({ sessionId, repo: repo.name }, "Chat session started");

    return {
      id: sessionId,
      opencodePort: port,
      cwd: repo.localPath,
      opencodeSessionId,
      repoName: repo.name,
    };
  });

  // List active chat sessions (only non-ended)
  app.get("/api/chats", async () => {
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(
        and(isNull(schema.sessions.ticketId), isNull(schema.sessions.endedAt)),
      )
      .orderBy(schema.sessions.createdAt);

    return rows.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      opencodeSessionId: row.opencodeSessionId,
      createdAt: row.createdAt,
    }));
  });

  // Get a single chat session
  app.get("/api/chats/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id));
    if (!row)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Chat not found" });

    return {
      id: row.id,
      cwd: row.cwd,
      serverPort: row.serverPort,
      opencodeSessionId: row.opencodeSessionId,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
    };
  });

  // Stop a chat session and record cost
  app.post("/api/chats/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id));
    if (!session)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Chat not found" });

    // Read cost from opencode DB before closing
    let costUsd = 0;
    let totalTokens = 0;
    if (session.opencodeSessionId) {
      const cost = fetchOpencodeSessionCost(session.opencodeSessionId);
      if (cost) {
        costUsd = cost.costUsd;
        totalTokens = cost.totalTokens;
      }
    }

    // Record in app_cost
    await db.insert(schema.appCost).values({
      id: crypto.randomUUID(),
      type: "chat",
      ticketId: null,
      costUsd,
      totalTokens,
      createdAt: Date.now(),
    });

    // Kill the opencode serve process
    stopSessionServer(id);

    // Mark session as ended
    await db
      .update(schema.sessions)
      .set({
        exitCode: 0,
        exitReason: "user_stopped",
        endedAt: Date.now(),
        costUsd,
        totalTokens,
        pid: null,
        serverPort: null,
      })
      .where(eq(schema.sessions.id, id));

    emitSse({ type: "session.stopped", sessionId: id, ticketId: null });

    return reply.status(204).send();
  });
}
