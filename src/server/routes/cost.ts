import type { FastifyInstance } from "fastify";
import { gte, and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../../db";
import { dailyCostHistory, aggregateOpencodeSessionsSince, enrichSessions, queryOpencodeSessionsSince } from "../../shared/opencode-db";
import { getOpenTackWorktreesDir } from "../../paths";

export function registerCostRoutes(app: FastifyInstance) {
  // All cost data comes from opencode's global DB via the SDK.
  // OpenTack never tracks costs itself.

  // Weekly cost summary with per-repo breakdown
  app.get("/api/costs/summary", async () => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Global totals from opencode DB (all sessions, all repos)
    const global = aggregateOpencodeSessionsSince(weekAgo);

    // Per-repo breakdown from opencode DB directory field
    const ocSessions = queryOpencodeSessionsSince(weekAgo);

    // Map opencode directories to OpenTack repos
    const allRepos = await db.select().from(schema.repos);
    const sortedRepos = [...allRepos].sort((a, b) => b.localPath.length - a.localPath.length);
    const worktreesRoot = getOpenTackWorktreesDir();
    function repoForDir(dir: string | null): { id: string; name: string } | undefined {
      if (!dir) return undefined;
      return sortedRepos.find((r) => dir.startsWith(r.localPath) || dir.startsWith(worktreesRoot + "/" + r.name + "/"));
    }

    const perRepoMap = new Map<string, { repoId: string; repoName: string; usd: number; tokens: number; sessionCount: number }>();
    for (const s of ocSessions) {
      const repo = repoForDir(s.directory);
      if (!repo) continue;
      const existing = perRepoMap.get(repo.id) || { repoId: repo.id, repoName: repo.name, usd: 0, tokens: 0, sessionCount: 0 };
      existing.usd += s.cost;
      existing.tokens += s.tokensInput + s.tokensOutput + s.tokensReasoning;
      existing.sessionCount++;
      perRepoMap.set(repo.id, existing);
    }

    // ticketCount from OpenTack sessions
    const ticketSessions = await db
      .select({ ticketId: schema.sessions.ticketId })
      .from(schema.sessions)
      .where(and(gte(schema.sessions.createdAt, weekAgo), isNotNull(schema.sessions.ticketId)));
    const ticketIds = new Set(ticketSessions.map((s) => s.ticketId).filter(Boolean) as string[]);

    return {
      weekTotalUsd: global.totalUsd,
      weekTotalTokens: global.totalTokens,
      sessionCount: global.sessionCount,
      ticketCount: ticketIds.size,
      perRepo: Array.from(perRepoMap.values()),
    };
  });

  // Cost history per day (last 30 days)
  app.get("/api/costs/history", async () => {
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return dailyCostHistory(monthAgo);
  });

  // Per-ticket cost breakdown
  app.get<{ Querystring: { days?: string; repoId?: string } }>("/api/costs/per-ticket", async (req) => {
    const days = parseInt(req.query.days || "7", 10);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const conds: any[] = [gte(schema.sessions.createdAt, since)];
    if (req.query.repoId) {
      conds.push(eq(schema.tickets.repoId, req.query.repoId));
    }

    const rows = await db
      .select({
        ticketId: schema.sessions.ticketId,
        ticketTitle: schema.tickets.title,
        repoId: schema.tickets.repoId,
        repoName: schema.repos.name,
        model: schema.sessions.model,
        opencodeSessionId: schema.sessions.opencodeSessionId,
      })
      .from(schema.sessions)
      .innerJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
      .innerJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
      .where(and(...conds));

    // Enrich with opencode DB costs
    const enriched = enrichSessions(rows);

    const ticketMap = new Map<string, {
      ticketId: string;
      ticketTitle: string;
      repoId: string;
      repoName: string;
      sessionCount: number;
      totalTokens: number;
      totalCost: number;
      models: Map<string, { model: string; tokens: number; cost: number; sessionCount: number }>;
    }>();

    for (const row of enriched) {
      if (!row.ticketId) continue;
      let entry = ticketMap.get(row.ticketId);
      if (!entry) {
        entry = {
          ticketId: row.ticketId,
          ticketTitle: row.ticketTitle,
          repoId: row.repoId,
          repoName: row.repoName,
          sessionCount: 0,
          totalTokens: 0,
          totalCost: 0,
          models: new Map(),
        };
        ticketMap.set(row.ticketId, entry);
      }
      entry.sessionCount++;
      entry.totalCost += row.costUsd;
      entry.totalTokens += row.totalTokens;

      let m = entry.models.get(row.model);
      if (!m) {
        m = { model: row.model, tokens: 0, cost: 0, sessionCount: 0 };
        entry.models.set(row.model, m);
      }
      m.tokens += row.totalTokens;
      m.cost += row.costUsd;
      m.sessionCount++;
    }

    return Array.from(ticketMap.values()).map((e) => ({
      ticketId: e.ticketId,
      ticketTitle: e.ticketTitle,
      repoId: e.repoId,
      repoName: e.repoName,
      sessionCount: e.sessionCount,
      totalTokens: e.totalTokens,
      totalCost: e.totalCost,
      models: Array.from(e.models.values()),
    }));
  });

  // Per-model cost breakdown
  app.get("/api/costs/per-model", async () => {
    const rows = await db
      .select({
        model: schema.sessions.model,
        ticketId: schema.sessions.ticketId,
        opencodeSessionId: schema.sessions.opencodeSessionId,
      })
      .from(schema.sessions);

    // Enrich with opencode DB costs
    const enriched = enrichSessions(rows);

    const perModel = new Map<string, {
      totalCost: number;
      totalTokens: number;
      sessionCount: number;
      tickets: Set<string>;
    }>();

    for (const s of enriched) {
      const key = s.model || "unknown";
      let entry = perModel.get(key);
      if (!entry) {
        entry = { totalCost: 0, totalTokens: 0, sessionCount: 0, tickets: new Set() };
        perModel.set(key, entry);
      }
      entry.sessionCount++;
      if (s.ticketId) entry.tickets.add(s.ticketId);
      entry.totalCost += s.costUsd;
      entry.totalTokens += s.totalTokens;
    }

    return Array.from(perModel.entries()).map(([model, data]) => ({
      model,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
      sessionCount: data.sessionCount,
      ticketCount: data.tickets.size,
    }));
  });
}
