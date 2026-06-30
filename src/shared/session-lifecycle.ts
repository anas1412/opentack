/**
 * Shared session lifecycle helpers — deduplicates createSession/createChat/stopSession/stopChat
 * between server routes and bun handlers.
 *
 * Both entrypoints follow the same patterns but diverge on:
 * - Error handling (routes return HTTP errors, handlers throw)
 * - Model resolution (routes use SDK getGlobalConfig, handlers use getSettings)
 * - Opencode session creation params (routes: 1 retry, no agent; handlers: 10 retries + agent)
 *
 * This module extracts the ~95% identical stop flows into shared helpers,
 * and the ~70% identical create flows with shared core + caller-specific wrappers.
 */
import { db, schema } from "../db"
import { eq } from "drizzle-orm"
import { getSingleSessionCost } from "./opencode-db"
import { startSessionServer, stopSessionServer, getSessionPid } from "../server/opencode-manager"
import { emitSse } from "../server/sse"
import { updateOpencodeSessionDirectory } from "../server/routes/sqlite-helpers"

// ─── Stop helpers ─────────────────────────────────────────────────────

/**
 * Fetch cost from opencode DB by opencodeSessionId.
 * Returns the cost values (0 if no opencode session or no cost data yet).
 * Cost persists in opencode's own session table — no additional storage needed.
 */
export function finalizeSessionCost(
  opencodeSessionId: string | null,
): { costUsd: number; totalTokens: number } {
  if (!opencodeSessionId) return { costUsd: 0, totalTokens: 0 }
  const cost = getSingleSessionCost(opencodeSessionId)
  if (!cost) return { costUsd: 0, totalTokens: 0 }
  return { costUsd: cost.costUsd, totalTokens: cost.totalTokens }
}

/**
 * Mark a session as ended:
 * 1. Updates session row (exitCode, endedAt, pid: null, serverPort: null)
 * 2. Clears ticket.activeSessionId if ticketId is provided
 * 3. Kills the per-session opencode serve process
 * 4. Emits session.stopped SSE event
 */
export async function markSessionEnded(
  id: string,
  ticketId: string | null,
  createdAt: number | null,
): Promise<void> {
  const now = Date.now()
  const durationMs = createdAt ? now - createdAt : null

  await db
    .update(schema.sessions)
    .set({
      exitCode: 0,
      exitReason: "user_stopped",
      endedAt: now,
      durationMs,
      pid: null,
      serverPort: null,
    })
    .where(eq(schema.sessions.id, id))

  if (ticketId) {
    await db
      .update(schema.tickets)
      .set({ activeSessionId: null, updatedAt: now })
      .where(eq(schema.tickets.id, ticketId))
  }

  stopSessionServer(id)
  emitSse({ type: "session.stopped", sessionId: id, ticketId })
}

// ─── Create helpers ───────────────────────────────────────────────────

export interface TicketSessionRowResult {
  /** The session ID (reused or newly created) */
  sessionId: string
  /** The port that opencode serve started on */
  opencodePort: number
  /** Previously existing opencode session ID, or null if new */
  opencodeSessionId: string | null
  /** True if an existing session row was reused */
  existingSession: boolean
}

/**
 * Find or create a ticket session row, update ticket status, start opencode server.
 *
 * Handles the ~60 line core that's identical between routes and handlers:
 * - Find existing session for this ticket (reuse for history continuity)
 * - Update opencode session directory if reusing
 * - Reset session end state or create new row
 * - Update ticket to in_progress with activeSessionId
 * - Emit session.started SSE
 * - Start opencode serve and persist PID/port
 *
 * Caller must still: resolve model, create opencode session, check forwardEnabled,
 * persist opencodeSessionId. Those diverge between entrypoints.
 *
 * Throws if server start fails — caller should catch and handle (roll back ticket state).
 */
export async function findOrCreateTicketSessionRow(
  ticket: { id: string; branch: string; description: string | null },
  sessionCwd: string,
): Promise<TicketSessionRowResult> {
  const now = Date.now()

  // Find existing session for this ticket (reuse to preserve conversation history)
  const [existingSession] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.ticketId, ticket.id))
    .limit(1)

  let sessionId: string
  let opencodeSessionId: string | null = null

  if (existingSession) {
    sessionId = existingSession.id
    opencodeSessionId = existingSession.opencodeSessionId

    // Update the opencode session's directory to match the current cwd (e.g. worktree path)
    if (opencodeSessionId) {
      updateOpencodeSessionDirectory(opencodeSessionId, sessionCwd)
    }

    // Reset end state so it appears active again
    await db
      .update(schema.sessions)
      .set({
        exitCode: null,
        exitReason: null,
        endedAt: null,
        durationMs: null,
        cwd: sessionCwd,
        branch: ticket.branch,
        createdAt: now, // bump for timeline sort
      })
      .where(eq(schema.sessions.id, sessionId))
  } else {
    // Create new session row
    sessionId = crypto.randomUUID()
    await db.insert(schema.sessions).values({
      id: sessionId,
      ticketId: ticket.id,
      opencodeVersion: "latest",
      model: "unknown",
      cwd: sessionCwd,
      branch: ticket.branch,
      initialPrompt: ticket.description ?? "",
      opencodeSessionId: null,
      transcript: "[]",
      diff: "[]",
      filesChanged: "[]",
      exitCode: null,
      exitReason: null,
      createdAt: now,
      endedAt: null,
      durationMs: null,
      approved: null,
      revisionNote: null,
    })
  }

  // Update ticket status + active session
  await db
    .update(schema.tickets)
    .set({
      status: "in_progress",
      activeSessionId: sessionId,
      updatedAt: now,
    })
    .where(eq(schema.tickets.id, ticket.id))

  emitSse({ type: "session.started", sessionId, ticketId: ticket.id })

  // Start opencode serve for this session
  const port = await startSessionServer(sessionId, sessionCwd)

  // Persist PID + port for orphan recovery
  const pid = getSessionPid(sessionId)
  if (pid) {
    await db
      .update(schema.sessions)
      .set({ pid, serverPort: port })
      .where(eq(schema.sessions.id, sessionId))
  }

  return { sessionId, opencodePort: port, opencodeSessionId, existingSession: !!existingSession }
}


