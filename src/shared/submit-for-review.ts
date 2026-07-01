/**
 * Shared submit-for-review logic — used by both Fastify routes and bun handlers.
 *
 * Flow:
 * 1. Load ticket + repo, determine git work dir
 * 2. Stop active session
 * 3. Check for uncommitted/branch changes
 * 4. Generate commit message via opencode SDK (if possible)
 * 5. git add + commit + push
 * 6. gh pr create
 * 7. Update ticket status to needs_review
 * 8. Emit SSE events
 */
import { existsSync } from "fs";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { runGh } from "./gh-runner";
import { createSdkClient } from "./opencode-client";
import { finalizeSessionCost, markSessionEnded } from "./session-lifecycle";
import { getAnyActivePort } from "../server/opencode-manager";
import { emitSse } from "../server/sse";

export interface SubmitForReviewResult {
  prUrl: string | null;
  commitHash: string | null;
}

/**
 * Submit a ticket for review:
 * - Stops the active session
 * - Commits + pushes any uncommitted changes
 * - Creates a GitHub PR
 * - Updates ticket status to needs_review
 */
export async function submitForReview(ticketId: string): Promise<SubmitForReviewResult> {
  // 1. Load ticket + repo
  const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (!ticket) throw new Error("Ticket not found");

  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, ticket.repoId));
  if (!repo) throw new Error("Repo not found");

  const gitDir =
    ticket.worktreePath && existsSync(ticket.worktreePath)
      ? ticket.worktreePath
      : repo.localPath;

  const baseBranch = ticket.baseBranch || repo.defaultBranch || "main";
  const branch = ticket.branch;
  const remote = (await getDefaultRemote()) || "origin";

  // 2. Capture active session ID before stopping it
  const oldSessionId = ticket.activeSessionId;

  // 3. Generate commit message from diff (BEFORE stopping session so server is available)
  const diffForMessage = getDiff(gitDir, baseBranch, remote, branch);
  let commitMsg: string | null = null;
  const hasUncommitted = hasUncommittedChanges(gitDir);

  if (diffForMessage || hasUncommitted) {
    commitMsg = await generateCommitMessage(gitDir, diffForMessage, ticket.title);
  }

  // 4. Stop the active session (if any)
  if (oldSessionId) {
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, oldSessionId))
      .limit(1);
    if (session) {
      finalizeSessionCost(session.opencodeSessionId);
      await markSessionEnded(oldSessionId, ticketId, ticket.createdAt);
    }
  }

  // 5. Git operations
  let commitHash: string | null = null;

  if (hasUncommitted || commitMsg) {
    // Add everything
    execGit(gitDir, ["add", "-A"]);

    // Commit — use generated message or ticket title
    const msg = commitMsg || ticket.title;
    const commitResult = execGit(gitDir, ["commit", "-m", msg]);
    if (commitResult.exitCode === 0) {
      commitHash = commitResult.stdout.trim();
      // Extract short hash from "\[main 123abc\] ..."
      const hashMatch = commitResult.stdout.match(/\b([0-9a-f]{7,40})\b/);
      if (hashMatch) commitHash = hashMatch[1];
    }

    // Push
    execGit(gitDir, ["push", remote, branch]);
  } else {
    // No uncommitted changes — still push any existing commits
    execGit(gitDir, ["push", remote, branch]);
  }

  // 6. Create PR via gh
  let prUrl: string | null = null;
  try {
    const prBody = ticket.description
      ? ticket.description.slice(0, 5000)
      : `Automated PR for ticket: ${ticket.title}`;

    const prResult = await runGh({
      args: [
        "pr", "create",
        "--title", ticket.title,
        "--body", prBody,
        "--base", baseBranch,
        "--head", branch,
      ],
      cwd: gitDir,
    });

    if (prResult.exitCode === 0 && prResult.stdout) {
      prUrl = prResult.stdout.trim();
    } else if (prResult.stderr) {
      console.warn(`[submit-for-review] gh pr create stderr: ${prResult.stderr}`);
      // Try parsing URL from stderr (gh sometimes outputs to stderr)
      const urlMatch = prResult.stderr.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (urlMatch) prUrl = urlMatch[0];
    }
  } catch (err) {
    console.error("[submit-for-review] gh pr create failed:", err);
  }

  // 7. Update ticket status
  await db
    .update(schema.tickets)
    .set({ status: "needs_review", updatedAt: Date.now() })
    .where(eq(schema.tickets.id, ticketId));

  // 8. Emit SSE events
  emitSse({ type: "ticket.updated", ticketId });
  if (prUrl) {
    emitSse({
      type: "pr.created",
      sessionId: oldSessionId || "",
      ticketId,
      prUrl,
    });
  }

  return { prUrl, commitHash };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hasUncommittedChanges(cwd: string): boolean {
  // Check both unstaged and staged changes
  const unstaged = Bun.spawnSync(["git", "diff", "--quiet"], { cwd });
  const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd });
  return unstaged.exitCode !== 0 || staged.exitCode !== 0;
}

/**
 * Get diff against the remote base branch for commit message generation.
 * Returns empty string if branch has no remote tracking yet.
 */
function getDiff(cwd: string, baseBranch: string, remote: string, branch: string): string {
  // Try remote-base diff first
  const diffResult = Bun.spawnSync(
    ["git", "diff", `${remote}/${baseBranch}...${branch}`, "--diff-filter=ACDMR"],
    { cwd },
  );
  if (diffResult.exitCode === 0 && diffResult.stdout.toString().trim()) {
    return diffResult.stdout.toString().trim();
  }

  // Fallback: try merging with local base
  const localDiff = Bun.spawnSync(
    ["git", "diff", baseBranch, "--diff-filter=ACDMR"],
    { cwd },
  );
  if (localDiff.exitCode === 0) {
    return localDiff.stdout.toString().trim();
  }

  // Last resort: just show the working tree diff
  const workingDiff = Bun.spawnSync(["git", "diff"], { cwd });
  if (workingDiff.exitCode === 0) {
    return workingDiff.stdout.toString().trim();
  }

  return "";
}

/**
 * Generate a commit message from the diff using opencode SDK if possible.
 * Falls back to ticket title if no active server or SDK call fails.
 */
async function generateCommitMessage(
  cwd: string,
  diff: string,
  ticketTitle: string,
): Promise<string | null> {
  if (!diff) return ticketTitle;

  // Try SDK via any active opencode server
  const port = await getAnyActivePort();
  if (port) {
    try {
      const client = createSdkClient(port);

      // Create temp session for commit message generation
      const createResult = await client.session.create({
        directory: cwd,
        title: "commit-msg-gen",
      });
      const tempSessionId = ((createResult.data as any)?.id ?? (createResult as any).id) as string;
      if (tempSessionId) {
        const truncatedDiff = diff.slice(0, 8000);
        const prompt = [
          "Write a concise git commit message for these changes.",
          "",
          "Format:",
          "- First line: short summary (max 72 chars)",
          "- Blank line",
          "- Bullet list of key changes (3-6 items, each under 80 chars)",
          "",
          "Output ONLY the commit message. No preamble, no commentary.",
          "",
          "Changes:",
          truncatedDiff,
        ].join("\n");

        try {
          await client.session.prompt({
            sessionID: tempSessionId,
            directory: cwd,
            parts: [{ type: "text", text: prompt }],
          });

          const msgResult = await client.session.messages({ sessionID: tempSessionId });
          const messages = Array.isArray(msgResult.data) ? msgResult.data : [];
          const assistantText = (messages as any[])
            .filter((m: any) => m.info?.role === "assistant")
            .flatMap((m: any) => m.parts ?? [])
            .filter((p: any) => p.type === "text" && p.text)
            .map((p: any) => p.text!.trim())
            .filter(Boolean)
            .join("\n");

          if (assistantText) return assistantText;
        } catch {
          // Fall through to ticket title
        }
      }
    } catch {
      // Fall through to ticket title
    }
  }

  // Fallback: use ticket title
  return ticketTitle;
}

/**
 * Run a git command and return result.
 */
function execGit(
  cwd: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/**
 * Get the default remote name from settings or fall back to "origin".
 */
async function getDefaultRemote(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, "global"))
    .limit(1);
  return row?.defaultRemote ?? null;
}
