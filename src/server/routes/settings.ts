import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { settingsUpdateSchema } from "../validators";

export function registerSettingsRoutes(app: FastifyInstance) {
  // Get settings (creates default row if missing)
  app.get("/api/settings", async () => {
    let [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));

    if (!row) {
      const now = Date.now();
      await db.insert(schema.settings).values({
        id: "global",
        forwardDescription: true,
        theme: "amber",
        updatedAt: now,
      });
      [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));
    }

    return {
      forwardDescription: row!.forwardDescription,
      theme: row!.theme,
    };
  });

  // Update settings
  app.put("/api/settings", async (req, reply) => {
    const input = settingsUpdateSchema.parse(req.body);

    // Ensure row exists first
    const [existing] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));

    if (!existing) {
      await db.insert(schema.settings).values({
        id: "global",
        forwardDescription: input.forwardDescription ?? true,
        theme: input.theme ?? "amber",
        updatedAt: Date.now(),
      });
    } else {
      await db
        .update(schema.settings)
        .set({
          ...(input.forwardDescription !== undefined && { forwardDescription: input.forwardDescription }),
          ...(input.theme !== undefined && { theme: input.theme }),
          updatedAt: Date.now(),
        })
        .where(eq(schema.settings.id, "global"));
    }

    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));
    return {
      forwardDescription: row!.forwardDescription,
      theme: row!.theme,
    };
  });
}
