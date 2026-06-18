import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "../db";
import { registerRepoRoutes } from "./routes/repo";
import { registerTicketRoutes } from "./routes/ticket";
import { registerSessionRoutes } from "./routes/session";
import { registerCostRoutes } from "./routes/cost";
import { registerSettingsRoutes } from "./routes/settings";
import { registerOpencodeConfigRoutes } from "./routes/opencode-config";
import { sseEmitter, SSE_EVENT, type SseEvent } from "./sse";

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

  // ── SPA fallback ─────────────────────────────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile("index.html");
  });

  return app;
}

export async function startServer(port: number = 3000) {
  // Run migrations on startup
  migrate(db, { migrationsFolder: path.resolve(import.meta.dir, "../../drizzle") });

  const app = await buildApp();
  _app = app;

  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`OpenTack running at http://localhost:${port}`);

  return app;
}
