import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, schema } from "../db";
import { registerRepoRoutes } from "./routes/repo";
import { registerTicketRoutes } from "./routes/ticket";
import { registerSessionRoutes } from "./routes/session";
import { registerCostRoutes } from "./routes/cost";
import { registerSettingsRoutes } from "./routes/settings";
import { registerOpencodeConfigRoutes } from "./routes/opencode-config";
import { registerJournalRoutes } from "./routes/journal";
import { registerWorktreeRoutes } from "./routes/worktree";
import { registerChatRoutes } from "./routes/chat";
import { isSessionAlive, registerRecoveredSession } from "./opencode-manager";
import { sseEmitter, SSE_EVENT, type SseEvent } from "./sse";
import { startCostWatcher } from "./cost-watcher";

let _app: Awaited<ReturnType<typeof buildApp>> | null = null;

export function getApp() {
  return _app;
}

async function buildApp() {
  const app = Fastify({ logger: true, forceCloseConnections: true });

  // ── Plugins ──────────────────────────────────────────────────────
  await app.register(cors, { origin: true });

  // ── Static files (built client) ──────────────────────────────────
  const clientDist = path.resolve(import.meta.dir, "../../dist/client");
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: "/",
    wildcard: true,
  });

  // ── Health ───────────────────────────────────────────────────────
  app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));

  // ── SSE endpoint ─────────────────────────────────────────────────
  app.get("/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const onEvent = (event: SseEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    sseEmitter.on(SSE_EVENT, onEvent);

    req.raw.on("close", () => {
      sseEmitter.off(SSE_EVENT, onEvent);
    });
  });

  // ── API routes ───────────────────────────────────────────────────
  registerRepoRoutes(app);
  registerTicketRoutes(app);
  registerSessionRoutes(app);
  registerCostRoutes(app);
  registerSettingsRoutes(app);
  registerOpencodeConfigRoutes(app);
  registerJournalRoutes(app);
  registerWorktreeRoutes(app);
  registerChatRoutes(app);

  // ── SPA fallback ─────────────────────────────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile("index.html");
  });

  return app;
}

/**
 * On startup, recover orphaned sessions that were left running when OpenTack crashed.
 * Scans sessions with no endedAt, checks if the original PID+port is still alive,
 * and re-registers healthy ones in the in-memory server map.
 *
 * Sessions with dead or no PID/port are left as-is — the user sees them as active
 * in the UI. When they interact (send a message), the handler auto-restarts the
 * opencode serve process. This avoids destroying active tickets on restart.
 */
async function recoverOrphanedSessions() {
  const active = await db
    .select()
    .from(schema.sessions)
    .where(isNull(schema.sessions.endedAt));

  let recovered = 0;

  for (const session of active) {
    if (session.pid != null && session.serverPort != null) {
      if (isSessionAlive(session.pid, session.serverPort, session.cwd)) {
        registerRecoveredSession(session.id, session.serverPort, session.cwd);
        console.log(`[recovery] Session ${session.id} recovered on port ${session.serverPort}`);
        recovered++;
      }
    }
  }

  if (recovered > 0) {
    console.log(`[recovery] ${recovered} sessions recovered`);
  }
}

export async function startServer(port: number = 3000) {
  // Run migrations on startup
  migrate(db, { migrationsFolder: path.resolve(import.meta.dir, "../../drizzle") });

  // Recover orphaned sessions from previous crashes
  await recoverOrphanedSessions();

  const app = await buildApp();
  _app = app;

  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`OpenTack running at http://localhost:${port}`);

  // Start background cost watcher — polls opencode DB for active session costs
  // and emits session.cost SSE events when values change. Replaces client-side polling.
  startCostWatcher(3000);

  return app;
}
