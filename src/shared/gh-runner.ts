/**
 * Shared gh CLI runner.
 *
 * Detects gh binary, runs gh commands with GH_TOKEN env, and tests auth.
 * Cross-platform (Linux, macOS, Windows).
 */
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { hostname } from "node:os";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";

// ─── Types ──────────────────────────────────────────────────────────────

export interface GhRunOptions {
  args: string[];
  cwd?: string;
}

export interface GhRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GhUserInfo {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  plan: string | null;
}

export interface GhTestResult {
  ok: boolean;
  user?: GhUserInfo;
  error?: string;
}

// ─── Encryption ─────────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = "opentack-gh-token-v1";

function getEncryptionKey(): Buffer {
  const hn = hostname();
  return pbkdf2Sync(hn + "-opentack-key", PBKDF2_SALT, PBKDF2_ITERATIONS, 32, "sha256");
}

export function encryptToken(token: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, tagHex, dataHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

// ─── Detection ──────────────────────────────────────────────────────────

/**
 * Find gh binary on the system.
 * Returns full path or null.
 */
export async function findGh(binPath: string = "gh"): Promise<string | null> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  try {
    const result = Bun.spawnSync([cmd, binPath]);
    if (result.exitCode === 0) {
      return result.stdout.toString().trim().split("\n")[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the OS-specific install command for gh.
 */
export function getGhInstallCommand(): { command: string; args: string[]; sudo: boolean } | null {
  const platform = process.platform;

  if (platform === "linux") {
    // Detect distro
    try {
      const osRelease = require("fs").readFileSync("/etc/os-release", "utf8");
      if (osRelease.includes("ID=arch") || osRelease.includes("ID_LIKE=arch")) {
        return { command: "pacman", args: ["-S", "--noconfirm", "github-cli"], sudo: true };
      }
      if (osRelease.includes("ID=fedora") || osRelease.includes("ID_LIKE=fedora")) {
        return { command: "dnf", args: ["install", "-y", "gh"], sudo: true };
      }
      // Default Debian/Ubuntu
      return { command: "apt", args: ["install", "-y", "gh"], sudo: true };
    } catch {
      return { command: "apt", args: ["install", "-y", "gh"], sudo: true };
    }
  }

  if (platform === "darwin") {
    return { command: "brew", args: ["install", "gh"], sudo: false };
  }

  if (platform === "win32") {
    // Prefer winget over choco/scoop
    return { command: "winget", args: ["install", "--id", "GitHub.cli", "-e"], sudo: false };
  }

  return null;
}

/**
 * Check if sudo is available and passwordless.
 */
function hasPasswordlessSudo(): boolean {
  try {
    const result = Bun.spawnSync(["sudo", "-n", "true"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to auto-install gh CLI.
 * Returns the path to gh if successful, or throws.
 */
export async function autoInstallGh(): Promise<string> {
  // Check if gh is already available
  const existing = await findGh("gh");
  if (existing) return existing;

  const install = getGhInstallCommand();
  if (!install) {
    throw new Error(
      "Could not determine how to install gh on your platform. " +
        "Install it manually from https://cli.github.com"
    );
  }

  if (install.sudo && !hasPasswordlessSudo()) {
    throw new Error(
      "gh installation requires sudo, but passwordless sudo is not available.\n\n" +
        `Run this manually:\n  sudo ${install.command} ${install.args.join(" ")}\n\n` +
        "Or install from https://cli.github.com"
    );
  }

  const fullArgs = install.sudo ? ["sudo", install.command, ...install.args] : [install.command, ...install.args];

  const result = Bun.spawnSync(fullArgs);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `gh installation failed: ${stderr}\n\n` +
        "Install manually: https://cli.github.com"
    );
  }

  // Verify install
  const path = await findGh("gh");
  if (!path) {
    throw new Error("gh was installed but could not be found in PATH. Try restarting the app.");
  }

  return path;
}

// ─── Runner ─────────────────────────────────────────────────────────────

/**
 * Run a gh command.
 *
 * Uses token from settings if configured (GH_TOKEN).
 * Falls back to system credentials (gh auth login) if no token is set.
 */
export async function runGh(options: GhRunOptions): Promise<GhRunResult> {
  // Load settings
  const [row] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, "global"));

  if (!row) {
    return { stdout: "", stderr: "Settings not initialized", exitCode: 1 };
  }

  const ghPath = row.ghPath || "gh";

  // Validate gh binary
  const ghExists = await findGh(ghPath);
  if (!ghExists) {
    return {
      stdout: "",
      stderr: `gh CLI not found at "${ghPath}". Install from https://cli.github.com or update path in Settings.`,
      exitCode: 1,
    };
  }

  // Build env — set GH_TOKEN only if a token is stored in settings
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (row.ghToken) {
    try {
      env.GH_TOKEN = decryptToken(row.ghToken);
    } catch {
      return {
        stdout: "",
        stderr: "Failed to decrypt GitHub token. Re-enter it in Settings → GitHub.",
        exitCode: 1,
      };
    }
  }
  // If no token in settings, gh uses its own stored credentials (gh auth login)

  // Run gh
  const result = Bun.spawnSync([ghExists, ...options.args], {
    cwd: options.cwd,
    env,
  });

  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Test gh connection and return user info.
 *
 * Checks both:
 * 1. System credentials (gh auth login)
 * 2. Stored token (Settings → GitHub)
 */
export async function testGhConnection(): Promise<GhTestResult> {
  // First check if gh binary exists
  const [row] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, "global"));

  const ghPath = row?.ghPath || "gh";
  const ghExists = await findGh(ghPath);
  if (!ghExists) {
    return { ok: false, error: `gh CLI not found at "${ghPath}"` };
  }

  // Try auth status — works with system credentials OR stored token
  const result = await runGh({ args: ["auth", "status"] });
  if (result.exitCode !== 0) {
    const stderr = result.stderr || "Authentication failed";
    // If no token in settings, give a clearer message
    if (!row?.ghToken) {
      return { ok: false, error: `Not authenticated. Run \`gh auth login\` or add a Personal Access Token in Settings → GitHub.` };
    }
    return { ok: false, error: stderr };
  }

  // Parse user info from `gh api user`
  const userResult = await runGh({ args: ["api", "user", "--jq", "{login, name, email, avatar_url, plan: .plan.name}"] });
  let userInfo: GhUserInfo | undefined;

  if (userResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(userResult.stdout);
      userInfo = {
        login: parsed.login,
        name: parsed.name || null,
        email: parsed.email || null,
        avatarUrl: parsed.avatar_url || null,
        plan: parsed.plan || null,
      };
    } catch {
      // Fallback: just use login from auth status
      const loginMatch = result.stdout.match(/Logged in to github\.com as (\S+)/);
      if (loginMatch) {
        userInfo = { login: loginMatch[1], name: null, email: null, avatarUrl: null, plan: null };
      }
    }
  }

  return { ok: true, user: userInfo };
}

// ─── OAuth Device Flow ──────────────────────────────────────────────────

/**
 * GitHub OAuth device code client_id — this is the public gh CLI app's ID.
 * Same one gh itself uses for `gh auth login --web`.
 */
const GH_CLIENT_ID = "178c6fc778ccc68e1d6a";

export interface DeviceAuthStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/**
 * Start the device authorization flow.
 * Returns a code the user enters at https://github.com/login/device.
 */
export async function startDeviceAuth(): Promise<DeviceAuthStartResult> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      scope: "repo,read:org,workflow",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub device code request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval,
  };
}

export interface DeviceAuthPollResult {
  status: "pending" | "success" | "expired" | "error";
  token?: string;
  error?: string;
}

/**
 * Poll for the device authorization result.
 * Call this every `interval` seconds after `startDeviceAuth`.
 */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthPollResult> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!res.ok) {
    return { status: "error", error: `HTTP ${res.status}` };
  }

  const data = await res.json();

  if (data.access_token) {
    return { status: "success", token: data.access_token };
  }

  if (data.error === "authorization_pending") {
    return { status: "pending" };
  }

  if (data.error === "slow_down") {
    return { status: "pending" };
  }

  if (data.error === "expired_token" || data.error === "access_denied") {
    return { status: "expired", error: data.error_description || data.error };
  }

  return { status: "error", error: data.error_description || data.error || "Unknown error" };
}
