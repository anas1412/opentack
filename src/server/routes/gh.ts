import type { FastifyInstance } from "fastify";
import { testGhConnection, autoInstallGh, findGh, startDeviceAuth, pollDeviceAuth } from "../../shared/gh-runner";

export function registerGhRoutes(app: FastifyInstance) {
  // Test gh + token authentication
  app.post("/api/gh/test", async () => {
    const result = await testGhConnection();
    return result;
  });

  // Auto-install gh CLI
  app.post("/api/gh/install", async (req, reply) => {
    const existing = await findGh("gh");
    if (existing) {
      return { success: true, path: existing };
    }

    try {
      const path = await autoInstallGh();
      return { success: true, path };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error during installation";
      return reply.status(500).send({
        success: false,
        error: "INSTALL_FAILED",
        message,
      });
    }
  });

  // Start OAuth device flow (sign in with GitHub)
  app.post("/api/gh/auth/start", async (req, reply) => {
    try {
      const result = await startDeviceAuth();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: "AUTH_START_FAILED", message });
    }
  });

  // Poll for device auth result
  app.post("/api/gh/auth/poll", async (req, reply) => {
    const { deviceCode } = req.body as { deviceCode: string };
    if (!deviceCode) {
      return reply.status(400).send({ error: "MISSING_DEVICE_CODE", message: "deviceCode is required" });
    }

    const result = await pollDeviceAuth(deviceCode);

    // If success, store the token
    if (result.status === "success" && result.token) {
      const { encryptToken } = await import("../../shared/gh-runner");
      const { db, schema } = await import("../../db");
      const { eq } = await import("drizzle-orm");

      const encrypted = encryptToken(result.token);
      await db
        .update(schema.settings)
        .set({ ghToken: encrypted, updatedAt: Date.now() })
        .where(eq(schema.settings.id, "global"));
    }

    return result;
  });
}
