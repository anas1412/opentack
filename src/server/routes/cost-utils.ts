import Database from "bun:sqlite";
import { existsSync } from "fs";
import { getOpencodeDbPath } from "../../paths";

export function getOpencodeDb(): Database | null {
  const dbPath = getOpencodeDbPath();
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Open opencode's DB in read-write mode for mutations (title update, deletion).
 * Returns null if the DB is unavailable.
 */
function getOpencodeDbWritable(): Database | null {
  const dbPath = getOpencodeDbPath();
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath);
  } catch {
    return null;
  }
}

/**
 * Update the title of an opencode session to match the renamed ticket.
 * This is a best-effort operation — non-fatal if opencode DB is unavailable.
 */
export function updateOpencodeSessionTitle(
  opencodeSessionId: string | null,
  newTitle: string,
): boolean {
  if (!opencodeSessionId) return false;
  const ocDb = getOpencodeDbWritable();
  if (!ocDb) return false;
  try {
    ocDb.run("UPDATE session SET title = ?, time_updated = ? WHERE id = ?", [
      newTitle,
      Date.now(),
      opencodeSessionId,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    ocDb.close();
  }
}

/**
 * Update the working directory of an opencode session to match the current server cwd.
 * This keeps the session's directory in sync when resuming with a worktree path.
 * Best-effort — non-fatal if opencode DB is unavailable.
 */
export function updateOpencodeSessionDirectory(
  opencodeSessionId: string | null,
  newDirectory: string,
): boolean {
  if (!opencodeSessionId) return false;
  const ocDb = getOpencodeDbWritable();
  if (!ocDb) return false;
  try {
    ocDb.run("UPDATE session SET directory = ?, time_updated = ? WHERE id = ?", [
      newDirectory,
      Date.now(),
      opencodeSessionId,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    ocDb.close();
  }
}

/**
 * Delete an opencode session from opencode's own DB.
 * Related rows (session_message, session_input, etc.) cascade-delete via FK.
 * This is a best-effort operation — non-fatal if opencode DB is unavailable.
 */
export function deleteOpencodeSession(opencodeSessionId: string | null): boolean {
  if (!opencodeSessionId) return false;
  const ocDb = getOpencodeDbWritable();
  if (!ocDb) return false;
  try {
    ocDb.run("DELETE FROM session WHERE id = ?", [opencodeSessionId]);
    return true;
  } catch {
    return false;
  } finally {
    ocDb.close();
  }
}

/**
 * Check whether an opencode session ID still exists in opencode's DB.
 * Returns false if the DB is unavailable or the ID wasn't found.
 */
export function verifyOpencodeSession(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const ocDb = getOpencodeDb();
  if (!ocDb) return false;
  try {
    const row = ocDb
      .query(`SELECT 1 FROM session WHERE id = ?`)
      .get(sessionId) as unknown;
    return row !== undefined;
  } catch {
    return false;
  } finally {
    ocDb.close();
  }
}

/**
 * Look up real cost/token data from opencode's session table.
 * Returns enriched data or the original values if opencode DB is unavailable.
 */
export function enrichFromOpencode(
  opencodeSessionId: string | null,
  fallback: { costUsd: number; totalTokens: number },
): { costUsd: number; totalTokens: number } {
  if (!opencodeSessionId) return fallback;

  const ocDb = getOpencodeDb();
  if (!ocDb) return fallback;

  try {
    const row = ocDb
      .query(
        `SELECT cost, tokens_input + tokens_output as total_tokens
         FROM session WHERE id = ?`,
      )
      .get(opencodeSessionId) as { cost: number; total_tokens: number } | undefined;

    if (row) {
      return { costUsd: row.cost, totalTokens: row.total_tokens };
    }
    return fallback;
  } catch {
    return fallback;
  } finally {
    ocDb.close();
  }
}

/**
 * Fetch cost and token data for a single opencode session.
 * Returns null if the session isn't found or the DB is unavailable.
 */
export function fetchOpencodeSessionCost(
  opencodeSessionId: string,
): { costUsd: number; totalTokens: number } | null {
  const ocDb = getOpencodeDb();
  if (!ocDb) return null;

  try {
    const row = ocDb
      .query(
        `SELECT cost, tokens_input + tokens_output as total_tokens
         FROM session WHERE id = ?`,
      )
      .get(opencodeSessionId) as { cost: number; total_tokens: number } | undefined;

    if (row) {
      return { costUsd: row.cost, totalTokens: row.total_tokens };
    }
    return null;
  } catch {
    return null;
  } finally {
    ocDb.close();
  }
}
