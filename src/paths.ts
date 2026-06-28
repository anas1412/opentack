import { homedir } from "os";
import { join } from "path";

// ─── Opencode paths (follows xdg-basedir) ──────────────────────────

export function getOpencodeConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
}

export function getOpencodeConfigPath(): string {
  return join(getOpencodeConfigDir(), "opencode.json");
}

export function getOpencodeTuiPath(): string {
  return join(getOpencodeConfigDir(), "tui.json");
}

export function getOpencodeDataDir(): string {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(homedir(), ".local", "share", "opencode");
}

export function getOpencodeDbPath(): string {
  return join(getOpencodeDataDir(), "opencode.db");
}

export function getOpencodeDataAgentsDir(): string {
  return join(getOpencodeDataDir(), "agents");
}

// ─── OpenTack own paths ────────────────────────────────────────────

/** OpenTack data directory (DB, repos, etc.) */
export function getOpenTackDataDir(): string {
  return process.env.OPENTACK_DATA_DIR || join(homedir(), ".opentack");
}

/** OpenTack SQLite database path */
export function getOpenTackDbPath(): string {
  return process.env.OPENTACK_DB_PATH || join(getOpenTackDataDir(), "db.sqlite");
}

/** OpenTack cloned repos directory */
export function getOpenTackReposDir(): string {
  return join(getOpenTackDataDir(), "repos");
}

/** OpenTack git worktrees root directory */
export function getOpenTackWorktreesDir(): string {
  return join(homedir(), "opentack-worktrees");
}

/** OpenTack install directory (source code) */
export function getOpenTackInstallDir(): string {
  return process.env.OPENTACK_DIR || join(homedir(), "opentack");
}

export function getBunDir(): string {
  return join(homedir(), ".bun");
}

export function getOpencodeCliDir(): string {
  return join(homedir(), ".opencode");
}
