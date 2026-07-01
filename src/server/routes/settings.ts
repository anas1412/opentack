import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { settingsUpdateSchema } from "../validators";
import { encryptToken } from "../../shared/gh-runner";

const DEFAULT_SETTINGS = {
  forwardDescription: true,
  theme: "amber",
  model: "opencode/big-pickle",
  ghPath: "gh",
  ghToken: null as string | null,
  defaultRemote: "origin",
  updatedAt: Date.now,
};

function toPublic(row: typeof schema.settings.$inferSelect) {
  return {
    forwardDescription: row.forwardDescription,
    theme: row.theme,
    model: row.model,
    ghPath: row.ghPath,
    ghAuthed: !!row.ghToken,
    defaultRemote: row.defaultRemote,
  };
}

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
        model: "opencode/big-pickle",
        ghPath: "gh",
        defaultRemote: "origin",
        updatedAt: now,
      });
      [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));
    }

    return toPublic(row!);
  });

  // Update settings
  app.put("/api/settings", async (req, reply) => {
    const input = settingsUpdateSchema.parse(req.body);

    // Encrypt token if provided (write-only — never returned)
    let ghToken: string | undefined;
    if (input.ghToken !== undefined) {
      if (input.ghToken === "") {
        ghToken = null as unknown as string; // clear token
      } else {
        ghToken = encryptToken(input.ghToken);
      }
    }

    // Ensure row exists first
    const [existing] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (input.forwardDescription !== undefined) updateData.forwardDescription = input.forwardDescription;
    if (input.theme !== undefined) updateData.theme = input.theme;
    if (input.model !== undefined) updateData.model = input.model;
    if (input.ghPath !== undefined) updateData.ghPath = input.ghPath;
    if (ghToken !== undefined) updateData.ghToken = ghToken;
    if (input.defaultRemote !== undefined) updateData.defaultRemote = input.defaultRemote;

    if (!existing) {
      await db.insert(schema.settings).values({
        id: "global",
        forwardDescription: (updateData.forwardDescription as boolean) ?? DEFAULT_SETTINGS.forwardDescription,
        theme: (updateData.theme as string) ?? DEFAULT_SETTINGS.theme,
        model: (updateData.model as string) ?? DEFAULT_SETTINGS.model,
        ghPath: (updateData.ghPath as string) ?? DEFAULT_SETTINGS.ghPath,
        ghToken: (updateData.ghToken as string) ?? null,
        defaultRemote: (updateData.defaultRemote as string) ?? DEFAULT_SETTINGS.defaultRemote,
        updatedAt: Date.now(),
      });
    } else {
      await db
        .update(schema.settings)
        .set(updateData)
        .where(eq(schema.settings.id, "global"));
    }

    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global"));
    return toPublic(row!);
  });
}
