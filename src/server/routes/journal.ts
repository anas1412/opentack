import type { FastifyInstance } from "fastify";
import { and, sql, inArray, gte, lt, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db";

const DAY_MS = 86_400_000;

function toDateStr(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface TicketDayInfo {
  id: string;
  title: string;
  notes: string;
  filesChanged: string[];
  branch: string;
  repoName: string;
}

interface JournalDayResult {
  date: string;
  tickets: TicketDayInfo[];
}

export function registerJournalRoutes(app: FastifyInstance) {
  app.get("/api/journal", async (req) => {
    const query = z.object({
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(30).default(7),
      repoId: z.string().optional(),
    }).parse(req.query);

    // If filtering by repo, get matching ticket IDs once
    let repoTicketIds: string[] | undefined;
    if (query.repoId) {
      const rows = await db
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(eq(schema.tickets.repoId, query.repoId));
      repoTicketIds = rows.map((r) => r.id);
    }

    const now = Date.now();
    const results: JournalDayResult[] = [];

    for (let i = query.offset; i < query.offset + query.limit; i++) {
      const dateStr = toDateStr(now - i * DAY_MS);
      const dayStart = new Date(dateStr + "T00:00:00").getTime();
      const dayEnd = dayStart + DAY_MS;

      const dayConditions: any[] = [
        gte(schema.sessions.createdAt, dayStart),
        sql`${schema.sessions.createdAt} < ${dayEnd}`,
      ];
      if (repoTicketIds) {
        dayConditions.push(inArray(schema.sessions.ticketId, repoTicketIds));
      }

      const sessions = await db
        .select()
        .from(schema.sessions)
        .where(and(...dayConditions));

      if (sessions.length === 0) {
        results.push({ date: dateStr, tickets: [] });
        continue;
      }

      const ticketIds = [...new Set(sessions.map((s) => s.ticketId))];
      const tickets = await db
        .select()
        .from(schema.tickets)
        .where(inArray(schema.tickets.id, ticketIds));

      const repoIds = [...new Set(tickets.map((t) => t.repoId))];
      const repos = await db
        .select()
        .from(schema.repos)
        .where(inArray(schema.repos.id, repoIds));
      const repoMap = new Map(repos.map((r) => [r.id, r.name]));

      const ticketInfos: TicketDayInfo[] = tickets.map((t) => {
        const ticketSessions = sessions.filter((s) => s.ticketId === t.id);
        const filesChanged = new Set<string>();
        for (const s of ticketSessions) {
          try {
            for (const f of JSON.parse(s.filesChanged) as string[]) filesChanged.add(f);
          } catch { /* skip */ }
        }
        return {
          id: t.id,
          title: t.title,
          notes: t.notes,
          filesChanged: Array.from(filesChanged),
          branch: t.branch,
          repoName: repoMap.get(t.repoId) ?? "Unknown",
        };
      });

      results.push({ date: dateStr, tickets: ticketInfos });
    }

    // Check if there are sessions older than the last returned day
    const lastDate = results[results.length - 1]?.date;
    let hasMore = false;
    if (lastDate) {
      const lastDayStart = new Date(lastDate + "T00:00:00").getTime();
      const hasMoreConditions: any[] = [
        lt(schema.sessions.createdAt, lastDayStart),
      ];
      if (repoTicketIds) {
        hasMoreConditions.push(inArray(schema.sessions.ticketId, repoTicketIds));
      }
      const [oldest] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.sessions)
        .where(and(...hasMoreConditions));
      hasMore = (oldest?.count ?? 0) > 0;
    }

    return { days: results, hasMore };
  });
}
