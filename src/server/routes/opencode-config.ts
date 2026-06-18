import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import { opencodeConfigUpdateSchema } from "../validators";

function getConfigPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(process.env.HOME!, ".config", "opencode");
  return join(configDir, "opencode.json");
}

function readConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const path = getConfigPath();
  const dir = path.substring(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function registerOpencodeConfigRoutes(app: FastifyInstance) {
  // Get opencode config (only model field for now)
  app.get("/api/opencode/config", async () => {
    const config = readConfig();
    return {
      model: (config.model as string) || "",
    };
  });

  // Update opencode config
  app.put("/api/opencode/config", async (req, reply) => {
    const input = opencodeConfigUpdateSchema.parse(req.body);
    const config = readConfig();

    if (input.model !== undefined) {
      config.model = input.model || undefined; // empty string → remove field
    }

    writeConfig(config);

    return {
      model: (config.model as string) || "",
    };
  });
}
