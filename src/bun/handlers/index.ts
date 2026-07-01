import { db, schema } from "../../db"
import { eq, and, or, isNull, isNotNull, like, sql, inArray, desc, gt, gte, lte } from "drizzle-orm"
import { randomUUID } from "crypto"
import { execSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync } from "fs"
import { homedir, tmpdir } from "os"
import {
  getOpencodeConfigDir,
  getOpencodeConfigPath,
  getOpencodeTuiPath,
  getOpencodeDataAgentsDir,
  getOpenTackDataDir,
  getOpenTackReposDir,
  getOpenTackWorktreesDir,
} from "../../paths"
import path from "path"
import { z } from "zod"
import { encryptToken } from "../../shared/gh-runner"

import type {
  Ticket,
  TicketCreateInput,
  TicketUpdateInput,
  Repo,
  RepoCreateInput,
  RepoUpdateInput,
  Session,
  Settings,
  SettingsUpdateInput,
  CostSummary,
  OpencodeConfig,
  OpencodeTuiConfig,
  AgentEntry,
  JournalResponse,
  CheckUpdatesResponse,
  DownloadUpdateResponse,
} from "../../shared/types"

import { createOpencodeSession, parseModel, type OpencodeModel } from "../opencode-session"

import {
  ticketCreateSchema,
  ticketUpdateSchema,
  ticketListQuerySchema,
  repoCreateSchema,
  repoUpdateSchema,
  settingsUpdateSchema,
  opencodeConfigUpdateSchema,
} from "../../server/validators"

import {
  startSessionServer,
  stopSessionServer,
  stopAll,
  getSessionPort,
  getSessionPid,
  isSessionAlive,
  registerRecoveredSession,
  getAnyActivePort,
} from "../../server/opencode-manager"

import { updateOpencodeSessionDirectory } from "../../server/routes/sqlite-helpers"
import { createSdkClient, getGlobalConfig } from "../../shared/opencode-client"
import { dailyCostHistory, aggregateOpencodeSessionsSince, getSingleSessionCost, queryOpencodeSessionsSince, enrichSessions, normalizeModel } from "../../shared/opencode-db"
import { sendToSession, generateAndSendImprovedPrompt } from "../../shared/prompt-improver"
import { finalizeSessionCost, markSessionEnded, findOrCreateTicketSessionRow } from "../../shared/session-lifecycle"
import { createWorktreeForTicket } from "../../server/routes/worktree"
import { computeChangedFiles } from "../../server/routes/ticket"
import { emitSse } from "../../server/sse"

// ─── JSON Field Helpers ────────────────────────────────────────────────
// Drizzle + bun:sqlite stores JSON fields as TEXT; these helpers convert.

function parseJsonField<T>(val: unknown, fallback: T): T {
  if (typeof val === "string") {
    try { return JSON.parse(val) as T } catch { return fallback }
  }
  return val as T
}

function toJsonField(val: unknown): string {
  return JSON.stringify(val)
}

// ─── Helpers ───────────────────────────────────────────────────────────

const OPENCONFIG_DIR = getOpencodeConfigDir()
const OPENCONFIG_PATH = getOpencodeConfigPath()
const TUI_CONFIG_PATH = getOpencodeTuiPath()
const OPENTACK_DIR = getOpenTackDataDir()
const OPENTACK_REPOS_DIR = getOpenTackReposDir()

function getOpenTackDb() {
  return db
}

function generateId(): string {
  return randomUUID()
}

async function getSettingsRow(): Promise<{
  forwardDescription: boolean;
  theme: string | null;
  model: string;
  ghPath: string | null;
  ghToken: string | null;
  defaultRemote: string | null;
} | undefined> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, "global")).limit(1)
  return rows[0]
}

// ─── Health ────────────────────────────────────────────────────────────

export async function health() {
  return { status: "ok", version: "0.1.0" }
}

// ─── Repos ─────────────────────────────────────────────────────────────

export async function listRepos(): Promise<Repo[]> {
  const rows = await db.select().from(schema.repos).orderBy(desc(schema.repos.lastUsedAt))
  return rows.map((r) => ({ ...r, envVars: parseJsonField<Record<string, string>>(r.envVars, {}) })) as Repo[]
}

export async function getRepo(params: { id: string }): Promise<Repo> {
  const row = await db.select().from(schema.repos).where(eq(schema.repos.id, params.id)).limit(1)
  if (!row[0]) throw new Error("Repo not found")
  return { ...row[0], envVars: parseJsonField<Record<string, string>>(row[0].envVars, {}) } as Repo
}

export async function createRepo(input: RepoCreateInput): Promise<Repo> {
  const data = repoCreateSchema.parse(input)
  let localPath = data.localPath

  // Auto-discover path if not provided
  if (!localPath) {
    const findResult = Bun.spawnSync(["find", homedir(), "-maxdepth", "4", "-type", "d", "-name", data.name])
    const found = findResult.stdout.toString().trim().split("\n")[0]
    if (found) localPath = found
  }

  // Verify git repo
  try {
    execSync("git rev-parse --git-dir", { cwd: localPath, encoding: "utf-8", timeout: 5000 })
  } catch {
    throw new Error(`Not a git repository: ${localPath}`)
  }

  // Auto-detect default branch
  let defaultBranch = data.defaultBranch
  if (!defaultBranch) {
    try {
      defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: localPath,
        encoding: "utf-8",
        timeout: 5000,
      }).trim()
    } catch {
      defaultBranch = "main"
    }
  }

  const id = generateId()
  const now = Date.now()
  await db.insert(schema.repos).values({
    id,
    name: data.name,
    localPath,
    defaultBranch,
    envVars: toJsonField(data.envVars || {}),
    createdAt: now,
    lastUsedAt: null,
  })

  const created = await db.select().from(schema.repos).where(eq(schema.repos.id, id)).limit(1)
  return { ...created[0], envVars: parseJsonField<Record<string, string>>(created[0].envVars, {}) } as Repo
}

export async function updateRepo(params: { id: string } & RepoUpdateInput): Promise<Repo> {
  const data = repoUpdateSchema.parse(params)
  const existing = await db.select().from(schema.repos).where(eq(schema.repos.id, params.id)).limit(1)
  if (!existing[0]) throw new Error("Repo not found")

  const updates: Record<string, unknown> = {}
  if (data.name !== undefined) updates.name = data.name
  if (data.localPath !== undefined) updates.localPath = data.localPath
  if (data.defaultBranch !== undefined) updates.defaultBranch = data.defaultBranch
  if (data.envVars !== undefined) updates.envVars = toJsonField(data.envVars)

  await db.update(schema.repos).set(updates).where(eq(schema.repos.id, params.id))
  const updated = await db.select().from(schema.repos).where(eq(schema.repos.id, params.id)).limit(1)
  return { ...updated[0], envVars: parseJsonField<Record<string, string>>(updated[0].envVars, {}) } as Repo
}

export async function deleteRepo(params: { id: string }): Promise<void> {
  await db.delete(schema.repos).where(eq(schema.repos.id, params.id))
}

export async function cloneRepo(params: { gitUrl: string; name?: string }): Promise<Repo> {
  const url = new URL(params.gitUrl)
  const repoName = params.name || path.basename(url.pathname, ".git")
  const dest = `${OPENTACK_REPOS_DIR}/${repoName}`

  if (existsSync(dest)) throw new Error("Repo already exists at " + dest)

  mkdirSync(OPENTACK_REPOS_DIR, { recursive: true })

  try {
    execSync(`git clone "${params.gitUrl}" "${dest}"`, {
      stdio: "pipe",
      timeout: 120000,
    })
  } catch (e: any) {
    const msg = e.stderr?.toString() || e.message
    if (msg.includes("Authentication failed") || msg.includes("Permission denied")) {
      throw new Error("Authentication failed. Make sure your SSH key is added or use a repo in your local filesystem.")
    }
    throw new Error("Clone failed: " + msg)
  }

  let branch = "main"
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dest, timeout: 5000 }).toString().trim()
  } catch {}

  const id = generateId()
  await db.insert(schema.repos).values({
    id,
    name: repoName,
    localPath: dest,
    defaultBranch: branch,
    envVars: toJsonField({}),
    createdAt: Date.now(),
    lastUsedAt: null,
  })

  const created = await db.select().from(schema.repos).where(eq(schema.repos.id, id)).limit(1)
  return { ...created[0], envVars: parseJsonField<Record<string, string>>(created[0].envVars, {}) } as Repo
}

// ─── Tickets ───────────────────────────────────────────────────────────

export async function listTickets(params: {
  status?: string
  priority?: string
  repoId?: string
  category?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<{ tickets: Ticket[]; total: number; limit: number; offset: number }> {
  const q = ticketListQuerySchema.parse(params)
  const conditions: ReturnType<typeof eq>[] = []

  if (q.status) conditions.push(eq(schema.tickets.status, q.status))
  if (q.priority) conditions.push(eq(schema.tickets.priority, q.priority))
  if (q.repoId) conditions.push(eq(schema.tickets.repoId, q.repoId))
  if (q.category) conditions.push(eq(schema.tickets.category, q.category))
  if (q.search) conditions.push(like(schema.tickets.title, `%${q.search}%`))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [rowCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(where)

  const rows = await db
    .select()
    .from(schema.tickets)
    .where(where)
    .orderBy(desc(schema.tickets.updatedAt))
    .limit(q.limit)
    .offset(q.offset)

  const tickets = rows.map((r) => ({
    ...r,
    sessionIds: parseJsonField<string[]>(r.sessionIds, []),
    filesChanged: parseJsonField<string[]>(r.filesChanged, []),
    tags: parseJsonField<string[]>(r.tags, []),
  })) as Ticket[]

  // Enrich costs from opencode DB — batch look up all session IDs at once
  const ticketIds = tickets.map((t) => t.id)
  if (ticketIds.length > 0) {
    const allSessions = await db
      .select()
      .from(schema.sessions)
      .where(inArray(schema.sessions.ticketId, ticketIds))

    const ocSessionIds = allSessions.map((s) => s.opencodeSessionId).filter(Boolean) as string[]
    const enriched = enrichSessions(allSessions)

    // Sum costs per ticket (skip chat sessions with no ticketId)
    const costByTicket = new Map<string, { costUsd: number; totalTokens: number }>()
    for (const s of enriched) {
      if (!s.ticketId) continue
      const existing = costByTicket.get(s.ticketId) ?? { costUsd: 0, totalTokens: 0 }
      existing.costUsd += s.costUsd
      existing.totalTokens += s.totalTokens
      costByTicket.set(s.ticketId, existing)
    }

    for (const t of tickets) {
      const c = costByTicket.get(t.id)
      if (c) {
        t.totalCostUsd = c.costUsd
        t.totalTokens = c.totalTokens
      }
    }


  }

  return {
    tickets,
    total: Number(rowCount.count),
    limit: q.limit,
    offset: q.offset,
  }
}

export async function getTicket(params: { id: string }): Promise<Ticket> {
  const row = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.id)).limit(1)
  if (!row[0]) throw new Error("Ticket not found")

  // Enrich cost from opencode by summing all sessions
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.ticketId, params.id))
  const enriched = enrichSessions(sessions)
  const realCost = enriched.reduce((sum, s) => sum + s.costUsd, 0)
  const realTokens = enriched.reduce((sum, s) => sum + s.totalTokens, 0)

  // Compute files changed live from git diff
  const liveFiles = await computeChangedFiles(row[0])

  return {
    ...row[0],
    sessionIds: parseJsonField<string[]>(row[0].sessionIds, []),
    filesChanged: liveFiles,
    tags: parseJsonField<string[]>(row[0].tags, []),
    totalCostUsd: realCost,
    totalTokens: realTokens,
  } as Ticket
}

export async function createTicket(input: TicketCreateInput): Promise<Ticket> {
  const data = ticketCreateSchema.parse(input)
  const id = generateId()
  const now = Date.now()

  // Auto-generate branch name
  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, data.repoId)).limit(1)
  const prefix = repo[0]?.name ?? "ticket"
  const slug = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  const branch = `${prefix}/${slug}-${id.slice(0, 8)}`

  await db.insert(schema.tickets).values({
    id,
    title: data.title,
    description: data.description,
    status: "open",
    priority: data.priority,
    category: data.category,
    repoId: data.repoId,
    branch,
    baseBranch: data.baseBranch || "main",
    sessionIds: toJsonField([]),
    activeSessionId: null,
    filesChanged: toJsonField([]),
    totalCostUsd: 0,
    totalTokens: 0,
    tags: toJsonField(data.tags || []),
    notes: "",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    worktreePath: null,
  })

  const created = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1)
  emitSse({ type: "ticket.created", ticketId: id })
  return {
    ...created[0],
    sessionIds: parseJsonField<string[]>(created[0].sessionIds, []),
    filesChanged: parseJsonField<string[]>(created[0].filesChanged, []),
    tags: parseJsonField<string[]>(created[0].tags, []),
  } as Ticket
}

export async function updateTicket(params: { id: string } & TicketUpdateInput): Promise<Ticket> {
  const data = ticketUpdateSchema.parse(params)
  const existing = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.id)).limit(1)
  if (!existing[0]) throw new Error("Ticket not found")

  const updates: Record<string, unknown> = { updatedAt: Date.now() }
  if (data.title !== undefined) updates.title = data.title
  if (data.description !== undefined) updates.description = data.description
  if (data.status !== undefined) updates.status = data.status
  if (data.priority !== undefined) updates.priority = data.priority
  if (data.category !== undefined) updates.category = data.category
  if (data.notes !== undefined) updates.notes = data.notes
  if (data.tags !== undefined) updates.tags = toJsonField(data.tags)

  // If resolved or closed, clean up worktree
  if ((data.status === "resolved" || data.status === "closed") && (existing[0].status !== "resolved" && existing[0].status !== "closed")) {
    updates.resolvedAt = Date.now()
    if (existing[0].worktreePath) {
      try {
        // Stop any active session first
        if (existing[0].activeSessionId) {
          stopSessionServer(existing[0].activeSessionId)
          await db
            .update(schema.sessions)
            .set({ exitCode: 0, exitReason: "user_stopped", endedAt: Date.now() })
            .where(eq(schema.sessions.id, existing[0].activeSessionId))
          // Brief pause for opencode process to release the worktree
          await new Promise((r) => setTimeout(r, 500))
        }
        // Remove worktree + prune (safely delete branch if merged)
        Bun.spawnSync(["git", "worktree", "remove", existing[0].worktreePath])
        Bun.spawnSync(["git", "worktree", "remove", "--force", existing[0].worktreePath])
        Bun.spawnSync(["git", "worktree", "prune"])
        Bun.spawnSync(["git", "branch", "-d", existing[0].branch])
      } catch {}
      updates.worktreePath = null
    }
  }

  // SUBMIT FOR REVIEW is now handled by the dedicated submitForReview handler.
  // The client calls submitForReview RPC instead of going through updateTicket for needs_review.
  // This path is intentionally empty — the dedicated handler does commit + push + PR creation.
  // The if-block below is left as a no-op guard so the status update still goes through
  // if someone manually edits the ticket (e.g. the edit form) and selects needs_review.
  if (existing[0].status === "in_progress" && data.status === "needs_review") {
    // Session stop is the caller's responsibility in manual edit mode.
    // No commit/push/PR — the dedicated submitForReview handler does that.
  }

  // Merge & Resolve: squash branch, generate commit message, merge into base
  if (existing[0].status === "needs_review" && data.status === "resolved") {
    try {
      const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, existing[0].repoId)).limit(1)
      if (repo && existing[0].branch) {
        const base = existing[0].baseBranch || "main"
        const repoPath = repo.localPath

        // Get diff of all branch changes for commit message generation
        const diffProc = Bun.spawnSync(["git", "diff", `origin/${base}...`, "--diff-filter=ACDMR"], { cwd: repoPath })
        const diff = diffProc.stdout.toString().trim()

        if (diff) {
          writeFileSync("/tmp/opencode/commit-diff.txt", diff)
          const settings = await getSettings()
          const opencodeCfg = await getOpencodeConfig()
          const modelFlag = settings.model ? ["--model", settings.model] : []
          const cfgAgent = opencodeCfg.default_agent || ""
          const agentFlag = cfgAgent && cfgAgent !== "auto" && cfgAgent !== "ask" ? ["--agent", cfgAgent] : []
          const genProc = Bun.spawn(["opencode", "run", ...modelFlag, ...agentFlag,
            "Read /tmp/opencode/commit-diff.txt. Write a concise git commit message. First line: summary. Blank line. Bullet list of key changes. Output ONLY the commit message, no preamble."
          ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } })
          const [genStdout] = await Promise.all([new Response(genProc.stdout).text()])
          await genProc.exited
          const commitMsg = genStdout.trim() || "Changes for review"

          // Squash branch into one commit, then push to base branch
          const reset = Bun.spawnSync(["git", "reset", "--soft", `origin/${base}`], { cwd: repoPath })
          if (reset.exitCode === 0) {
            Bun.spawnSync(["git", "commit", "-m", commitMsg], { cwd: repoPath })
            // Merge: push squashed commit onto base branch
            Bun.spawnSync(["git", "push", "origin", `${existing[0].branch}:${base}`], { cwd: repoPath })
          } else {
            // Fallback: direct remote ff-merge
            Bun.spawnSync(["git", "push", "origin", `${existing[0].branch}:${base}`], { cwd: repoPath })
          }
        } else {
          // No diff — just push
          Bun.spawnSync(["git", "push", "origin", `${existing[0].branch}:${base}`], { cwd: repoPath })
        }
      }
    } catch {}
  }

  // Reopening from resolved/closed → clear resolvedAt
  if ((existing[0].status === "resolved" || existing[0].status === "closed") && data.status && data.status !== "resolved" && data.status !== "closed") {
    updates.resolvedAt = null
  }

  await db.update(schema.tickets).set(updates).where(eq(schema.tickets.id, params.id))

  // Rename opencode sessions if title changed
  if (data.title && data.title !== existing[0].title) {
    try {
      const port = await getAnyActivePort()
      if (port) {
        const client = createSdkClient(port)
        const sessions = await db
          .select({ opencodeSessionId: schema.sessions.opencodeSessionId })
          .from(schema.sessions)
          .where(eq(schema.sessions.ticketId, params.id))
        for (const s of sessions) {
          if (s.opencodeSessionId) {
            client.session.update({ sessionID: s.opencodeSessionId, title: data.title }).catch(() => {})
          }
        }
      }
    } catch {}
  }

  emitSse({ type: "ticket.updated", ticketId: params.id })
  const updated = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.id)).limit(1)
  return {
    ...updated[0],
    sessionIds: parseJsonField<string[]>(updated[0].sessionIds, []),
    filesChanged: parseJsonField<string[]>(updated[0].filesChanged, []),
    tags: parseJsonField<string[]>(updated[0].tags, []),
  } as Ticket
}

export async function deleteTicket(params: { id: string }): Promise<void> {
  const ticket = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.id)).limit(1)
  if (!ticket[0]) throw new Error("Ticket not found")

  // Delete associated sessions
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.ticketId, params.id))
  const port = await getAnyActivePort()
  for (const s of sessions) {
    if (s.opencodeSessionId && port) {
      try {
        const client = createSdkClient(port)
        client.session.delete({ sessionID: s.opencodeSessionId }).catch(() => {})
      } catch {}
    }
    stopSessionServer(s.id)
  }
  await db.delete(schema.sessions).where(eq(schema.sessions.ticketId, params.id))

  await db.delete(schema.tickets).where(eq(schema.tickets.id, params.id))
  emitSse({ type: "ticket.deleted", ticketId: params.id })
}

export async function generateNotes(params: { id: string }): Promise<{ notes: string; costUsd: number }> {
  const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.id)).limit(1)
  if (!ticket) throw new Error("Ticket not found")

  // Find the latest session for this ticket with an opencode session
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.ticketId, params.id), isNotNull(schema.sessions.opencodeSessionId)))
    .orderBy(desc(schema.sessions.createdAt))
    .limit(1)

  if (!session || !session.opencodeSessionId) throw new Error("No session found. Start a session first.")

  // ── 1. Export session transcript via opencode CLI (reads local DB, no server needed) ──
  const exportProc = Bun.spawn(["opencode", "export", session.opencodeSessionId], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  })
  const [exportStdout, exportStderr] = await Promise.all([
    new Response(exportProc.stdout).text(),
    new Response(exportProc.stderr).text(),
  ])
  const exportExit = await exportProc.exited
  if (exportExit !== 0) throw new Error(`Failed to export session: ${exportStderr.slice(0, 200)}`)

  const exportData = JSON.parse(exportStdout)

  // ── 2. Build transcript from messages ──
  const transcriptText = (exportData.messages ?? [])
    .filter((m: any) => m.info?.role === "user" || m.info?.role === "assistant")
    .map((m: any) => {
      const text = (m.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text ?? "")
        .join(" ")
      return `[${m.info.role}]: ${text}`
    })
    .join("\n\n")
    .slice(0, 30_000)

  // ── 3. Build summarization prompt ──
  const prompt = `Based ONLY on the session transcript below, write a brief summary (2-3 bullet points) of what was accomplished in this session.

Rules:
- Use ONLY the transcript below. Do NOT scan the repo, check git history, or reference anything outside this transcript.
- Output in markdown bullet points.
- Be specific about what was actually done (files changed, features added, bugs fixed).

Ticket: ${ticket.title}
Description: ${ticket.description?.slice(0, 300) ?? ""}

<transcript>
${transcriptText}
</transcript>`

  // ── 4. Generate notes via SDK (creates temp session; cost persists in opencode DB) ──
  const port = await getAnyActivePort()
  if (!port) throw new Error("No active opencode server found")
  const client = createSdkClient(port)

  const createResult = await client.session.create({
    title: "summarize",
  })
  const tempSessionId = ((createResult.data as any)?.id ?? (createResult as any).id) as string
  if (!tempSessionId) throw new Error("Failed to create temp session")

  await client.session.prompt({
    sessionID: tempSessionId,
    parts: [{ type: "text", text: prompt }],
  })

  const msgResult = await client.session.messages({ sessionID: tempSessionId })
  const messages = Array.isArray(msgResult.data) ? msgResult.data : []

  let notes = (messages as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>)
    .filter((m) => m.info?.role === "assistant")
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n")
  if (!notes) notes = "Session notes generated."

  // ── 5. Save to ticket ──
  await db.update(schema.tickets).set({ notes, updatedAt: Date.now() }).where(eq(schema.tickets.id, params.id))

  // ── 6. Read cost from temp session (kept in opencode DB) ──
  const getResult = await client.session.get({ sessionID: tempSessionId })
  const s = getResult.data as any
  const costUsd = s?.cost ?? 0

  return { notes, costUsd }
}

export async function batchUpdateTickets(params: { ids: string[]; status?: string; priority?: string; category?: string }): Promise<void> {
  const updates: Record<string, unknown> = { updatedAt: Date.now() }
  if (params.status) updates.status = params.status
  if (params.priority) updates.priority = params.priority
  if (params.category) updates.category = params.category
  await db.update(schema.tickets).set(updates).where(inArray(schema.tickets.id, params.ids))
  for (const id of params.ids) {
    emitSse({ type: "ticket.updated", ticketId: id })
  }
}

export async function batchDeleteTickets(params: { ids: string[] }): Promise<void> {
  for (const id of params.ids) {
    await deleteTicket({ id })
  }
}

// ─── Sessions ──────────────────────────────────────────────────────────

// Track which sessions are currently improving their prompts
const improvingSessions = new Map<string, boolean>()



export async function recentSessions(params: { limit?: number; offset?: number; repoId?: string }): Promise<Array<Session & { ticketTitle: string | null; repoId: string | null; repoName: string | null }>> {
  const limit = params.limit ?? 15
  const offset = params.offset ?? 0
  const rows = await db
    .select({
      session: schema.sessions,
      ticketTitle: schema.tickets.title,
      repoId: schema.tickets.repoId,
      repoName: schema.repos.name,
    })
    .from(schema.sessions)
    .leftJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
    .leftJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
    .where(params.repoId ? eq(schema.tickets.repoId, params.repoId) : undefined)
    .orderBy(desc(schema.sessions.createdAt))
    .limit(limit)
    .offset(offset)

  const mapped = rows.map((r) => ({
    ...r.session,
    transcript: parseJsonField(r.session.transcript, []),
    diff: parseJsonField(r.session.diff, []),
    filesChanged: parseJsonField<string[]>(r.session.filesChanged, []),
    ticketTitle: r.ticketTitle ?? null,
    repoId: r.repoId ?? null,
    repoName: r.repoName ?? null,
  }))

  return enrichSessions(mapped) as Array<Session & { ticketTitle: string | null; repoId: string | null; repoName: string | null }>
}

function parseSessionRow(row: any): Session {
  return {
    ...row,
    transcript: parseJsonField(row.transcript, []),
    diff: parseJsonField(row.diff, []),
    filesChanged: parseJsonField<string[]>(row.filesChanged, []),
  } as Session
}

export async function ticketSessions(params: { ticketId: string }): Promise<Session[]> {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.ticketId, params.ticketId))
    .orderBy(desc(schema.sessions.createdAt))

  const parsed = rows.map(parseSessionRow)

  return enrichSessions(parsed)
}

export async function getSession(params: { id: string }): Promise<Session> {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!row[0]) throw new Error("Session not found")
  return parseSessionRow(row[0])
}

export async function createSession(params: { ticketId: string }) {
  const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.ticketId)).limit(1)
  if (!ticket) throw new Error("Ticket not found")

  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, ticket.repoId)).limit(1)
  if (!repo) throw new Error("Repo not found")

  // Determine session working directory (worktree or repo)
  let sessionCwd: string
  if (ticket.worktreePath && existsSync(ticket.worktreePath)) {
    sessionCwd = ticket.worktreePath
  } else if (ticket.worktreePath) {
    await db.update(schema.tickets).set({ worktreePath: null, updatedAt: Date.now() }).where(eq(schema.tickets.id, ticket.id))
    sessionCwd = await createWorktreeForTicket(ticket, repo)
  } else {
    sessionCwd = await createWorktreeForTicket(ticket, repo)
  }

  // Find or create session row + start opencode server
  const { sessionId, opencodePort: port, opencodeSessionId: existingId, existingSession } =
    await findOrCreateTicketSessionRow(ticket, sessionCwd)

  let opencodeSessionId = existingId

  // Update model on new sessions only (reused sessions keep old model)
  if (!existingSession) {
    const modelStr = (await getSettings()).model || "unknown"
    await db
      .update(schema.sessions)
      .set({ model: modelStr })
      .where(eq(schema.sessions.id, sessionId))
  }

  // Create opencode session if we don't have one
  if (!opencodeSessionId) {
    try {
      const settings = await getSettings()
      const cfg = await getOpencodeConfig()
      const agent = cfg.default_agent && cfg.default_agent !== "auto" && cfg.default_agent !== "ask" ? cfg.default_agent : "plan"
      opencodeSessionId = await createOpencodeSession(port, sessionCwd, ticket.title, 10, parseModel(settings.model), agent)
    } catch (e) {
      console.error("[session] Failed to create opencode session:", e)
    }
  }

  // Persist opencodeSessionId on the session row
  await db
    .update(schema.sessions)
    .set({ opencodeSessionId })
    .where(eq(schema.sessions.id, sessionId))

  // Check if forward is enabled (only for new sessions with a description)
  let forwardEnabled = false
  if (!existingSession && opencodeSessionId && ticket.description) {
    try {
      const settings = await getSettingsRow()
      forwardEnabled = settings?.forwardDescription === true
    } catch {}
  }

  return {
    sessionId,
    opencodePort: port,
    cwd: sessionCwd,
    branch: ticket.branch,
    opencodeSessionId,
    forwardEnabled,
  }
}

export async function stopSession(params: { id: string }): Promise<void> {
  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!session) throw new Error("Session not found")

  finalizeSessionCost(session.opencodeSessionId)
  await markSessionEnded(params.id, session.ticketId, session.createdAt)
}

export async function improveSession(params: { id: string; description?: string }): Promise<void> {
  const sess = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!sess[0]) throw new Error("Session not found")

  const port = getSessionPort(params.id)
  if (!port) throw new Error("Session not running")
  if (!sess[0].opencodeSessionId) throw new Error("No opencode session ID")

  if (improvingSessions.get(params.id)) throw new Error("Already improving")

  // Determine description
  const description = params.description ?? sess[0].initialPrompt
  if (!description) throw new Error("No description to improve")

  improvingSessions.set(params.id, true)
  emitSse({ type: "session.improving.started", sessionId: params.id })

  try {
    const settings = await getSettings()
    const cfg = await getOpencodeConfig()
    const agent = cfg.default_agent && cfg.default_agent !== "auto" && cfg.default_agent !== "ask" ? cfg.default_agent : "plan"
    await generateAndSendImprovedPrompt(
      port,
      sess[0].cwd || "",
      sess[0].opencodeSessionId,
      description,
      {
        model: parseModel(settings.model),
        agent,
        onInjecting: () => {
          emitSse({ type: "session.improving.injecting", sessionId: params.id })
        },
      },
    )
  } finally {
    improvingSessions.set(params.id, false)
    emitSse({ type: "session.improving.done", sessionId: params.id })
  }
}

export async function improvingStatus(params: { id: string }): Promise<{ improving: boolean }> {
  const sess = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!sess[0]) throw new Error("Session not found")
  return { improving: improvingSessions.get(params.id) ?? false }
}

export async function sendSessionMessage(params: { id: string; text: string }): Promise<void> {
  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!session[0]) throw new Error("Session not found")

  let port = getSessionPort(params.id)

  // Auto-restart server if port is dead or missing
  if (!port && session[0].cwd) {
    port = await startSessionServer(params.id, session[0].cwd)
  }

  if (!port) throw new Error("Session not running")
  if (!session[0].opencodeSessionId) throw new Error("Session has no opencode session")

  try {
    await sendToSession(port, session[0].cwd!, session[0].opencodeSessionId, params.text)
  } catch {
    // Session may have been removed from opencode's DB — create a replacement
    console.warn(`[session] send failed for ${session[0].opencodeSessionId}, creating replacement`)
    const newId = await createOpencodeSession(port, session[0].cwd!, session[0].ticketId || session[0].id, 10)
    await db
      .update(schema.sessions)
      .set({ opencodeSessionId: newId })
      .where(eq(schema.sessions.id, params.id))
    await sendToSession(port, session[0].cwd!, newId, params.text)
  }
}

export async function sessionBranch(params: { id: string }): Promise<{ branch: string }> {
  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!session[0]) throw new Error("Session not found")

  let branch = session[0].branch
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: session[0].cwd || session[0].branch,
      encoding: "utf-8",
      timeout: 5000,
    }).trim()
  } catch {}
  return { branch }
}

// ─── Chats ─────────────────────────────────────────────────────────────

export async function createChat(params: { repoId: string; model?: string; prompt: string }) {
  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, params.repoId)).limit(1)
  if (!repo[0]) throw new Error("Repo not found")

  const sessionId = generateId()
  const now = Date.now()

  const opencodePort = await startSessionServer(sessionId, repo[0].localPath)

  let opencodeSessionId: string | null = null
  let modelStr = ""
  try {
    const settings = await getSettings()
    modelStr = settings.model || ""
    const cfg = await getOpencodeConfig()
    const agent = cfg.default_agent && cfg.default_agent !== "auto" && cfg.default_agent !== "ask" ? cfg.default_agent : "plan"
    opencodeSessionId = await createOpencodeSession(opencodePort, repo[0].localPath, `Chat: ${repo[0].name}`, 1, parseModel(settings.model), agent)
  } catch {
    stopSessionServer(sessionId)
    throw new Error("Could not start opencode session. Check that opencode is installed and in your PATH.")
  }

  await db.insert(schema.sessions).values({
    id: sessionId,
    ticketId: null,
    opencodeVersion: "",
    model: modelStr,
    cwd: repo[0].localPath,
    branch: "",
    initialPrompt: params.prompt,
    opencodeSessionId,
    transcript: toJsonField([]),
    diff: toJsonField([]),
    filesChanged: toJsonField([]),
    exitCode: null,
    exitReason: null,
    createdAt: now,
    endedAt: null,
    durationMs: null,
    approved: null,
    revisionNote: null,
    pid: null,
    serverPort: opencodePort,
  })

  emitSse({ type: "session.started", sessionId, ticketId: null })
  return { sessionId, opencodePort, cwd: repo[0].localPath, opencodeSessionId }
}

export async function stopChat(params: { sessionId: string }): Promise<void> {
  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.sessionId)).limit(1)
  if (!session) throw new Error("Chat not found")

  finalizeSessionCost(session.opencodeSessionId)
  await markSessionEnded(params.sessionId, null, null)
}

export async function listChats(): Promise<Session[]> {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        isNull(schema.sessions.ticketId),
        isNull(schema.sessions.endedAt),
        or(isNotNull(schema.sessions.pid), isNotNull(schema.sessions.opencodeSessionId)),
      ),
    )
    .orderBy(desc(schema.sessions.createdAt))
  return rows.map(parseSessionRow)
}

export async function getChat(params: { id: string }): Promise<Session> {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!row[0]) throw new Error("Chat not found")
  return parseSessionRow(row[0])
}

// ─── Costs ─────────────────────────────────────────────────────────────

/** Find a port for any active opencode server by scanning OpenTack's sessions table. */
export async function costSummary(): Promise<CostSummary> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  // Global totals from opencode DB (all sessions, all repos)
  const global = aggregateOpencodeSessionsSince(weekAgo)

  // Per-repo breakdown from opencode DB directory field (covers ALL sessions, not just OpenTack-tracked)
  const ocSessions = queryOpencodeSessionsSince(weekAgo)

  // Map opencode directories to OpenTack repos
  const allRepos = await db.select().from(schema.repos)
  const sortedRepos = [...allRepos].sort((a, b) => b.localPath.length - a.localPath.length) // longest first for prefix match
  const worktreesRoot = getOpenTackWorktreesDir()
  function repoForDir(dir: string | null): { id: string; name: string } | undefined {
    if (!dir) return undefined
    return sortedRepos.find((r) => dir.startsWith(r.localPath) || dir.startsWith(worktreesRoot + "/" + r.name + "/"))
  }

  const perRepoMap = new Map<string, { repoId: string; repoName: string; usd: number; tokens: number; sessionCount: number }>()
  for (const s of ocSessions) {
    const repo = repoForDir(s.directory)
    if (!repo) continue
    const existing = perRepoMap.get(repo.id) ?? { repoId: repo.id, repoName: repo.name, usd: 0, tokens: 0, sessionCount: 0 }
    existing.usd += s.cost
    existing.tokens += s.tokensInput + s.tokensOutput + s.tokensReasoning
    existing.sessionCount++
    perRepoMap.set(repo.id, existing)
  }

  // ticketCount from OpenTack sessions (still useful for ticket tracking)
  const ticketSessions = await db
    .select({ ticketId: schema.sessions.ticketId })
    .from(schema.sessions)
    .where(and(gte(schema.sessions.createdAt, weekAgo), isNotNull(schema.sessions.ticketId)))
  const ticketIds = new Set(ticketSessions.map((s) => s.ticketId).filter(Boolean) as string[])

  return {
    weekTotalUsd: global.totalUsd,
    weekTotalTokens: global.totalTokens,
    sessionCount: global.sessionCount,
    ticketCount: ticketIds.size,
    perRepo: Array.from(perRepoMap.values()),
  }
}

export async function costHistory(): Promise<Array<{ date: string; costUsd: number; tokens: number; sessionCount: number }>> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  return dailyCostHistory(thirtyDaysAgo)
}

export async function costPerTicket(params: { startDate?: string; endDate?: string; search?: string; repoId?: string }) {
  const sessions = await db
    .select({
      ticketId: schema.sessions.ticketId,
      opencodeSessionId: schema.sessions.opencodeSessionId,
      ticketTitle: schema.tickets.title,
      repoName: schema.repos.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
    .innerJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
    .where(and(
      ...(params.startDate ? [gte(schema.sessions.createdAt, new Date(params.startDate).getTime())] : []),
      ...(params.endDate ? [lte(schema.sessions.createdAt, new Date(params.endDate).getTime())] : []),
      ...(params.search ? [like(schema.tickets.title, `%${params.search}%`)] : []),
      ...(params.repoId ? [eq(schema.tickets.repoId, params.repoId)] : []),
    ))

  // Enrich with opencode DB costs and model (single source of truth)
  const enriched = enrichSessions(sessions)

  const perTicket = new Map<string, { title: string; repoName: string; sessionCount: number; models: Map<string, { costUsd: number; tokens: number; sessionCount: number }> }>()

  for (let i = 0; i < sessions.length; i++) {
    const { ticketId, ticketTitle, repoName } = sessions[i]
    const cost = enriched[i]
    if (!ticketId || !cost.model) continue
    if (!perTicket.has(ticketId)) {
      perTicket.set(ticketId, { title: ticketTitle || "Unknown", repoName: repoName || "Unknown", sessionCount: 0, models: new Map() })
    }
    const entry = perTicket.get(ticketId)!
    entry.sessionCount++
    if (!entry.models.has(cost.model)) {
      entry.models.set(cost.model, { costUsd: 0, tokens: 0, sessionCount: 0 })
    }
    const m = entry.models.get(cost.model)!
    m.costUsd += cost.costUsd
    m.tokens += cost.totalTokens
    m.sessionCount++
  }

  return Array.from(perTicket.entries()).map(([ticketId, data]) => ({
    ticketId,
    ticketTitle: data.title,
    repoName: data.repoName,
    sessionCount: data.sessionCount,
    models: Array.from(data.models.entries()).map(([model, d]) => ({ model, ...d })),
    totalCostUsd: Array.from(data.models.values()).reduce((s, m) => s + m.costUsd, 0),
    totalTokens: Array.from(data.models.values()).reduce((s, m) => s + m.tokens, 0),
  }))
}

export async function costPerModel(params: { startDate?: string; endDate?: string }) {
  const startMs = params.startDate ? new Date(params.startDate).getTime() : 0
  const endMs = params.endDate ? new Date(params.endDate).getTime() : Infinity

  // Single source of truth: opencode DB. No OpenTack tables touched.
  const allSessions = queryOpencodeSessionsSince(startMs)

  const perModel = new Map<string, { costUsd: number; tokens: number; sessionCount: number }>()

  for (const s of allSessions) {
    if (s.timeCreated > endMs) continue
    const model = s.model ? normalizeModel(s.model) : null
    if (!model) continue
    if (!perModel.has(model)) {
      perModel.set(model, { costUsd: 0, tokens: 0, sessionCount: 0 })
    }
    const entry = perModel.get(model)!
    entry.sessionCount++
    entry.costUsd += s.cost
    entry.tokens += s.tokensInput + s.tokensOutput + s.tokensReasoning
  }

  return Array.from(perModel.entries()).map(([model, data]) => ({
    model,
    costUsd: data.costUsd,
    tokens: data.tokens,
    sessionCount: data.sessionCount,
    ticketCount: 0,
  }))
}

// ─── Settings ──────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  let row = await getSettingsRow()
  if (!row) {
    await db.insert(schema.settings).values({ id: "global", forwardDescription: 0, theme: "amber", model: "opencode/big-pickle", updatedAt: Date.now() } as any)
    row = await getSettingsRow()
  }
  return {
    forwardDescription: row!.forwardDescription === true,
    theme: (row!.theme as Settings["theme"]) || "amber",
    model: row!.model || "opencode/big-pickle",
    ghPath: row!.ghPath || "gh",
    ghAuthed: !!row!.ghToken,
    defaultRemote: row!.defaultRemote || "origin",
  }
}

export async function updateSettings(params: Partial<SettingsUpdateInput>): Promise<Settings> {
  const data = settingsUpdateSchema.parse(params)
  const updates: Record<string, unknown> = { updatedAt: Date.now() }
  if (data.forwardDescription !== undefined) updates.forwardDescription = data.forwardDescription ? 1 : 0
  if (data.theme !== undefined) updates.theme = data.theme
  if (data.model !== undefined) updates.model = data.model
  if (data.ghPath !== undefined) updates.ghPath = data.ghPath
  if (data.ghToken !== undefined) {
    updates.ghToken = data.ghToken ? encryptToken(data.ghToken) : null
  }
  if (data.defaultRemote !== undefined) updates.defaultRemote = data.defaultRemote
  await db.update(schema.settings).set(updates).where(eq(schema.settings.id, "global"))
  return getSettings()
}

// ─── GitHub CLI ─────────────────────────────────────────────────────────

export async function ghTest(): Promise<{ ok: boolean; user?: { login: string; name: string | null; email: string | null; avatarUrl: string | null; plan: string | null }; error?: string }> {
  const { testGhConnection } = await import("../../shared/gh-runner")
  return testGhConnection()
}

export async function ghInstall(): Promise<{ success: boolean; path?: string; error?: string; message?: string }> {
  const { autoInstallGh, findGh } = await import("../../shared/gh-runner")

  const existing = await findGh("gh")
  if (existing) {
    return { success: true, path: existing }
  }

  try {
    const path = await autoInstallGh()
    return { success: true, path }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error during installation"
    return { success: false, error: "INSTALL_FAILED", message }
  }
}

export async function ghLogout(): Promise<{ ok: boolean; error?: string }> {
  const { runGh } = await import("../../shared/gh-runner")
  // gh auth logout requires the host flag
  const result = await runGh({ args: ["auth", "logout", "-h", "github.com"] })
  if (result.exitCode === 0) return { ok: true }
  // If logout fails (e.g., already logged out), still consider it a success
  if (result.stderr.includes("not logged in")) return { ok: true }
  return { ok: false, error: result.stderr || "Logout failed" }
}

// ─── GitHub OAuth Device Flow ──────────────────────────────────────────
//
// 1. Start device flow via GitHub API fetch → get device_code + user_code + URL
// 2. Show user_code + URL to user (they open URL in browser, enter code)
// 3. Poll GitHub's token endpoint via curl subprocess (Bun.fetch has
//    reliability issues with this specific endpoint — curl works consistently)
// 4. On success: inject token into gh via `gh auth login --with-token`
// 5. Verify connection and return user info

const GH_CLIENT_ID = "178c6fc778ccc68e1d6a"

interface OAuthSession {
  deviceCode: string
  userCode: string
  verificationUri: string
  createdAt: number
}

const oauthSessions = new Map<string, OAuthSession>()

// Clean up stale sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000
  for (const [id, session] of oauthSessions) {
    if (session.createdAt < cutoff) oauthSessions.delete(id)
  }
}, 5 * 60 * 1000)

export async function ghAuthLogin(): Promise<{ processId: string; userCode: string; verificationUri: string }> {
  // Start device flow via GitHub API
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      scope: "repo,read:org,workflow",
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub device code request failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  const processId = crypto.randomUUID()

  oauthSessions.set(processId, {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    createdAt: Date.now(),
  })

  console.log("[ghAuthLogin] device flow started, code:", data.user_code)
  return { processId, userCode: data.user_code, verificationUri: data.verification_uri }
}

export async function ghAuthLoginPoll(
  params: { processId: string },
): Promise<{
  status: "pending" | "success" | "error" | "expired"
  error?: string
  user?: { login: string; name: string | null; email: string | null; avatarUrl: string | null; plan: string | null }
}> {
  const session = oauthSessions.get(params.processId)
  if (!session) return { status: "expired", error: "Session expired or not found" }

  // Check 15-minute expiry
  if (Date.now() - session.createdAt > 15 * 60 * 1000) {
    oauthSessions.delete(params.processId)
    return { status: "expired", error: "Session expired. Please try again." }
  }

  // Poll GitHub token endpoint via curl (more reliable than Bun.fetch for this endpoint)
  const devNull = process.platform === "win32" ? "NUL" : "/dev/null"
  const pollResult = Bun.spawnSync([
    "curl",
    "-s",
    "-X", "POST",
    "https://github.com/login/oauth/access_token",
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json",
    "-d", JSON.stringify({
      client_id: GH_CLIENT_ID,
      device_code: session.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    // Suppress progress output that curl outputs to stderr on some terminals
    "-o", "-",
    "--stderr", devNull,
  ])

  if (pollResult.exitCode !== 0) {
    const stderr = pollResult.stderr.toString().trim()
    console.error("[ghAuthLogin] curl failed:", stderr)
    // Fallback: try Bun.fetch once
    try {
      const fallbackRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: GH_CLIENT_ID,
          device_code: session.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      })
      const fallbackData = await fallbackRes.json()
      if (fallbackData.access_token) {
        return await handleTokenSuccess(params.processId, fallbackData.access_token)
      }
      if (fallbackData.error === "authorization_pending" || fallbackData.error === "slow_down") {
        return { status: "pending" }
      }
      if (fallbackData.error === "expired_token" || fallbackData.error === "access_denied") {
        oauthSessions.delete(params.processId)
        return { status: "expired", error: fallbackData.error_description || fallbackData.error }
      }
      return { status: "pending" }
    } catch {
      return { status: "error", error: `curl failed: ${stderr}` }
    }
  }

  // Parse response
  let data: any
  try {
    data = JSON.parse(pollResult.stdout.toString())
  } catch {
    return { status: "error", error: "Failed to parse GitHub response" }
  }

  // Token received!
  if (data.access_token) {
    console.log("[ghAuthLogin] token received, injecting via gh auth login --with-token")
    return await handleTokenSuccess(params.processId, data.access_token)
  }

  // Still pending
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    console.log("[ghAuthLogin] poll:", data.error)
    return { status: "pending" }
  }

  // Session expired / denied
  if (data.error === "expired_token" || data.error === "access_denied") {
    console.log("[ghAuthLogin] session expired:", data.error)
    oauthSessions.delete(params.processId)
    return { status: "expired", error: data.error_description || data.error }
  }

  // Unexpected error
  console.log("[ghAuthLogin] unexpected response:", JSON.stringify(data))
  return { status: "error", error: data.error_description || data.error || "Unknown error" }
}

async function handleTokenSuccess(
  processId: string,
  token: string,
): Promise<{
  status: "success"
  user: { login: string; name: string | null; email: string | null; avatarUrl: string | null; plan: string | null }
}> {
  // Inject token into gh CLI (async spawn so we can pipe stdin)
  const injectProc = Bun.spawn(["gh", "auth", "login", "--with-token"], {
    stdin: "pipe",
    stderr: "pipe",
  })
  injectProc.stdin.write(token + "\n")
  injectProc.stdin.end()
  const exitCode = await injectProc.exited
  const stderr = await new Response(injectProc.stderr).text()

  if (exitCode !== 0) {
    console.error("[ghAuthLogin] token injection failed:", stderr)
    throw new Error(`Failed to inject token: ${stderr}`)
  }

  // Verify connection and get user info (do this BEFORE deleting session so retries work)
  const { testGhConnection } = await import("../../shared/gh-runner")
  const result = await testGhConnection()

  if (!result.ok || !result.user) {
    throw new Error(`Token injected but verification failed: ${result.error || "gh auth status returned not authenticated"}`)
  }

  // All good — clean up session
  oauthSessions.delete(processId)

  console.log("[ghAuthLogin] OAuth success:", result.user.login)
  return { status: "success", user: result.user }
}

// ─── Sync Worktree ────────────────────────────────────────────────────────

export async function syncWorktree(params: { ticketId: string }): Promise<{ ok: boolean; message: string; conflicts: string[] }> {
  const { syncWorktree: doSync } = await import("../../shared/sync-worktree")
  return doSync(params.ticketId)
}

export async function checkSyncStatus(params: { ticketId: string }): Promise<{ behind: number; ahead: number; error?: string }> {
  const { checkSyncStatus: check } = await import("../../shared/sync-status")
  return check(params.ticketId)
}

// ─── Submit for Review / PR ──────────────────────────────────────────────

export async function submitForReview(params: { ticketId: string }): Promise<{ prUrl: string | null; commitHash: string | null }> {
  const { submitForReview: doSubmit } = await import("../../shared/submit-for-review")
  return doSubmit(params.ticketId)
}

// ─── Opencode Config ───────────────────────────────────────────────────

/** Read config directly from file (fallback, also used by updateOpencodeConfig). */
async function readFileConfig(): Promise<OpencodeConfig> {
  try {
    return JSON.parse(readFileSync(OPENCONFIG_PATH, "utf-8"))
  } catch {
    return { model: "", default_agent: "" }
  }
}

/**
 * Read opencode config — tries SDK first (via any active server), falls back to file.
 */
export async function getOpencodeConfig(): Promise<OpencodeConfig> {
  const port = await getAnyActivePort()
  if (port) {
    try {
      const client = createSdkClient(port)
      return await getGlobalConfig(client)
    } catch { /* fall through to file */ }
  }
  return readFileConfig()
}

export async function updateOpencodeConfig(params: Partial<OpencodeConfig>): Promise<OpencodeConfig> {
  const data = opencodeConfigUpdateSchema.parse(params)
  const current = await readFileConfig()
  const merged = { ...current, ...data }
  // Remove default_agent if set to empty (means "let opencode decide")
  if (merged.default_agent === "") {
    delete merged.default_agent
  }
  mkdirSync(OPENCONFIG_DIR, { recursive: true })
  writeFileSync(OPENCONFIG_PATH, JSON.stringify(merged, null, 2))
  return merged
}

export async function listAgents(): Promise<AgentEntry[]> {
  const agents: AgentEntry[] = []

  // Known opencode built-in agents (always available)
  agents.push(
    { name: "plan", description: "Plan and design" },
    { name: "build", description: "Write code" },
  )

  // Custom agents from filesystem directories
  const agentDirs = [
    `${OPENCONFIG_DIR}/agents`,
    getOpencodeDataAgentsDir(),
  ]
  for (const dir of agentDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !agents.find((a) => a.name === entry.name)) {
          agents.push({ name: entry.name })
        }
      }
    } catch {}
  }

  // Agents from .opencode/agents/ in project dirs (*.md files)
  try {
    const projectAgentsDir = path.join(process.cwd(), ".opencode", "agents")
    for (const entry of readdirSync(projectAgentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const name = entry.name.slice(0, -3)
        if (!agents.find((a) => a.name === name)) {
          agents.push({ name })
        }
      }
    }
  } catch {}

  return agents
}

export async function getOpencodeTuiConfig(): Promise<OpencodeTuiConfig> {
  try {
    return JSON.parse(readFileSync(TUI_CONFIG_PATH, "utf-8"))
  } catch {
    return { theme: "opencode" }
  }
}

export async function updateOpencodeTuiConfig(params: OpencodeTuiConfig): Promise<OpencodeTuiConfig> {
  const current = await getOpencodeTuiConfig()
  const merged = { ...current, ...params }
  mkdirSync(OPENCONFIG_DIR, { recursive: true })
  writeFileSync(TUI_CONFIG_PATH, JSON.stringify(merged, null, 2))
  return merged
}

// ─── Journal ───────────────────────────────────────────────────────────

export async function getJournal(params: { offset?: number; limit?: number; repoId?: string }): Promise<JournalResponse> {
  const limit = params.limit ?? 7
  const offset = params.offset ?? 0

  const conditions: ReturnType<typeof eq>[] = []
  if (params.repoId) conditions.push(eq(schema.tickets.repoId, params.repoId))

  const rows = await db
    .select({
      ticket: schema.tickets,
      repoName: schema.repos.name,
    })
    .from(schema.tickets)
    .leftJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.tickets.updatedAt))
    .limit(limit + 1)
    .offset(offset)

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)

  const dayMap = new Map<string, Array<{ id: string; title: string; notes: string; filesChanged: string[]; branch: string; repoName: string }>>()

  for (const row of items) {
    const t = row.ticket
    const day = new Date(t.updatedAt).toISOString().slice(0, 10)
    if (!dayMap.has(day)) dayMap.set(day, [])
    dayMap.get(day)!.push({
      id: t.id,
      title: t.title,
      notes: t.notes,
      filesChanged: parseJsonField<string[]>(t.filesChanged, []),
      branch: t.branch,
      repoName: row.repoName || "",
    })
  }

  return {
    days: Array.from(dayMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, tickets]) => ({ date, tickets })),
    hasMore,
  }
}

// ─── Worktrees ─────────────────────────────────────────────────────────

export async function createWorktree(params: { ticketId: string }): Promise<void> {
  const ticket = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.ticketId)).limit(1)
  if (!ticket[0]) throw new Error("Ticket not found")
  if (ticket[0].worktreePath && existsSync(ticket[0].worktreePath)) throw new Error("Worktree already exists")

  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, ticket[0].repoId)).limit(1)
  if (!repo[0]) throw new Error("Repo not found")

  const worktreeDir = getOpenTackWorktreesDir()
  const worktreePath = `${worktreeDir}/${repo[0].name}/${ticket[0].branch}`

  // Ensure branch exists
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${ticket[0].branch}`, {
      cwd: repo[0].localPath,
      timeout: 5000,
    })
  } catch {
    execSync(`git branch "${ticket[0].branch}" "${ticket[0].baseBranch || repo[0].defaultBranch}"`, {
      cwd: repo[0].localPath,
      timeout: 5000,
    })
  }

  mkdirSync(`${worktreeDir}/${repo[0].name}`, { recursive: true })
  execSync(`git worktree add "${worktreePath}" "${ticket[0].branch}"`, {
    cwd: repo[0].localPath,
    timeout: 15000,
  })

  // Run bun install
  try {
    execSync("bun install", { cwd: worktreePath, timeout: 60000 })
  } catch {}

  await db.update(schema.tickets).set({ worktreePath, updatedAt: Date.now() }).where(eq(schema.tickets.id, params.ticketId))
}

export async function listWorktrees(): Promise<Ticket[]> {
  const rows = await db
    .select()
    .from(schema.tickets)
    .where(and(
      sql`${schema.tickets.worktreePath} IS NOT NULL`,
      sql`${schema.tickets.worktreePath} != ''`,
    ))
    .orderBy(desc(schema.tickets.updatedAt))
  return rows.map((r) => ({
    ...r,
    sessionIds: parseJsonField<string[]>(r.sessionIds, []),
    filesChanged: parseJsonField<string[]>(r.filesChanged, []),
    tags: parseJsonField<string[]>(r.tags, []),
  })) as Ticket[]
}

export async function removeWorktree(params: { ticketId: string }): Promise<void> {
  const ticket = await db.select().from(schema.tickets).where(eq(schema.tickets.id, params.ticketId)).limit(1)
  if (!ticket[0]) throw new Error("Ticket not found")

  // Stop active session
  if (ticket[0].activeSessionId) {
    stopSessionServer(ticket[0].activeSessionId)
    // Brief pause for opencode process to release the worktree
    await new Promise((r) => setTimeout(r, 500))
  }

  if (ticket[0].worktreePath) {
    Bun.spawnSync(["git", "worktree", "remove", ticket[0].worktreePath])
    Bun.spawnSync(["git", "worktree", "remove", "--force", ticket[0].worktreePath])
    Bun.spawnSync(["git", "worktree", "prune"])
    Bun.spawnSync(["git", "branch", "-d", ticket[0].branch])
  }

  await db
    .update(schema.tickets)
    .set({ worktreePath: null, updatedAt: Date.now() })
    .where(eq(schema.tickets.id, params.ticketId))
}

// ─── System Dialogs ────────────────────────────────────────────────────

export async function pickDirectory(): Promise<string | null> {
  // On desktop, the renderer will use a system dialog via RPC to main process
  // For now, use a simple CLI approach
  const readline = await import("readline")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question("Enter directory path: ", (answer) => {
      rl.close()
      resolve(answer || null)
    })
  })
}

export async function openUrl({ url }: { url: string }): Promise<void> {
  const { execSync } = await import("child_process")
  const platform = process.platform
  try {
    if (platform === "darwin") execSync(`open "${url}"`, { timeout: 5000 })
    else if (platform === "win32") execSync(`start "" "${url}"`, { timeout: 5000 })
    else execSync(`xdg-open "${url}"`, { timeout: 5000 })
  } catch {
    // silently fail — the user can open the URL manually
  }
}

// ─── Version / Updates ──────────────────────────────────────────────────

export async function checkUpdates(): Promise<CheckUpdatesResponse> {
  // Derive version from git tag first (always matches at build time), fall back to package.json
  let currentVersion = "0.0.0"
  try {
    const tag = execSync("git describe --tags --abbrev=0", { encoding: "utf-8", cwd: path.resolve(import.meta.dir, "../..") }).trim()
    if (tag) currentVersion = tag.replace(/^v/, "")
  } catch {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf-8"))
    currentVersion = pkg.version || "0.0.0"
  }

  try {
    // HEAD request without following redirects — read `Location` for latest tag
    const res = await fetch("https://github.com/anas1412/opentack/releases/latest", {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    })
    const location = res.headers.get("location") || ""
    const match = location.match(/\/tag\/(.+)$/)
    const latestVersion = match ? match[1] : null
    const hasUpdate = latestVersion !== null && latestVersion !== `v${currentVersion}`
    return { currentVersion, latestVersion, hasUpdate }
  } catch (err) {
    return { currentVersion, latestVersion: null, hasUpdate: false, error: (err as Error).message }
  }
}

export async function downloadUpdate(): Promise<DownloadUpdateResponse> {
  const platform = process.platform
  if (platform !== "linux" && platform !== "win32") {
    return { success: false, error: "Updates not supported on this platform" }
  }

  const filename = platform === "win32" ? "opentack-install-windows.exe" : "opentack-install-linux"
  const url = `https://github.com/anas1412/opentack/releases/latest/download/${filename}`
  const installerPath = path.join(tmpdir(), filename)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) return { success: false, error: `Download failed (${res.status})` }

    writeFileSync(installerPath, Buffer.from(await res.arrayBuffer()))
    if (platform !== "win32") chmodSync(installerPath, 0o755)

    // Spawn detached — survives app exit
    Bun.spawn([installerPath], { detached: true, stdio: ["ignore", "ignore", "ignore"] })

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
