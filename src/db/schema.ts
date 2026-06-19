import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ─── Ticket ───────────────────────────────────────────────────────────

export const ticketStatuses = [
  "open",
  "in_progress",
  "needs_review",
  "changes_requested",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof ticketStatuses)[number];

export const tickets = sqliteTable("ticket", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status", { enum: ticketStatuses }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "medium", "high", "critical"] })
    .notNull()
    .default("medium"),
  category: text("category", {
    enum: ["feature", "bug", "refactor", "chore", "docs"],
  })
    .notNull()
    .default("feature"),

  repoId: text("repo_id").notNull(),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),

  sessionIds: text("session_ids").notNull().default("[]"), // JSON array
  activeSessionId: text("active_session_id"),

  filesChanged: text("files_changed").notNull().default("[]"), // JSON array
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),

  tags: text("tags").notNull().default("[]"), // JSON array
  notes: text("notes").notNull().default(""),

  worktreePath: text("worktree_path"),

  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "number" }),
});

// ─── Session ──────────────────────────────────────────────────────────

export const exitReasons = ["natural", "user_stopped", "error"] as const;
export type ExitReason = (typeof exitReasons)[number];

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id"),

  opencodeVersion: text("opencode_version").notNull(),
  model: text("model").notNull(),
  cwd: text("cwd").notNull(),
  branch: text("branch").notNull(),
  initialPrompt: text("initial_prompt").notNull(),

  // opencode's session ID (ses_xxx) — when null, we haven't created one yet
  opencodeSessionId: text("opencode_session_id"),

  transcript: text("transcript").notNull().default("[]"), // JSON TranscriptEntry[]

  diff: text("diff").notNull().default("[]"), // JSON FileDiff[]
  filesChanged: text("files_changed").notNull().default("[]"), // JSON string[]
  exitCode: integer("exit_code"),
  exitReason: text("exit_reason", { enum: exitReasons }),

  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),

  createdAt: integer("created_at", { mode: "number" }).notNull(),
  endedAt: integer("ended_at", { mode: "number" }),
  durationMs: integer("duration_ms"),

  pid: integer("pid"), // opencode serve process PID (for orphan recovery)
  serverPort: integer("server_port"), // port the opencode serve is listening on

  approved: integer("approved", { mode: "boolean" }), // null = pending
  revisionNote: text("revision_note"),
});

// ─── Repo ─────────────────────────────────────────────────────────────

export const repos = sqliteTable("repo", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  localPath: text("local_path").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  envVars: text("env_vars").notNull().default("{}"), // JSON Record<string, string>

  createdAt: integer("created_at", { mode: "number" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "number" }),
});

// ─── Settings (singleton row) ───────────────────────────────────────────

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(), // always "global"
  forwardDescription: integer("forward_description", { mode: "boolean" })
    .notNull()
    .default(true),
  theme: text("theme").notNull().default("amber"),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ─── App-level overhead costs (notes gen, prompt improvement, etc.) ─────

export const appCost = sqliteTable("app_cost", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // 'improve_prompt' | 'generate_notes'
  ticketId: text("ticket_id"),
  costUsd: real("cost_usd").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

// ─── CostRecord — REMOVED. opencode is the sole source of truth for costs. ─────
