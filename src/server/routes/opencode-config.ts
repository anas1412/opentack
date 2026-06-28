import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import type { FastifyInstance } from "fastify";
import { opencodeConfigUpdateSchema, opencodeTuiUpdateSchema } from "../validators";
import {
  getOpencodeConfigDir,
  getOpencodeConfigPath,
  getOpencodeTuiPath,
} from "../../paths";

function readConfig(): Record<string, unknown> {
  const path = getOpencodeConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function readTuiConfig(): Record<string, unknown> {
  const path = getOpencodeTuiPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const path = getOpencodeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function writeTuiConfig(config: Record<string, unknown>): void {
  const path = getOpencodeTuiPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

const BUILTIN_AGENTS = [
  { name: "build", description: "Default coding agent", mode: "primary" },
  { name: "plan", description: "Plan-only agent (no edits)", mode: "primary" },
  { name: "general", description: "General-purpose subagent", mode: "subagent" },
  { name: "explore", description: "Code exploration subagent", mode: "subagent" },
  { name: "scout", description: "Context discovery subagent", mode: "subagent" },
];

function listAgents(): { name: string; description?: string; mode?: string }[] {
  const agents: { name: string; description?: string; mode?: string }[] = [];
  const seen = new Set<string>();

  // 1. Built-in agents
  for (const a of BUILTIN_AGENTS) {
    agents.push({ ...a });
    seen.add(a.name);
  }

  // 2. Custom agents from opencode.json agent field
  const config = readConfig();
  const customAgents = config.agent as Record<string, { description?: string; mode?: string }> | undefined;
  if (customAgents) {
    for (const [name, def] of Object.entries(customAgents)) {
      if (!seen.has(name)) {
        agents.push({ name, description: def?.description, mode: def?.mode });
        seen.add(name);
      }
    }
  }

  // 3. Agents from ~/.config/opencode/agents/ (*.md files)
  const globalAgentDir = join(getOpencodeConfigDir(), "agents");
  if (existsSync(globalAgentDir)) {
    try {
      for (const entry of readdirSync(globalAgentDir)) {
        if (entry.endsWith(".md")) {
          const name = entry.slice(0, -3);
          if (!seen.has(name)) {
            agents.push({ name });
            seen.add(name);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Agents from .opencode/agents/ in project directories
  const possibleDirs = [
    join(process.cwd(), ".opencode", "agents"),
  ];
  for (const dir of possibleDirs) {
    if (existsSync(dir)) {
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.endsWith(".md")) {
            const name = entry.slice(0, -3);
            if (!seen.has(name)) {
              agents.push({ name });
              seen.add(name);
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return agents;
}

export function registerOpencodeConfigRoutes(app: FastifyInstance) {
  // Get opencode config
  app.get("/api/opencode/config", async () => {
    const config = readConfig();
    return {
      model: (config.model as string) || "",
      default_agent: (config.default_agent as string) || "",
    };
  });

  // Update opencode config
  app.put("/api/opencode/config", async (req, reply) => {
    const input = opencodeConfigUpdateSchema.parse(req.body);
    const config = readConfig();

    if (input.model !== undefined) {
      config.model = input.model || undefined;
    }
    if (input.default_agent !== undefined) {
      config.default_agent = input.default_agent || undefined;
    }

    writeConfig(config);

    return {
      model: (config.model as string) || "",
      default_agent: (config.default_agent as string) || "",
    };
  });

  // List available agents
  app.get("/api/opencode/agents", async () => {
    return listAgents();
  });

  // Get opencode TUI config (tui.json)
  app.get("/api/opencode/tui-config", async () => {
    const config = readTuiConfig();
    return {
      theme: (config.theme as string) || "opencode",
    };
  });

  // Update opencode TUI config
  app.put("/api/opencode/tui-config", async (req, reply) => {
    const input = opencodeTuiUpdateSchema.parse(req.body);
    const config = readTuiConfig();

    if (input.theme !== undefined) {
      config.theme = input.theme;
    }

    writeTuiConfig(config);

    return {
      theme: (config.theme as string) || "opencode",
    };
  });
}
