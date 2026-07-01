import type { FastifyInstance } from "fastify";
import { gte, lte, and, eq, like, isNotNull } from "drizzle-orm";
import { db, schema } from "../../db";
import { dailyCostHistory, aggregateOpencodeSessionsSince, enrichSessions, queryOpencodeSessionsSince, normalizeModel } from "../../shared/opencode-db";
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
  app.get<{ Querystring: { startDate?: string; endDate?: string; search?: string; repoId?: string } }>("/api/costs/per-ticket", async (req) => {
    const conds: any[] = [];
    if (req.query.startDate) conds.push(gte(schema.sessions.createdAt, new Date(req.query.startDate).getTime()));
    if (req.query.endDate) conds.push(lte(schema.sessions.createdAt, new Date(req.query.endDate).getTime()));
    if (req.query.search) conds.push(like(schema.tickets.title, `%${req.query.search}%`));
    if (req.query.repoId) conds.push(eq(schema.tickets.repoId, req.query.repoId));

    const rows = await db
      .select({
        ticketId: schema.sessions.ticketId,
        ticketTitle: schema.tickets.title,
        repoName: schema.repos.name,
        opencodeSessionId: schema.sessions.opencodeSessionId,
      })
      .from(schema.sessions)
      .innerJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
      .innerJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
      .where(and(...conds));

    // Enrich with opencode DB costs and model (single source of truth)
    const enriched = enrichSessions(rows);

    const ticketMap = new Map<string, {
      ticketId: string;
      ticketTitle: string;
      repoName: string;
      sessionCount: number;
      totalTokens: number;
      totalCostUsd: number;
      models: Map<string, { model: string; tokens: number; costUsd: number; sessionCount: number }>;
    }>();

    for (const row of enriched) {
      if (!row.ticketId || !row.model) continue;
      let entry = ticketMap.get(row.ticketId);
      if (!entry) {
        entry = {
          ticketId: row.ticketId,
          ticketTitle: row.ticketTitle,
          repoName: row.repoName,
          sessionCount: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          models: new Map(),
        };
        ticketMap.set(row.ticketId, entry);
      }
      entry.sessionCount++;
      entry.totalCostUsd += row.costUsd;
      entry.totalTokens += row.totalTokens;

      let m = entry.models.get(row.model);
      if (!m) {
        m = { model: row.model, tokens: 0, costUsd: 0, sessionCount: 0 };
        entry.models.set(row.model, m);
      }
      m.tokens += row.totalTokens;
      m.costUsd += row.costUsd;
      m.sessionCount++;
    }

    return Array.from(ticketMap.values()).map((e) => ({
      ticketId: e.ticketId,
      ticketTitle: e.ticketTitle,
      repoName: e.repoName,
      sessionCount: e.sessionCount,
      totalTokens: e.totalTokens,
      totalCostUsd: e.totalCostUsd,
      models: Array.from(e.models.values()),
    }));
  });

  // Per-model cost breakdown
  app.get<{ Querystring: { startDate?: string; endDate?: string } }>("/api/costs/per-model", async (req) => {
    const startMs = req.query.startDate ? new Date(req.query.startDate).getTime() : 0;
    const endMs = req.query.endDate ? new Date(req.query.endDate).getTime() : Infinity;

    // Single source of truth: opencode DB. No OpenTack tables touched.
    const allSessions = queryOpencodeSessionsSince(startMs);

    const perModel = new Map<string, {
      costUsd: number;
      tokens: number;
      sessionCount: number;
    }>();

    for (const s of allSessions) {
      if (s.timeCreated > endMs) continue;
      const model = s.model ? normalizeModel(s.model) : null;
      if (!model) continue;
      if (!perModel.has(model)) {
        perModel.set(model, { costUsd: 0, tokens: 0, sessionCount: 0 });
      }
      const entry = perModel.get(model)!;
      entry.sessionCount++;
      entry.costUsd += s.cost;
      entry.tokens += s.tokensInput + s.tokensOutput + s.tokensReasoning;
    }

    return Array.from(perModel.entries()).map(([model, data]) => ({
      model,
      costUsd: data.costUsd,
      tokens: data.tokens,
      sessionCount: data.sessionCount,
      ticketCount: 0,
    }));
  });
}
