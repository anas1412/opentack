import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db";
import { stopSessionServer } from "../opencode-manager";

const WORKTREES_ROOT = path.join(
  process.env.HOME || "/home",
  "opentack-worktrees",
);

type Ticket = typeof schema.tickets.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;

/**
 * Create a git branch + worktree for a ticket. Throws on failure.
 * Returns the worktree path that was created.
 */
export async function createWorktreeForTicket(
  ticket: Ticket,
  repo: Repo,
  log?: Pick<FastifyInstance["log"], "warn" | "info">,
): Promise<string> {
  const branchName = ticket.branch;
  const repoDirName = repo.name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const slug = branchName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  const worktreePath = path.join(WORKTREES_ROOT, repoDirName, slug);

  mkdirSync(path.dirname(worktreePath), { recursive: true });

  // 1. Fetch latest base branch
  execSync(
    `git -C "${repo.localPath}" fetch origin "${ticket.baseBranch}" 2>/dev/null || true`,
    { timeout: 15000, stdio: "pipe" },
  );

  // 2. Create the branch from base branch (without switching to it)
  const branchExists = execSync(
    `git -C "${repo.localPath}" rev-parse --verify "${branchName}" 2>/dev/null || echo "no"`,
    { timeout: 5000, encoding: "utf-8" },
  ).trim();
  if (branchExists === "no") {
    execSync(
      `git -C "${repo.localPath}" branch "${branchName}" "origin/${ticket.baseBranch}" 2>/dev/null || git -C "${repo.localPath}" branch "${branchName}" "${ticket.baseBranch}"`,
      { timeout: 10000, stdio: "pipe" },
    );
  }

  // 3. Create the worktree
  execSync(
    `git -C "${repo.localPath}" worktree add "${worktreePath}" "${branchName}"`,
    { timeout: 15000, stdio: "pipe" },
  );

  // 4. Run bun install
  if (existsSync(path.join(worktreePath, "package.json"))) {
    try {
      execSync(`bun install --cwd "${worktreePath}" 2>&1`, {
        timeout: 120000,
        stdio: "pipe",
      });
    } catch (err) {
      log?.warn?.({ worktreePath }, "bun install failed in worktree — continuing");
    }
  }

  // 5. Save worktreePath on the ticket
  await db
    .update(schema.tickets)
    .set({ worktreePath, updatedAt: Date.now() })
    .where(eq(schema.tickets.id, ticket.id));

  log?.info?.({ ticketId: ticket.id, branchName, worktreePath }, "Worktree created");
  return worktreePath;
}

export function registerWorktreeRoutes(app: FastifyInstance) {
  // Create worktree for a ticket (manual, e.g. via curl)
  app.post("/api/worktrees", async (req, reply) => {
    const { ticketId } = z
      .object({ ticketId: z.string().uuid() })
      .parse(req.body);

    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId));
    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });
    if (ticket.worktreePath)
      return reply.status(409).send({ error: "ALREADY_EXISTS", message: "Worktree already exists for this ticket" });

    const [repo] = await db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, ticket.repoId));
    if (!repo)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });
    if (!existsSync(repo.localPath))
      return reply.status(400).send({ error: "PATH_NOT_FOUND", message: `Repo path does not exist: ${repo.localPath}` });

    try {
      const worktreePath = await createWorktreeForTicket(ticket, repo, app.log);
      return { worktreePath, branch: ticket.branch };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: "GIT_FAILED", message: msg });
    }
  });

  // List all worktrees (tickets with worktreePath set)
  app.get("/api/worktrees", async () => {
    const rows = await db
      .select()
      .from(schema.tickets)
      .where(isNotNull(schema.tickets.worktreePath))
      .orderBy(schema.tickets.updatedAt);

    const tickets = rows.map((r) => ({
      id: r.id,
      title: r.title,
      branch: r.branch,
      repoId: r.repoId,
      worktreePath: r.worktreePath,
      status: r.status,
      worktreeExists: r.worktreePath ? existsSync(r.worktreePath) : false,
    }));

    return tickets;
  });

  // Remove worktree for a ticket
  app.delete("/api/worktrees/:ticketId", async (req, reply) => {
    const { ticketId } = req.params as { ticketId: string };

    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId));
    if (!ticket)
      return reply.status(404).send({ error: "NOT_FOUND", message: "Ticket not found" });
    if (!ticket.worktreePath)
      return reply.status(404).send({ error: "NO_WORKTREE", message: "No worktree exists for this ticket" });

    await removeWorktreeForTicket(ticketId);
    return reply.status(204).send();
  });
}

/**
 * Remove the git worktree and branch for a ticket, then clear worktreePath.
 * Safe to call even if the ticket has no worktree (no-op).
 */
export async function removeWorktreeForTicket(ticketId: string): Promise<void> {
  const [ticket] = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId));
  if (!ticket || !ticket.worktreePath) return;

  // 1. Stop any active opencode session
  const [activeSession] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.ticketId, ticketId))
    .limit(1);
  if (activeSession) {
    stopSessionServer(activeSession.id);
    await db
      .update(schema.sessions)
      .set({ exitCode: 0, exitReason: "user_stopped", endedAt: Date.now() })
      .where(eq(schema.sessions.id, activeSession.id));
    await db
      .update(schema.tickets)
      .set({ activeSessionId: null, updatedAt: Date.now() })
      .where(eq(schema.tickets.id, ticketId));
  }

  // 2. Remove the git worktree
  const [repo] = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, ticket.repoId));

  if (repo && existsSync(repo.localPath)) {
    try {
      execSync(
        `git -C "${repo.localPath}" worktree remove "${ticket.worktreePath}" 2>/dev/null || rm -rf "${ticket.worktreePath}"`,
        { timeout: 15000, stdio: "pipe" },
      );
    } catch {
      try {
        execSync(
          `git -C "${repo.localPath}" worktree remove --force "${ticket.worktreePath}" 2>/dev/null; rm -rf "${ticket.worktreePath}"`,
          { timeout: 15000, stdio: "pipe" },
        );
      } catch {
        execSync(`rm -rf "${ticket.worktreePath}"`, { timeout: 10000 });
      }
    }

    // 3. Delete the branch
    try {
      execSync(
        `git -C "${repo.localPath}" branch -D "${ticket.branch}" 2>/dev/null || true`,
        { timeout: 10000, stdio: "pipe" },
      );
    } catch {}
  }

  // 4. Clear worktreePath on the ticket
  await db
    .update(schema.tickets)
    .set({ worktreePath: null, updatedAt: Date.now() })
    .where(eq(schema.tickets.id, ticketId));
}
