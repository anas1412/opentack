import Database from "bun:sqlite";
import { existsSync } from "fs";
import { getOpencodeDbPath } from "../../paths";

/**
 * Open opencode's DB in read-write mode for mutations (title update, directory update, deletion).
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
