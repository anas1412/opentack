/**
 * Event-driven cost watcher using the opencode SDK.
 *
 * Replaces the SQLite-polling cost-watcher.ts.
 * For each active session, fetches cost via the SDK API,
 * persists it to the sessions table, and emits `session.cost`
 * SSE events when values change.
 */
import { db, schema } from "../db";
import { isNull } from "drizzle-orm";
import { emitSse } from "./sse";
import { getSessionPort } from "./opencode-manager";
import { createSdkClient, getSessionCost } from "../shared/opencode-client";

const lastKnownCosts = new Map<string, { costUsd: number; tokens: number }>();

/**
 * Start the SDK-based cost watcher.
 * Polls active sessions via the SDK API (not raw SQLite).
 * Only one interval runs across the entire process.
 */
export function startSdkCostWatcher(intervalMs = 3000): void {
  setInterval(async () => {
    try {
      const active = await db
        .select({
          id: schema.sessions.id,
          ticketId: schema.sessions.ticketId,
          opencodeSessionId: schema.sessions.opencodeSessionId,
        })
        .from(schema.sessions)
        .where(isNull(schema.sessions.endedAt));

      if (active.length === 0) return;

      for (const session of active) {
        if (!session.opencodeSessionId) continue;

        const port = getSessionPort(session.id);
        if (!port) continue; // server not running yet (or dead)

        try {
          const client = createSdkClient(port);
          const cost = await getSessionCost(client, session.opencodeSessionId);
          if (!cost) continue;

          const last = lastKnownCosts.get(session.id);
          if (
            !last ||
            last.costUsd !== cost.costUsd ||
            last.tokens !== cost.totalTokens
          ) {
            lastKnownCosts.set(session.id, {
              costUsd: cost.costUsd,
              tokens: cost.totalTokens,
            });
            emitSse({
              type: "session.cost",
              sessionId: session.id,
              ticketId: session.ticketId,
              costUsd: cost.costUsd,
              tokens: cost.totalTokens,
            });
          }
        } catch {
          // per-session errors are non-fatal
        }
      }
    } catch {
      // watcher errors are non-fatal
    }
  }, intervalMs);
}
