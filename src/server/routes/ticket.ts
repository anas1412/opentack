import { execSync } from "child_process";
import { existsSync } from "fs";
import type { FastifyInstance } from "fastify";
import { eq, like, and, desc, sql, inArray } from "drizzle-orm";

import { db, schema } from "../../db";
import { ticketCreateSchema, ticketUpdateSchema, ticketListQuerySchema } from "../validators";
import {
  enrichFromOpencode,
  getOpencodeDb,
  updateOpencodeSessionTitle,
  deleteOpencodeSession,
  fetchOpencodeSessionCost,
} from "./cost-utils";
import { startSessionServer, stopSessionServer } from "../opencode-manager";
import { removeWorktreeForTicket } from "./worktree";
import { emitSse } from "../sse";
import { z } from "zod";

export function registerTicketRoutes(app: FastifyInstance) {
  // Create ticket
  app.post("/api/tickets", async (req, reply) => {
    const input = ticketCreateSchema.parse(req.body);
    const id = crypto.randomUUID();

    // Look up repo to derive baseBranch
    const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, input.repoId));
    const baseBranch = input.baseBranch ?? repo?.defaultBranch ?? "main";

    // Generate display branch name from title + category (no git ops performed)
    const prefixMap: Record<string, string> = {
      feature: "feat",
      bug: "fix",
      refactor: "refactor",
      chore: "chore",
      docs: "docs",
    };
    const prefix = prefixMap[input.category] ?? "feat";
    const slug = input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const branch = `${prefix}/${slug}-${id.slice(0, 8)}`;

    const ticket = {
      id,
      title: input.title,
      description: input.description,
      status: "open" as const,
      priority: input.priority,
      category: input.category,
      repoId: input.repoId,
      branch,
      baseBranch,
      sessionIds: "[]",
      activeSessionId: null,
      filesChanged: "[]",
      totalCostUsd: 0,
      totalTokens: 0,
      tags: JSON.stringify(input.tags),
      notes: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      worktreePath: null,
      resolvedAt: null,
    };

    await db.insert(schema.tickets).values(ticket);
    emitSse({ type: "ticket.created", ticketId: id });
    return deserializeTicket(ticket);
  });

  // List tickets
  app.get("/api/tickets", async (req) => {
    const query = ticketListQuerySchema.parse(req.query);

    const conditions = [];
    if (query.status) conditions.push(eq(schema.tickets.status, query.status));
    if (query.priority) conditions.push(eq(schema.tickets.priority, query.priority));
    if (query.repoId) conditions.push(eq(schema.tickets.repoId, query.repoId));
    if (query.category) conditions.push(eq(schema.tickets.category, query.category));
    if (query.search) conditions.push(like(schema.tickets.title, `%${query.search}%`));

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(schema.tickets)
      .where(where)
      .orderBy(desc(schema.tickets.updatedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.tickets)
      .where(where);

    // Enrich costs from opencode — batch by looking up all sessions at once
    const tickets = rows.map(deserializeTicket);
    const ticketIds = tickets.map((t) => t.id);
    if (ticketIds.length > 0) {
      const allSessions = await db
        .select()
        .from(schema.sessions)
        .where(sql`${schema.sessions.ticketId} IN (${ticketIds.join(",")})`);

      // Batch look up opencode session costs
      const ocSessionIds = allSessions.map((s) => s.opencodeSessionId).filter(Boolean) as string[];
      const ocCostMap = new Map<string, { cost: number; tokens: number }>();
      if (ocSessionIds.length > 0) {
        const ocDb = getOpencodeDb();
        if (ocDb) {
          try {
            const placeholders = ocSessionIds.map(() => "?").join(",");
            const rows = ocDb
              .query(
                `SELECT id, cost, tokens_input + tokens_output as tokens
                 FROM session WHERE id IN (${placeholders})`,
              )
              .all(...ocSessionIds) as { id: string; cost: number; tokens: number }[];
            for (const r of rows) ocCostMap.set(r.id, { cost: r.cost, tokens: r.tokens });
            ocDb.close();
          } catch {
            ocDb.close();
          }
        }
      }

      // Sum costs per ticket (skip chat sessions with no ticketId)
      const costByTicket = new Map<string, { costUsd: number; totalTokens: number }>();
      for (const s of allSessions) {
        if (!s.ticketId) continue;
        const oc = s.opencodeSessionId ? ocCostMap.get(s.opencodeSessionId) : null;
        const costUsd = oc?.cost ?? s.costUsd;
        const totalTokens = oc?.tokens ?? s.totalTokens;
        const existing = costByTicket.get(s.ticketId) ?? { costUsd: 0, totalTokens: 0 };
        existing.costUsd += costUsd;
        existing.totalTokens += totalTokens;
        costByTicket.set(s.ticketId, existing);
      }

      for (const t of tickets) {
        const c = costByTicket.get(t.id);
        if (c) {
          t.totalCostUsd = c.costUsd;
          t.totalTokens = c.totalTokens;
        }
      }
    }

    return {
      tickets,
      total: count,
      limit: query.limit,
      offset: query.offset,
    };
  });

  // Get ticket (with real costs from opencode + live files from git)
  app.get("/api/tickets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
    if (!row) return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    // Enrich cost from opencode by summing all sessions
    const sessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.ticketId, id));

    let realCost = 0;
    let realTokens = 0;
    for (const s of sessions) {
      const enriched = enrichFromOpencode(s.opencodeSessionId, { costUsd: s.costUsd, totalTokens: s.totalTokens });
      realCost += enriched.costUsd;
      realTokens += enriched.totalTokens;
    }

    const ticket = deserializeTicket(row);

    // Compute files changed live from git diff
    const liveFiles = await computeChangedFiles(row);

    return { ...ticket, totalCostUsd: realCost, totalTokens: realTokens, filesChanged: liveFiles };
  });

  // Update ticket
  app.put("/api/tickets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = ticketUpdateSchema.parse(req.body);

    const existing = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
    if (!existing.length)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.status !== undefined) update.status = input.status;
    if (input.priority !== undefined) update.priority = input.priority;
    if (input.category !== undefined) update.category = input.category;
    if (input.notes !== undefined) update.notes = input.notes;
    if (input.tags !== undefined) update.tags = JSON.stringify(input.tags);

    if (input.status === "resolved") update.resolvedAt = Date.now();

    await db.update(schema.tickets).set(update).where(eq(schema.tickets.id, id));

    // Clean up worktree + branch when ticket is resolved or closed
    if (input.status === "resolved" || input.status === "closed") {
      const existingRows = existing[0];
      if (existingRows.worktreePath) {
        removeWorktreeForTicket(id).catch(() => {});
      }
    }

    // Rename any associated opencode sessions to match the new ticket title
    if (input.title !== undefined) {
      const ticketSessions = await db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.ticketId, id),
            sql`${schema.sessions.opencodeSessionId} IS NOT NULL`,
          ),
        );
      for (const s of ticketSessions) {
        updateOpencodeSessionTitle(s.opencodeSessionId, input.title);
      }
    }

    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
    emitSse({ type: "ticket.updated", ticketId: id });
    return deserializeTicket(row!);
  });

  // Delete ticket
  app.delete("/api/tickets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    // Delete associated sessions + their opencode sessions
    const ticketSessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.ticketId, id));
    for (const s of ticketSessions) {
      deleteOpencodeSession(s.opencodeSessionId);
    }
    await db.delete(schema.sessions).where(eq(schema.sessions.ticketId, id));

    await db.delete(schema.tickets).where(eq(schema.tickets.id, id));
    emitSse({ type: "ticket.deleted", ticketId: id });
    return reply.status(204).send();
  });

  // Generate notes from session data using opencode
  app.post("/api/tickets/:id/generate-notes", async (req, reply) => {
    const { id } = req.params as { id: string };

    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });

    // Find the latest session for this ticket (must have an opencode session attached)
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.ticketId, id),
          sql`${schema.sessions.opencodeSessionId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(schema.sessions.createdAt))
      .limit(1);

    if (!session)
      return reply.status(400).send({
        error: "NO_SESSION",
        message: "No session found for this ticket. Start a session first.",
      });

    const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, ticket.repoId));
    if (!repo)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });

    const notesSessionId = `notes-${crypto.randomUUID()}`;
    let port: number;
    try {
      port = await startSessionServer(notesSessionId, repo.localPath);
    } catch {
      return reply.status(500).send({
        error: "SERVER_START_FAILED",
        message: "Could not start opencode server to generate notes.",
      });
    }

    try {
    // Get the opencode session messages to build a transcript
    if (!session.opencodeSessionId) {
      return reply.status(400).send({
        error: "NO_OPENCODE_SESSION",
        message: "This session has no opencode session attached. The session may not have been started properly.",
      });
    }

    // Fetch the actual messages from the opencode session
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/session/${session.opencodeSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
    );
    if (!msgRes.ok) {
      return reply.status(502).send({
        error: "FETCH_FAILED",
        message: "Failed to read opencode session messages.",
      });
    }

    type MainMessage = {
      info: { role: string };
      parts: Array<{ type: string; text?: string }>;
    };
    const mainMessages = await msgRes.json() as MainMessage[];

    // Build transcript text from user + assistant exchanges
    const transcriptText = (Array.isArray(mainMessages) ? mainMessages : [])
      .filter((m) => m.info?.role === "user" || m.info?.role === "assistant")
      .map((m) => {
        const text = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ");
        return `[${m.info.role}]: ${text}`;
      })
      .join("\n\n")
      .slice(0, 30_000); // keep under token limit

    const prompt = `Based ONLY on the session transcript below, write a brief summary (2-3 bullet points) of what was accomplished in this session.

Rules:
- Use ONLY the transcript below. Do NOT scan the repo, check git history, or reference anything outside this transcript.
- Output in markdown bullet points.
- Be specific about what was actually done (files changed, features added, bugs fixed).

Ticket: ${ticket.title}
Description: ${ticket.description.slice(0, 300)}

<transcript>
${transcriptText}
</transcript>`;

    try {
      // 1. Create a temporary session for summarization
      const createRes = await fetch(
        `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(repo.localPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "summarize" }),
        },
      );
      if (!createRes.ok) throw new Error("Failed to create temp session");
      const { id: tempSessionId } = await createRes.json() as { id: string };

      // 2. Send the summarization prompt to the temp session
      const msgRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: prompt }],
          }),
        },
      );
      if (!msgRes.ok) throw new Error("Failed to send prompt to temp session");

      // 3. Wait for AI to finish
      await fetch(
        `http://127.0.0.1:${port}/api/session/${tempSessionId}/wait`,
        { method: "POST" },
      );

      // 4. Read the AI response messages
      const msgListRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
      );
      type MessageResponse = Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
      const messages = await msgListRes.json() as MessageResponse;

      // Extract text only from assistant messages
      let notes = (Array.isArray(messages) ? messages : [])
        .filter((m) => m.info?.role === "assistant")
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n");

      // 5. Save app-level cost before deleting
      try {
        const cost = fetchOpencodeSessionCost(tempSessionId);
        if (cost) {
          await db.insert(schema.appCost).values({
            id: crypto.randomUUID(),
            type: "generate_notes",
            ticketId: id,
            costUsd: cost.costUsd,
            totalTokens: cost.totalTokens,
            createdAt: Date.now(),
          });
        }
      } catch { /* best-effort */ }

      // 6. Clean up — delete temp session
      fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}?directory=${encodeURIComponent(repo.localPath)}`,
        { method: "DELETE" },
      ).catch(() => {}); // fire-and-forget cleanup

      if (!notes) notes = "Session notes generated.";

      // Save to ticket
      await db
        .update(schema.tickets)
        .set({ notes, updatedAt: Date.now() })
        .where(eq(schema.tickets.id, id));

      return { notes };
    } catch (err) {
      return reply.status(502).send({
        error: "GENERATE_FAILED",
        message: err instanceof Error ? err.message : "Failed to generate notes",
      });
    }
    } finally {
      stopSessionServer(notesSessionId);
    }
  });

  // ── Batch operations ──

  // Batch update — change status/priority/category on multiple tickets
  app.post("/api/tickets/batch/update", async (req, reply) => {
    const body = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      input: ticketUpdateSchema,
    }).parse(req.body);

    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (body.input.status !== undefined) update.status = body.input.status;
    if (body.input.priority !== undefined) update.priority = body.input.priority;
    if (body.input.category !== undefined) update.category = body.input.category;
    if (body.input.notes !== undefined) update.notes = body.input.notes;
    if (body.input.tags !== undefined) update.tags = JSON.stringify(body.input.tags);
    if (body.input.status === "resolved") update.resolvedAt = Date.now();

    await db.update(schema.tickets).set(update).where(inArray(schema.tickets.id, body.ids));
    for (const id of body.ids) emitSse({ type: "ticket.updated", ticketId: id });
    return reply.status(204).send();
  });

  // Batch delete
  app.post("/api/tickets/batch/delete", async (req, reply) => {
    const body = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    }).parse(req.body);

    // Delete associated sessions + their opencode sessions for all tickets
    const ticketSessions = await db
      .select()
      .from(schema.sessions)
      .where(inArray(schema.sessions.ticketId, body.ids));
    for (const s of ticketSessions) {
      deleteOpencodeSession(s.opencodeSessionId);
    }
    await db.delete(schema.sessions).where(inArray(schema.sessions.ticketId, body.ids));
    await db.delete(schema.tickets).where(inArray(schema.tickets.id, body.ids));
    for (const id of body.ids) emitSse({ type: "ticket.deleted", ticketId: id });
    return reply.status(204).send();
  });
}

function deserializeTicket(row: typeof schema.tickets.$inferSelect) {
  return {
    ...row,
    sessionIds: JSON.parse(row.sessionIds),
    filesChanged: JSON.parse(row.filesChanged),
    tags: JSON.parse(row.tags),
    activeSessionId: row.activeSessionId,
    resolvedAt: row.resolvedAt,
  };
}

/**
 * Compute changed files by checking git in the worktree (or main repo).
 * Checks three sources: branch diff, unstaged changes, staged changes.
 */
async function computeChangedFiles(row: typeof schema.tickets.$inferSelect): Promise<string[]> {
  if (!row.branch) return [];

  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, row.repoId));
  if (!repo || !existsSync(repo.localPath)) return [];

  // Use the worktree path if it exists — the branch is checked out there,
  // and that's where opencode actually makes changes.
  const gitDir = row.worktreePath && existsSync(row.worktreePath) ? row.worktreePath : repo.localPath;
  const baseBranch = row.baseBranch || repo.defaultBranch || "main";
  const files = new Set<string>();

  // 1. Committed changes unique to the branch
  try {
    const out = execSync(
      `git -C "${gitDir}" diff --name-only "${baseBranch}...${row.branch}" 2>/dev/null || true`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (out) out.split("\n").filter(Boolean).forEach((f) => files.add(f));
  } catch {
    // branch may not exist yet
  }

  // 2. Unstaged changes (files opencode is actively editing)
  try {
    const out = execSync(
      `git -C "${gitDir}" diff --name-only 2>/dev/null || true`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (out) out.split("\n").filter(Boolean).forEach((f) => files.add(f));
  } catch {
    // ignore
  }

  // 3. Staged but not committed changes
  try {
    const out = execSync(
      `git -C "${gitDir}" diff --cached --name-only 2>/dev/null || true`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (out) out.split("\n").filter(Boolean).forEach((f) => files.add(f));
  } catch {
    // ignore
  }

  return Array.from(files);
}
