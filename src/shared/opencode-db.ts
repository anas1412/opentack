/**
 * Direct SQLite queries against the opencode session database.
 *
 * Provides complete token/cost data without requiring a running SDK server.
 * The opencode DB always has the full picture — OpenTack's own sessions table
 * only tracks sessions it created itself.
 */
import { Database } from "bun:sqlite";
import { getOpencodeDbPath } from "../paths";

let _db: Database | null = null;

function opencodeDb(): Database {
  if (!_db) {
    _db = new Database(getOpencodeDbPath(), { readonly: true });
    _db.exec("PRAGMA query_only = ON");
  }
  return _db;
}

export interface OpencodeSessionRow {
  id: string;
  timeCreated: number;
  directory: string | null;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  agent: string | null;
  model: string | null;
}

/**
 * Query opencode sessions created since `since` (unix ms).
 * Returns all fields needed for cost aggregation.
 */
export function queryOpencodeSessionsSince(since: number): OpencodeSessionRow[] {
  const db = opencodeDb();
  const stmt = db.prepare(`
    SELECT id,
           time_created AS timeCreated,
           directory,
           cost,
           tokens_input AS tokensInput,
           tokens_output AS tokensOutput,
           tokens_reasoning AS tokensReasoning,
           agent,
           model
    FROM session
    WHERE time_created >= ?
    ORDER BY time_created
  `);
  return stmt.all(since) as OpencodeSessionRow[];
}

export interface DailyCostEntry {
  date: string;
  costUsd: number;
  tokens: number;
  sessionCount: number;
}

/**
 * Build daily aggregation directly from the opencode session DB.
 * This includes ALL opencode sessions, not just OpenTack-tracked ones.
 */
export function dailyCostHistory(since: number): DailyCostEntry[] {
  const rows = queryOpencodeSessionsSince(since);
  const map = new Map<string, { costUsd: number; tokens: number; sessionCount: number }>();

  for (const r of rows) {
    const day = new Date(r.timeCreated).toISOString().slice(0, 10);
    const entry = map.get(day) || { costUsd: 0, tokens: 0, sessionCount: 0 };
    entry.costUsd += r.cost;
    entry.tokens += r.tokensInput + r.tokensOutput + r.tokensReasoning;
    entry.sessionCount++;
    map.set(day, entry);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }));
}

export interface CostTotal {
  totalUsd: number;
  totalTokens: number;
  sessionCount: number;
}

/**
 * Aggregate all opencode sessions since `since` (unix ms).
 */
export function aggregateOpencodeSessionsSince(since: number): CostTotal {
  const rows = queryOpencodeSessionsSince(since);
  let totalUsd = 0;
  let totalTokens = 0;
  let sessionCount = 0;

  for (const r of rows) {
    totalUsd += r.cost;
    totalTokens += r.tokensInput + r.tokensOutput + r.tokensReasoning;
    sessionCount++;
  }

  return { totalUsd, totalTokens, sessionCount };
}

// ─── Cost map helpers (replace SDK fetchAllSessionCosts) ─────────────

interface SessionCost {
  costUsd: number;
  totalTokens: number;
}

/**
 * Return a Map<opencodeSessionId, {costUsd, totalTokens}> for ALL sessions
 * in the opencode DB (no time filter). Use when you need to enrich a set
 * of OpenTack sessions that may span any time range.
 */
export function getAllSessionCostsMap(): Map<string, SessionCost> {
  return buildCostMap(null);
}

/**
 * Return a Map<opencodeSessionId, {costUsd, totalTokens}> only for the
 * given opencode session IDs. Use when you already know which sessions
 * you care about (avoids loading the entire opencode session table).
 */
export function getSessionCostsMap(ids: string[]): Map<string, SessionCost> {
  if (ids.length === 0) return new Map();
  return buildCostMap(ids);
}

/**
 * Return cost/tokens for a single opencode session, or null if not found.
 */
export function getSingleSessionCost(id: string): SessionCost | null {
  const db = opencodeDb();
  const stmt = db.prepare(`
    SELECT cost, tokens_input, tokens_output, tokens_reasoning
    FROM session
    WHERE id = ?
  `);
  const row = stmt.get(id) as { cost: number; tokens_input: number; tokens_output: number; tokens_reasoning: number } | undefined;
  if (!row) return null;
  return {
    costUsd: row.cost,
    totalTokens: row.tokens_input + row.tokens_output + row.tokens_reasoning,
  };
}

function buildCostMap(ids: string[] | null): Map<string, SessionCost> {
  const db = opencodeDb();
  let sql: string;
  let params: any[];
  if (ids) {
    const placeholders = ids.map(() => "?").join(",");
    sql = `SELECT id, cost, tokens_input, tokens_output, tokens_reasoning FROM session WHERE id IN (${placeholders})`;
    params = ids;
  } else {
    sql = "SELECT id, cost, tokens_input, tokens_output, tokens_reasoning FROM session";
    params = [];
  }
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<{ id: string; cost: number; tokens_input: number; tokens_output: number; tokens_reasoning: number }>;
  const map = new Map<string, SessionCost>();
  for (const r of rows) {
    map.set(r.id, {
      costUsd: r.cost,
      totalTokens: r.tokens_input + r.tokens_output + r.tokens_reasoning,
    });
  }
  return map;
}

/**
 * Enrich an array of session-like objects with cost/token data from opencode DB.
 * Batch-lookup by opencodeSessionId, returns new objects with costUsd/totalTokens.
 *
 * Usage:
 *   const sessions = await db.select().from(schema.sessions);
 *   return enrichSessions(sessions);
 */
export function enrichSessions<T extends { opencodeSessionId: string | null }>(
  sessions: T[],
): (T & { costUsd: number; totalTokens: number })[] {
  const ids = sessions.map((s) => s.opencodeSessionId).filter(Boolean) as string[];
  if (ids.length === 0) {
    return sessions.map((s) => ({ ...s, costUsd: 0, totalTokens: 0 }));
  }
  const costMap = getSessionCostsMap(ids);
  return sessions.map((s) => {
    const c = s.opencodeSessionId ? costMap.get(s.opencodeSessionId) : null;
    return { ...s, costUsd: c?.costUsd ?? 0, totalTokens: c?.totalTokens ?? 0 };
  });
}
