import type { FastifyInstance } from "fastify";
import { sql, gte, and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { getOpencodeDb } from "./cost-utils";

export function registerCostRoutes(app: FastifyInstance) {
  // All cost data comes from opencode's DB — the sole source of truth.
  // OpenTack never tracks costs itself.

  // Weekly cost summary with per-repo breakdown
  app.get("/api/costs/summary", async () => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const ocDb = getOpencodeDb();

    if (!ocDb) {
      return {
        weekTotalUsd: 0,
        weekTotalTokens: 0,
        sessionCount: 0,
        ticketCount: 0,
        perRepo: [],
        overheadUsd: 0,
        overheadTokens: 0,
      };
    }

    try {
      const totals = ocDb
        .query(
          `SELECT
             COALESCE(SUM(cost), 0) as total_cost,
             COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens,
             COUNT(*) as session_count
           FROM session
           WHERE time_created > ?`,
        )
        .get(weekAgo) as { total_cost: number; total_tokens: number; session_count: number };

      const perDirRows = ocDb
        .query(
          `SELECT
             directory,
             COALESCE(SUM(cost), 0) as cost,
             COALESCE(SUM(tokens_input + tokens_output), 0) as tokens,
             COUNT(*) as sessions
           FROM session
           WHERE time_created > ?
           GROUP BY directory`,
        )
        .all(weekAgo) as { directory: string; cost: number; tokens: number; sessions: number }[];

      ocDb.close();

      const allRepos = await db.select().from(schema.repos);
      const pathToRepo = new Map(allRepos.map((r) => [r.localPath, { id: r.id, name: r.name }]));

      const perRepoMap = new Map<string, { repoId: string; repoName: string; usd: number; tokens: number; sessionCount: number }>();

      for (const d of perDirRows) {
        const repo = pathToRepo.get(d.directory);
        if (!repo) continue;
        const existing = perRepoMap.get(repo.id);
        if (existing) {
          existing.usd += d.cost;
          existing.tokens += d.tokens;
          existing.sessionCount += d.sessions;
        } else {
          perRepoMap.set(repo.id, { repoId: repo.id, repoName: repo.name, usd: d.cost, tokens: d.tokens, sessionCount: d.sessions });
        }
      }

      const [ticketCount] = await db
        .select({ count: sql<number>`COUNT(DISTINCT ${schema.tickets.id})` })
        .from(schema.tickets)
        .where(gte(schema.tickets.createdAt, weekAgo));

      let overheadUsd = 0;
      let overheadTokens = 0;
      try {
        const [overhead] = await db
          .select({
            costUsd: sql<number>`COALESCE(SUM(${schema.appCost.costUsd}), 0)`,
            totalTokens: sql<number>`COALESCE(SUM(${schema.appCost.totalTokens}), 0)`,
          })
          .from(schema.appCost)
          .where(gte(schema.appCost.createdAt, weekAgo));
        overheadUsd = overhead.costUsd;
        overheadTokens = overhead.totalTokens;
      } catch {}

      return {
        weekTotalUsd: totals.total_cost,
        weekTotalTokens: totals.total_tokens,
        sessionCount: totals.session_count,
        ticketCount: ticketCount.count,
        perRepo: Array.from(perRepoMap.values()),
        overheadUsd,
        overheadTokens,
      };
    } catch {
      ocDb.close();
      return {
        weekTotalUsd: 0,
        weekTotalTokens: 0,
        sessionCount: 0,
        ticketCount: 0,
        perRepo: [],
        overheadUsd: 0,
        overheadTokens: 0,
      };
    }
  });

  // Cost history per day (last 30 days)
  app.get("/api/costs/history", async () => {
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const ocDb = getOpencodeDb();

    if (!ocDb) return [];

    try {
      const rows = ocDb
        .query(
          `SELECT
             DATE(time_created / 1000, 'unixepoch') as date,
             COALESCE(SUM(cost), 0) as totalUsd,
             COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
             COUNT(*) as sessionCount
           FROM session
           WHERE time_created > ?
           GROUP BY DATE(time_created / 1000, 'unixepoch')
           ORDER BY date`,
        )
        .all(monthAgo) as { date: string; totalUsd: number; totalTokens: number; sessionCount: number }[];

      ocDb.close();
      return rows;
    } catch {
      ocDb.close();
      return [];
    }
  });

  // Per-ticket cost breakdown
  app.get<{ Querystring: { days?: string; repoId?: string } }>("/api/costs/per-ticket", async (req) => {
    const days = parseInt(req.query.days || "7", 10);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
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
          tokens: schema.sessions.totalTokens,
          cost: schema.sessions.costUsd,
        })
        .from(schema.sessions)
        .innerJoin(schema.tickets, eq(schema.sessions.ticketId, schema.tickets.id))
        .innerJoin(schema.repos, eq(schema.tickets.repoId, schema.repos.id))
        .where(and(...conds));

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

      // Filter out chat sessions (no ticketId) — INNER JOIN already excludes them but TS needs help
      const ticketRows = rows.filter((r): r is typeof r & { ticketId: string } => r.ticketId !== null);
      for (const row of ticketRows) {
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
        entry.totalTokens += row.tokens;
        entry.totalCost += row.cost;

        let m = entry.models.get(row.model);
        if (!m) {
          m = { model: row.model, tokens: 0, cost: 0, sessionCount: 0 };
          entry.models.set(row.model, m);
        }
        m.tokens += row.tokens;
        m.cost += row.cost;
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
    } catch {
      return [];
    }
  });

  // Per-model cost breakdown
  app.get("/api/costs/per-model", async () => {
    const ocDb = getOpencodeDb();

    if (!ocDb) {
      return [];
    }

    try {
      const rows = ocDb
        .query(
          `SELECT
             model,
             COALESCE(SUM(cost), 0) as totalCost,
             COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
             COUNT(*) as sessionCount
           FROM session
           GROUP BY model
           ORDER BY totalCost DESC`,
        )
        .all() as { model: string; totalCost: number; totalTokens: number; sessionCount: number }[];

      ocDb.close();

      const modelNames = rows.map((r) => r.model);
      const ticketCounts = new Map<string, number>();

      if (modelNames.length > 0) {
        const otSessions = await db
          .select({
            model: schema.sessions.model,
            ticketId: schema.sessions.ticketId,
          })
          .from(schema.sessions)
          .where(inArray(schema.sessions.model, modelNames));

        const seen = new Set<string>();
        for (const s of otSessions) {
          const key = `${s.model}:${s.ticketId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ticketCounts.set(s.model, (ticketCounts.get(s.model) || 0) + 1);
        }
      }

      return rows.map((r) => ({
        model: r.model,
        totalCost: r.totalCost,
        totalTokens: r.totalTokens,
        sessionCount: r.sessionCount,
        ticketCount: ticketCounts.get(r.model) || 0,
      }));
    } catch {
      ocDb.close();
      return [];
    }
  });
}
