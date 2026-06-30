import { spawn, type ChildProcess, execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { and, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";

interface ServerInstance {
  proc: ChildProcess;
  port: number;
  sessionId: string;
  repoPath: string;
  pid: number;
}

// One opencode serve process per session — isolates web UI origins for parallel use
const servers = new Map<string, ServerInstance>();

/**
 * Resolve the opencode binary path.
 * Checks PATH first (via `which`/`where`), then falls back to common install locations.
 */
function resolveOpencodeBinary(): string {
  // Check PATH first
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execSync(`${which} opencode`, { encoding: "utf-8", timeout: 5000 }).trim();
    if (out) return out.split("\n")[0].trim();
  } catch {
    // not in PATH
  }

  // Common install locations
  const candidates =
    process.platform === "win32"
      ? [path.join(homedir(), ".opencode", "bin", "opencode.exe")]
      : [
          path.join(homedir(), ".opencode", "bin", "opencode"),
          "/usr/local/bin/opencode",
          "/opt/homebrew/bin/opencode",
        ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Last resort — let the OS try to find it
  return "opencode";
}

/**
 * Start (or return existing) opencode serve for a session.
 * Each session gets its own process on a unique OS-assigned port.
 * Waits until the server is listening before resolving.
 */
export async function startSessionServer(sessionId: string, repoPath: string): Promise<number> {
  const existing = servers.get(sessionId);
  if (existing && existing.proc.exitCode === null) {
    return existing.port;
  }
  // Clean up dead entry
  if (existing) servers.delete(sessionId);

  const opencodeBin = resolveOpencodeBinary();
  return new Promise((resolve, reject) => {
    const proc = spawn(opencodeBin, ["serve", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      cwd: repoPath,
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error("opencode serve did not start within 15s"));
      }
    }, 15000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const port = parseInt(match[1], 10);
        servers.set(sessionId, { proc, port, sessionId, repoPath, pid: proc.pid! });
        resolve(port);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on("exit", () => {
      servers.delete(sessionId);
    });
  });
}

/** Kill the opencode serve for a session */
export function stopSessionServer(sessionId: string): void {
  const inst = servers.get(sessionId);
  if (inst && inst.proc.exitCode === null) {
    inst.proc.kill("SIGTERM");
    setTimeout(() => {
      if (inst.proc.exitCode === null) inst.proc.kill("SIGKILL");
    }, 3000);
  }
  servers.delete(sessionId);
}

/** Kill all running servers (call on shutdown) */
export function stopAll(): void {
  for (const [, inst] of servers) {
    if (inst.proc.exitCode === null) {
      inst.proc.kill("SIGTERM");
    }
  }
  servers.clear();
}

/** Get the port for a running session's server, or undefined */
export function getSessionPort(sessionId: string): number | undefined {
  return servers.get(sessionId)?.port;
}

/** Get the PID for a running session's server, or undefined */
export function getSessionPid(sessionId: string): number | undefined {
  return servers.get(sessionId)?.pid;
}

/**
 * Find any active opencode server port by querying the sessions table.
 * Since all `opencode serve` processes share the same global SQLite DB,
 * any active server can serve as a proxy for SDK operations.
 */
export async function getAnyActivePort(): Promise<number | null> {
  const row = await db
    .select({ serverPort: schema.sessions.serverPort })
    .from(schema.sessions)
    .where(
      and(
        isNull(schema.sessions.endedAt),
        sql`${schema.sessions.serverPort} IS NOT NULL`,
      ),
    )
    .limit(1);
  return row[0]?.serverPort ?? null;
}

/**
 * Register a recovered orphan session in the in-memory map.
 * Creates a lightweight stub so getSessionPort() and other functions
 * can find the session. The process is not managed by us — we just
 * track the port for reconnection.
 */
export function registerRecoveredSession(sessionId: string, port: number, repoPath: string): void {
  servers.set(sessionId, {
    proc: { pid: -1, exitCode: null, kill: () => {} } as unknown as ChildProcess,
    port,
    sessionId,
    repoPath,
    pid: -1,
  });
}

/**
 * Check if a session process is alive.
 * On Linux: verifies PID exists, cmdline matches "opencode serve", port is listening.
 * On other platforms (Windows, macOS): checks PID existence via signal 0.
 */
export function isSessionAlive(pid: number, port: number, _repoPath: string): boolean {
  try {
    // Cross-platform: check if PID exists
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Linux-only: verify cmdline + port via /proc/
  if (process.platform === "linux") {
    try {
      if (!existsSync(`/proc/${pid}`)) return false;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes("opencode") || !cmdline.includes("serve")) return false;
      const fds = readFileSync(`/proc/${pid}/net/tcp`, "utf-8");
      const hexPort = port.toString(16).padStart(4, "0");
      if (!fds.includes(`:${hexPort}`)) return false;
    } catch {
      return false;
    }
  }

  return true;
}
