import { db, schema } from "../../db"
import { eq, and, or, isNull, isNotNull, like, sql, inArray, desc, gt, gte, lte } from "drizzle-orm"
import { randomUUID } from "crypto"
import { execSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { homedir } from "os"
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

import type {
  Ticket,
  TicketCreateInput,
  TicketUpdateInput,
  Repo,
  RepoCreateInput,
  RepoUpdateInput,
  Session,
  Settings,
  CostSummary,
  OpencodeConfig,
  OpencodeTuiConfig,
  AgentEntry,
  JournalResponse,
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
} from "../../server/opencode-manager"

import { enrichFromOpencode, deleteOpencodeSession, verifyOpencodeSession, fetchOpencodeSessionCost, getOpencodeDb, updateOpencodeSessionDirectory } from "../../server/routes/cost-utils"
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

async function getSettingsRow(): Promise<{ forwardDescription: boolean; theme: string | null; model: string } | undefined> {
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
    const ocCostMap = new Map<string, { cost: number; tokens: number }>()
    if (ocSessionIds.length > 0) {
      const ocDb = getOpencodeDb()
      if (ocDb) {
        try {
          const placeholders = ocSessionIds.map(() => "?").join(",")
          const ocRows = ocDb
            .query(
              `SELECT id, cost, tokens_input + tokens_output as tokens
               FROM session WHERE id IN (${placeholders})`,
            )
            .all(...ocSessionIds) as { id: string; cost: number; tokens: number }[]
          for (const r of ocRows) ocCostMap.set(r.id, { cost: r.cost, tokens: r.tokens })
        } finally {
          ocDb.close()
        }
      }
    }

    // Sum costs per ticket (skip chat sessions with no ticketId)
    const costByTicket = new Map<string, { costUsd: number; totalTokens: number }>()
    for (const s of allSessions) {
      if (!s.ticketId) continue
      const oc = s.opencodeSessionId ? ocCostMap.get(s.opencodeSessionId) : null
      const costUsd = oc?.cost ?? s.costUsd
      const totalTokens = oc?.tokens ?? s.totalTokens
      const existing = costByTicket.get(s.ticketId) ?? { costUsd: 0, totalTokens: 0 }
      existing.costUsd += costUsd
      existing.totalTokens += totalTokens
      costByTicket.set(s.ticketId, existing)
    }

    for (const t of tickets) {
      const c = costByTicket.get(t.id)
      if (c) {
        t.totalCostUsd = c.costUsd
        t.totalTokens = c.totalTokens
      }
    }

    // Include app-level overhead costs
    const appCosts = await db
      .select({
        ticketId: schema.appCost.ticketId,
        costUsd: schema.appCost.costUsd,
        totalTokens: schema.appCost.totalTokens,
      })
      .from(schema.appCost)
      .where(inArray(schema.appCost.ticketId, ticketIds))

    for (const ac of appCosts) {
      if (!ac.ticketId) continue
      const ticket = tickets.find((t) => t.id === ac.ticketId)
      if (ticket) {
        ticket.totalCostUsd = (ticket.totalCostUsd || 0) + ac.costUsd
        ticket.totalTokens = (ticket.totalTokens || 0) + ac.totalTokens
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

  let realCost = 0
  let realTokens = 0
  for (const s of sessions) {
    const enriched = enrichFromOpencode(s.opencodeSessionId, { costUsd: s.costUsd, totalTokens: s.totalTokens })
    realCost += enriched.costUsd
    realTokens += enriched.totalTokens
  }

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
        }
        // Remove worktree + prune + delete branch
        Bun.spawnSync(["git", "worktree", "remove", existing[0].worktreePath])
        Bun.spawnSync(["git", "worktree", "remove", "--force", existing[0].worktreePath])
        Bun.spawnSync(["git", "worktree", "prune"])
        Bun.spawnSync(["git", "branch", "-D", existing[0].branch])
      } catch {}
      updates.worktreePath = null
    }
  }

  await db.update(schema.tickets).set(updates).where(eq(schema.tickets.id, params.id))

  // Rename opencode sessions if title changed
  if (data.title && data.title !== existing[0].title) {
    try {
      const { updateOpencodeSessionTitle } = await import("../../server/routes/cost-utils")
      const sessions = await db
        .select({ opencodeSessionId: schema.sessions.opencodeSessionId })
        .from(schema.sessions)
        .where(eq(schema.sessions.ticketId, params.id))
      for (const s of sessions) {
        if (s.opencodeSessionId) {
          updateOpencodeSessionTitle(s.opencodeSessionId, data.title)
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
  for (const s of sessions) {
    if (s.opencodeSessionId) {
      try { deleteOpencodeSession(s.opencodeSessionId) } catch {}
    }
    stopSessionServer(s.id)
  }
  await db.delete(schema.sessions).where(eq(schema.sessions.ticketId, params.id))

  // Delete app costs
  await db.delete(schema.appCost).where(eq(schema.appCost.ticketId, params.id))

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

  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.id, ticket.repoId)).limit(1)
  if (!repo) throw new Error("Repo not found")

  // Start a temp opencode server for summarization
  const notesSessionId = `notes-${randomUUID()}`
  let port: number
  try {
    port = await startSessionServer(notesSessionId, repo.localPath)
  } catch {
    throw new Error("Could not start opencode server to generate notes.")
  }

  try {
    // Fetch session messages from opencode
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/session/${session.opencodeSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
    )
    if (!msgRes.ok) throw new Error("Failed to read opencode session messages.")

    type MainMessage = { info: { role: string }; parts: Array<{ type: string; text?: string }> }
    const mainMessages = await msgRes.json() as MainMessage[]

    // Build transcript
    const transcriptText = (Array.isArray(mainMessages) ? mainMessages : [])
      .filter((m) => m.info?.role === "user" || m.info?.role === "assistant")
      .map((m) => {
        const text = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ")
        return `[${m.info.role}]: ${text}`
      })
      .join("\n\n")
      .slice(0, 30_000)

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

    // Create a temp session for summarization
    const genSettings = await getSettings()
    const tempSessionId = await createOpencodeSession(port, repo.localPath, "summarize", 1, parseModel(genSettings.model))

    let costUsd = 0
    try {
      // Send summarization prompt
      const msgRes2 = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noReply: false, parts: [{ type: "text", text: prompt }] }),
        },
      )
      if (!msgRes2.ok) throw new Error("Failed to send prompt")

      // Wait for AI to finish
      const waitRes = await fetch(`http://127.0.0.1:${port}/api/session/${tempSessionId}/wait`, { method: "POST" })
      if (!waitRes.ok) throw new Error(`Wait endpoint returned ${waitRes.status}`)

      // Read the AI response
      const msgListRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repo.localPath)}`,
      )
      type Msg = { info: { role: string }; parts: Array<{ type: string; text?: string }> }
      const messages = await msgListRes.json() as Msg[]

      let notes = (Array.isArray(messages) ? messages : [])
        .filter((m) => m.info?.role === "assistant")
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n")

      // Save cost
      try {
        const cost = fetchOpencodeSessionCost(tempSessionId)
        if (cost) {
          costUsd = cost.costUsd
          await db.insert(schema.appCost).values({
            id: randomUUID(),
            type: "generate_notes",
            ticketId: params.id,
            costUsd: cost.costUsd,
            totalTokens: cost.totalTokens,
            createdAt: Date.now(),
          })
        }
      } catch { /* best-effort */ }

      if (!notes) notes = "Session notes generated."

      // Save to ticket
      await db.update(schema.tickets).set({ notes, updatedAt: Date.now() }).where(eq(schema.tickets.id, params.id))

      return { notes, costUsd }
    } finally {
      // Clean up temp session
      fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}?directory=${encodeURIComponent(repo.localPath)}`,
        { method: "DELETE" },
      ).catch(() => {})
    }
  } finally {
    stopSessionServer(notesSessionId)
  }
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

/**
 * Send a plain text message to an opencode session.
 */
async function sendToSession(
  port: number,
  repoPath: string,
  sessionId: string,
  text: string,
  noReply = false,
  retries = 3,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/message?directory=${encodeURIComponent(repoPath)}`
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noReply, parts: [{ type: "text", text }] }),
      })
      if (res.ok) return
      const body = await res.text().catch(() => "unknown")
      // Retry on server errors (5xx) — not on client errors (4xx)
      if (res.status < 500 || attempt === retries - 1) {
        throw new Error(`Failed to send message: ${res.status} ${body.slice(0, 200)}`)
      }
    } catch (e) {
      if (attempt === retries - 1) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Generate and send an improved prompt using a temporary opencode session.
 */
async function generateAndSendImprovedPrompt(
  port: number,
  repoPath: string,
  opencodeSessionId: string,
  description: string,
  model: OpencodeModel | undefined,
  onInjecting?: () => void,
): Promise<void> {
  const tempLabel = `improve-${randomUUID().slice(0, 8)}`

  try {
    // 1. Create a temporary session on the same server
    const tempSessionId = await createOpencodeSession(port, repoPath, tempLabel, 1, model)

    try {
      // 2. Build improvement prompt
      const improvementPrompt = `Rewrite the following task description into a detailed, well-structured prompt for an AI coding assistant.

Rules:
- Do NOT use any tools, read any files, or scan the repository.
- Only rewrite the text below. Do not add information from anywhere else.
- Return ONLY the rewritten prompt. No explanations, no prefixes, no markdown formatting.

Original description:
${description}

Prompt:`

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
      )
      if (!msgRes.ok) throw new Error(`Failed to send improvement prompt: ${msgRes.status}`)

      // 4. Wait for AI to finish
      await fetch(
        `http://127.0.0.1:${port}/api/session/${tempSessionId}/wait`,
        { method: "POST" },
      )

      // 5. Read the AI response
      const msgListRes = await fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}/message?directory=${encodeURIComponent(repoPath)}`,
      )
      type Msg = { info: { role: string }; parts: Array<{ type: string; text?: string }> }
      const messages = await msgListRes.json() as Msg[]

      const improved = (Array.isArray(messages) ? messages : [])
        .filter((m) => m.info?.role === "assistant")
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n")

      // 6. Save app-level cost before deleting
      try {
        const cost = fetchOpencodeSessionCost(tempSessionId)
        if (cost) {
          await db.insert(schema.appCost).values({
            id: randomUUID(),
            type: "improve_prompt",
            ticketId: null,
            costUsd: cost.costUsd,
            totalTokens: cost.totalTokens,
            createdAt: Date.now(),
          })
        }
      } catch { /* best-effort */ }

      // 7. Send the improved prompt (or original as fallback) to the real session
      const sendPromise = sendToSession(port, repoPath, opencodeSessionId, improved || description)
      onInjecting?.()
      await sendPromise
    } finally {
      // Clean up temp session
      fetch(
        `http://127.0.0.1:${port}/session/${tempSessionId}?directory=${encodeURIComponent(repoPath)}`,
        { method: "DELETE" },
      ).catch(() => {})
    }
  } catch (err) {
    console.warn("[handlers] Failed to generate improved prompt, sending raw description:", (err as Error).message)
    const sendPromise = sendToSession(port, repoPath, opencodeSessionId, description).catch(() => {})
    onInjecting?.()
    await sendPromise
  }
}

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
  })) as Array<Session & { ticketTitle: string | null; repoId: string | null; repoName: string | null }>

  // Batch-enrich with real token/cost data from opencode DB
  const ocDb = getOpencodeDb()
  if (ocDb) {
    try {
      const sessionIds = mapped
        .map((r) => r.opencodeSessionId)
        .filter((id): id is string => id !== null)

      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => "?").join(",")
        const opencodeRows = ocDb
          .query(
            `SELECT id, cost, tokens_input + tokens_output as total_tokens
             FROM session WHERE id IN (${placeholders})`,
          )
          .all(...sessionIds) as { id: string; cost: number; total_tokens: number }[]

        const ocMap = new Map(opencodeRows.map((r) => [r.id, r]))
        for (const row of mapped) {
          if (row.opencodeSessionId && ocMap.has(row.opencodeSessionId)) {
            const oc = ocMap.get(row.opencodeSessionId)!
            row.costUsd = oc.cost
            row.totalTokens = oc.total_tokens
          }
        }
      }
    } finally {
      ocDb.close()
    }
  }

  return mapped
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

  // Enrich with live costs from opencode DB
  return rows.map(parseSessionRow).map((s) => {
    const enriched = enrichFromOpencode(s.opencodeSessionId ?? null, {
      costUsd: s.costUsd,
      totalTokens: s.totalTokens,
    })
    return { ...s, costUsd: enriched.costUsd, totalTokens: enriched.totalTokens }
  })
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
    // Worktree path missing — clear and create new
    await db.update(schema.tickets).set({ worktreePath: null, updatedAt: Date.now() }).where(eq(schema.tickets.id, ticket.id))
    sessionCwd = await createWorktreeForTicket(ticket, repo)
  } else {
    sessionCwd = await createWorktreeForTicket(ticket, repo)
  }

  // Find existing session for this ticket (reuse to preserve conversation history)
  const [existingSession] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.ticketId, params.ticketId))
    .limit(1)

  let sessionId: string
  let opencodeSessionId: string | null = null

  if (existingSession) {
    // Reuse — keep the opencodeSessionId for history continuity
    sessionId = existingSession.id
    opencodeSessionId = existingSession.opencodeSessionId

    // If the opencode session was deleted from opencode's DB, clear it so we create a fresh one
    if (opencodeSessionId && !verifyOpencodeSession(opencodeSessionId)) {
      console.warn(`[session] opencode session ${opencodeSessionId} not found in opencode DB — will create new one`)
      opencodeSessionId = null
    }

    // Update the opencode session's directory to match the current cwd (e.g. worktree path)
    if (opencodeSessionId) {
      updateOpencodeSessionDirectory(opencodeSessionId, sessionCwd)
    }

    // Reset session end state so it appears active again
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
      .where(eq(schema.sessions.id, sessionId))
  } else {
    // Create new session row
    sessionId = randomUUID()
    await db.insert(schema.sessions).values({
      id: sessionId,
      ticketId: params.ticketId,
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
    })
  }

  // Update ticket status + active session
  const now = Date.now()
  await db
    .update(schema.tickets)
    .set({
      status: "in_progress",
      activeSessionId: sessionId,
      updatedAt: now,
    })
    .where(eq(schema.tickets.id, params.ticketId))

  emitSse({ type: "session.started", sessionId, ticketId: params.ticketId })

  // Start opencode serve for this session
  let port: number
  try {
    port = await startSessionServer(sessionId, sessionCwd)
    // Persist PID + port for orphan recovery
    const pid = getSessionPid(sessionId)
    if (pid) {
      await db
        .update(schema.sessions)
        .set({ pid, serverPort: port })
        .where(eq(schema.sessions.id, sessionId))
    }
  } catch (err) {
    console.error("[session] Failed to start opencode server:", err)
    await db
      .update(schema.sessions)
      .set({ exitCode: -1, exitReason: "error", endedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId))
    await db
      .update(schema.tickets)
      .set({ status: "open", activeSessionId: null, updatedAt: Date.now() })
      .where(eq(schema.tickets.id, params.ticketId))
    throw new Error("Could not start opencode server. Check that opencode is installed and in your PATH.")
  }

  // Update model on new sessions only (reused sessions keep old model)
  if (!existingSession) {
    const modelStr = (await getSettings()).model || "unknown"
    await db
      .update(schema.sessions)
      .set({ model: modelStr })
      .where(eq(schema.sessions.id, sessionId))
  }

  // Create opencode session if we don't have one (or the old one was missing)
  if (!opencodeSessionId) {
    try {
      const settings = await getSettings()
      opencodeSessionId = await createOpencodeSession(port, sessionCwd, ticket.title, 10, parseModel(settings.model))
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
  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, params.id)).limit(1)
  if (!session[0]) throw new Error("Session not found")

  const now = Date.now()
  const durationMs = session[0].createdAt ? now - session[0].createdAt : null

  await db
    .update(schema.sessions)
    .set({ endedAt: now, durationMs, exitCode: 0, exitReason: "user_stopped" })
    .where(eq(schema.sessions.id, params.id))

  // Clear active session on ticket
  if (session[0].ticketId) {
    await db
      .update(schema.tickets)
      .set({ activeSessionId: null, updatedAt: now })
      .where(eq(schema.tickets.id, session[0].ticketId))
  }

  stopSessionServer(params.id)
  emitSse({ type: "session.stopped", sessionId: params.id, ticketId: session[0].ticketId })
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
    await generateAndSendImprovedPrompt(
      port,
      sess[0].cwd || "",
      sess[0].opencodeSessionId,
      description,
      parseModel(settings.model),
      () => {
        emitSse({ type: "session.improving.injecting", sessionId: params.id })
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

  await sendToSession(port, session[0].cwd!, session[0].opencodeSessionId, params.text)
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
    opencodeSessionId = await createOpencodeSession(opencodePort, repo[0].localPath, `Chat: ${repo[0].name}`, 1, parseModel(settings.model))
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
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
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

  // Read cost from opencode DB before closing
  let costUsd = 0
  let totalTokens = 0
  if (session.opencodeSessionId) {
    try {
      const cost = fetchOpencodeSessionCost(session.opencodeSessionId)
      if (cost) {
        costUsd = cost.costUsd
        totalTokens = cost.totalTokens
      }
    } catch { /* best-effort */ }
  }

  // Record in app_cost
  await db.insert(schema.appCost).values({
    id: randomUUID(),
    type: "chat",
    ticketId: null,
    costUsd,
    totalTokens,
    createdAt: Date.now(),
  })

  // Kill the opencode server
  stopSessionServer(params.sessionId)

  // Mark as ended with cost
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
    .where(eq(schema.sessions.id, params.sessionId))

  emitSse({ type: "session.stopped", sessionId: params.sessionId, ticketId: null })
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

export async function costSummary(): Promise<CostSummary> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const ocDb = getOpencodeDb()

  if (!ocDb) {
    return {
      weekTotalUsd: 0,
      weekTotalTokens: 0,
      sessionCount: 0,
      ticketCount: 0,
      overheadUsd: 0,
      overheadTokens: 0,
      perRepo: [],
    }
  }

  try {
    const totals = ocDb
      .query(
        `SELECT
           COALESCE(SUM(cost), 0) as total_cost,
           COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens,
           COUNT(*) as session_count
         FROM session
         WHERE time_created > ?`,
      )
      .get(weekAgo) as { total_cost: number; total_tokens: number; session_count: number }

    const perDirRows = ocDb
      .query(
        `SELECT
           directory,
           COALESCE(SUM(cost), 0) as cost,
           COALESCE(SUM(tokens_input + tokens_output), 0) as tokens,
           COUNT(*) as sessions
         FROM session
         WHERE time_created > ?
         GROUP BY directory`,
      )
      .all(weekAgo) as { directory: string; cost: number; tokens: number; sessions: number }[]

    const allRepos = await db.select().from(schema.repos)
    const pathToRepo = new Map(allRepos.map((r) => [r.localPath, { id: r.id, name: r.name }]))

    const perRepoMap = new Map<string, { repoId: string; repoName: string; usd: number; tokens: number; sessionCount: number }>()
    for (const d of perDirRows) {
      const repo = pathToRepo.get(d.directory)
      if (!repo) continue
      const existing = perRepoMap.get(repo.id) ?? { repoId: repo.id, repoName: repo.name, usd: 0, tokens: 0, sessionCount: 0 }
      existing.usd += d.cost
      existing.tokens += d.tokens
      existing.sessionCount += d.sessions
      perRepoMap.set(repo.id, existing)
    }

    const [ticketCount] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${schema.tickets.id})` })
      .from(schema.tickets)
      .where(gte(schema.tickets.createdAt, weekAgo))

    let overheadUsd = 0
    let overheadTokens = 0
    try {
      const [overhead] = await db
        .select({
          costUsd: sql<number>`COALESCE(SUM(${schema.appCost.costUsd}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${schema.appCost.totalTokens}), 0)`,
        })
        .from(schema.appCost)
        .where(gte(schema.appCost.createdAt, weekAgo))
      overheadUsd = overhead.costUsd
      overheadTokens = overhead.totalTokens
    } catch {}

    return {
      weekTotalUsd: totals.total_cost,
      weekTotalTokens: totals.total_tokens,
      sessionCount: totals.session_count,
      ticketCount: ticketCount.count,
      perRepo: Array.from(perRepoMap.values()),
      overheadUsd,
      overheadTokens,
    }
  } finally {
    ocDb.close()
  }
}

export async function costHistory(): Promise<Array<{ date: string; costUsd: number; tokens: number }>> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

  const sessions = await db
    .select()
    .from(schema.sessions)
    .where(gte(schema.sessions.createdAt, thirtyDaysAgo))

  const dailyMap = new Map<string, { costUsd: number; tokens: number }>()

  for (const s of sessions) {
    const day = new Date(s.createdAt).toISOString().slice(0, 10)
    const entry = dailyMap.get(day) || { costUsd: 0, tokens: 0 }
    if (s.opencodeSessionId) {
      const cost = enrichFromOpencode(s.opencodeSessionId, { costUsd: 0, totalTokens: 0 })
      entry.costUsd += cost.costUsd
      entry.tokens += cost.totalTokens
    }
    dailyMap.set(day, entry)
  }

  return Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }))
}

export async function costPerTicket(params: { startDate?: string; endDate?: string; search?: string; repoId?: string }) {
  const sessions = await db
    .select({
      session: schema.sessions,
      ticketTitle: schema.tickets.title,
      repoName: schema.repos.name,
    })
    .from(schema.sessions)
    .leftJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
    .leftJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
    .where(and(
      ...(params.startDate ? [gte(schema.sessions.createdAt, new Date(params.startDate).getTime())] : []),
      ...(params.endDate ? [lte(schema.sessions.createdAt, new Date(params.endDate).getTime())] : []),
      ...(params.search ? [like(schema.tickets.title, `%${params.search}%`)] : []),
      ...(params.repoId ? [eq(schema.tickets.repoId, params.repoId)] : []),
    ))

  const perTicket = new Map<string, { title: string; repoName: string; models: Map<string, { costUsd: number; tokens: number }> }>()

  for (const { session, ticketTitle, repoName } of sessions) {
    if (!session.ticketId) continue
    const key = session.ticketId
    if (!perTicket.has(key)) {
      perTicket.set(key, { title: ticketTitle || "Unknown", repoName: repoName || "Unknown", models: new Map() })
    }
    const entry = perTicket.get(key)!
    const modelKey = session.model || "unknown"
    if (!entry.models.has(modelKey)) {
      entry.models.set(modelKey, { costUsd: 0, tokens: 0 })
    }
    const m = entry.models.get(modelKey)!
    if (session.opencodeSessionId) {
      const cost = enrichFromOpencode(session.opencodeSessionId, { costUsd: 0, totalTokens: 0 })
      m.costUsd += cost.costUsd
      m.tokens += cost.totalTokens
    }
  }

  return Array.from(perTicket.entries()).map(([ticketId, data]) => ({
    ticketId,
    ticketTitle: data.title,
    repoName: data.repoName,
    models: Array.from(data.models.entries()).map(([model, d]) => ({ model, ...d })),
    totalCostUsd: Array.from(data.models.values()).reduce((s, m) => s + m.costUsd, 0),
    totalTokens: Array.from(data.models.values()).reduce((s, m) => s + m.tokens, 0),
  }))
}

export async function costPerModel(params: { startDate?: string; endDate?: string }) {
  const sessions = await db
    .select({
      model: schema.sessions.model,
      ticketId: schema.sessions.ticketId,
      opencodeSessionId: schema.sessions.opencodeSessionId,
    })
    .from(schema.sessions)
    .where(and(
      ...(params.startDate ? [gte(schema.sessions.createdAt, new Date(params.startDate).getTime())] : []),
      ...(params.endDate ? [lte(schema.sessions.createdAt, new Date(params.endDate).getTime())] : []),
    ))

  const perModel = new Map<string, { costUsd: number; tokens: number; sessions: Set<string>; tickets: Set<string> }>()

  for (const s of sessions) {
    const key = s.model || "unknown"
    if (!perModel.has(key)) {
      perModel.set(key, { costUsd: 0, tokens: 0, sessions: new Set(), tickets: new Set() })
    }
    const entry = perModel.get(key)!
    entry.sessions.add(s.ticketId || "")
    if (s.ticketId) entry.tickets.add(s.ticketId)
    if (s.opencodeSessionId) {
      const cost = enrichFromOpencode(s.opencodeSessionId, { costUsd: 0, totalTokens: 0 })
      entry.costUsd += cost.costUsd
      entry.tokens += cost.totalTokens
    }
  }

  return Array.from(perModel.entries()).map(([model, data]) => ({
    model,
    costUsd: data.costUsd,
    tokens: data.tokens,
    sessionCount: data.sessions.size,
    ticketCount: data.tickets.size,
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
  }
}

export async function updateSettings(params: Partial<Settings>): Promise<Settings> {
  const data = settingsUpdateSchema.parse(params)
  const updates: Record<string, unknown> = { updatedAt: Date.now() }
  if (data.forwardDescription !== undefined) updates.forwardDescription = data.forwardDescription ? 1 : 0
  if (data.theme !== undefined) updates.theme = data.theme
  if (data.model !== undefined) updates.model = data.model
  await db.update(schema.settings).set(updates).where(eq(schema.settings.id, "global"))
  return getSettings()
}

// ─── Opencode Config ───────────────────────────────────────────────────

export async function getOpencodeConfig(): Promise<OpencodeConfig> {
  try {
    return JSON.parse(readFileSync(OPENCONFIG_PATH, "utf-8"))
  } catch {
    return { model: "", default_agent: "" }
  }
}

export async function updateOpencodeConfig(params: Partial<OpencodeConfig>): Promise<OpencodeConfig> {
  const data = opencodeConfigUpdateSchema.parse(params)
  const current = await getOpencodeConfig()
  const merged = { ...current, ...data }
  mkdirSync(OPENCONFIG_DIR, { recursive: true })
  writeFileSync(OPENCONFIG_PATH, JSON.stringify(merged, null, 2))
  return merged
}

export async function listAgents(): Promise<AgentEntry[]> {
  const agents: AgentEntry[] = []
  try {
    const config = JSON.parse(readFileSync(OPENCONFIG_PATH, "utf-8"))
    if (config.agents) agents.push(...config.agents)
  } catch {}
  // Built-in agents
  agents.unshift(
    { name: "auto", description: "Let opencode decide" },
    { name: "code", description: "Write code" },
    { name: "architect", description: "Plan and design" },
    { name: "ask", description: "Answer questions" },
  )
  // Custom agents from directory
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
  }

  if (ticket[0].worktreePath) {
    Bun.spawnSync(["git", "worktree", "remove", ticket[0].worktreePath])
    Bun.spawnSync(["git", "branch", "-D", ticket[0].branch])
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
