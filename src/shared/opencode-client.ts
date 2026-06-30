/**
 * Shared opencode SDK client wrapper (V2).
 *
 * Provides typed methods used by both server routes and bun handlers.
 * Each session gets its own `opencode serve` (different port), so clients
 * are created per-session using the factory function.
 *
 * @opencode-ai/sdk v1.17.11
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Session } from "@opencode-ai/sdk/v2/types";

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an SDK client connected to a specific opencode server.
 */
export function createSdkClient(port: number): OpencodeClient {
  return createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });
}

// ─── Cost helpers ───────────────────────────────────────────────────────

export interface SessionCost {
  costUsd: number;
  totalTokens: number;
}

/** Extract cost from a Session object (handles optional fields). */
function extractCost(session: Session): SessionCost {
  const t = session.tokens;
  const totalTokens = t
    ? t.input + t.output + t.reasoning
    : 0;
  return {
    costUsd: session.cost ?? 0,
    totalTokens,
  };
}

/**
 * Fetch cost/token data for a single opencode session via the SDK.
 * Returns null if the session isn't found.
 */
export async function getSessionCost(
  client: OpencodeClient,
  sessionId: string,
): Promise<SessionCost | null> {
  try {
    const result = await client.session.get({ sessionID: sessionId });
    const session = result.data;
    if (!session) return null;
    return extractCost(session);
  } catch {
    return null;
  }
}

// ─── Config helpers ─────────────────────────────────────────────────────

export interface OpencodeConfig {
  model: string;
  default_agent: string;
}

/**
 * Read global opencode config via SDK (client.global.config.get()).
 * The global config contains `model`, `default_agent`, and other top-level fields.
 */
export async function getGlobalConfig(client: OpencodeClient): Promise<OpencodeConfig> {
  try {
    const result = await client.global.config.get();
    const config = result.data as any;
    return {
      model: config?.model ?? "",
      default_agent: config?.default_agent ?? "",
    };
  } catch {
    return { model: "", default_agent: "" };
  }
}

// ─── Diff helpers ───────────────────────────────────────────────────────

export interface FileDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

/**
 * Get file diffs for a session via the SDK diff endpoint.
 */
export async function getSessionDiff(
  client: OpencodeClient,
  sessionId: string,
): Promise<FileDiffEntry[]> {
  try {
    const result = await client.session.diff({ sessionID: sessionId });
    const diffs = result.data as any;
    if (!Array.isArray(diffs)) return [];
    return diffs.map((d: any) => ({
      path: d.path ?? "",
      status: d.status ?? "modified",
      additions: d.additions ?? 0,
      deletions: d.deletions ?? 0,
    }));
  } catch {
    return [];
  }
}

// ─── Event helpers ──────────────────────────────────────────────────────

export type SdkEventCallback = (event: { type: string; data?: any }) => void;

/**
 * Subscribe to events from an opencode server.
 * Returns an unsubscribe function.
 */
export function subscribeToEvents(
  client: OpencodeClient,
  callback: SdkEventCallback,
): () => void {
  let aborted = false;

  client.event.subscribe().then((result) => {
    const stream = (result as any).stream;
    if (!stream) return;

    (async () => {
      for await (const event of stream) {
        if (aborted) break;
        callback({ type: event.type, data: (event as any).properties });
      }
    })();
  }).catch(() => {
    // connection errors are non-fatal
  });

  return () => {
    aborted = true;
  };
}

// ─── Connection check ───────────────────────────────────────────────────

/**
 * Quick health check against an opencode server.
 */
export async function checkHealth(client: OpencodeClient): Promise<boolean> {
  try {
    const result = await client.global.health();
    const data = result.data as any;
    return data?.healthy === true;
  } catch {
    return false;
  }
}
