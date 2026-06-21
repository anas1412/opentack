// ─── Ticket ───────────────────────────────────────────────────────────

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "needs_review",
  "changes_requested",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ["feature", "bug", "refactor", "chore", "docs"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  repoId: string;
  branch: string;
  baseBranch: string;
  sessionIds: string[];
  activeSessionId: string | null;
  filesChanged: string[];
  totalCostUsd: number;
  totalTokens: number;
  tags: string[];
  notes: string;
  worktreePath: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

// ─── Session ──────────────────────────────────────────────────────────

export const EXIT_REASONS = ["natural", "user_stopped", "error"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export interface TranscriptEntry {
  ts: number;
  type: "output" | "input" | "system";
  data: string;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath: string | null;
  additions: number;
  deletions: number;
  patch: string;
  accepted: boolean;
}

export interface Session {
  id: string;
  ticketId: string | null;
  opencodeVersion: string;
  model: string;
  cwd: string;
  branch: string;
  initialPrompt: string;
  opencodeSessionId: string | null;
  transcript: TranscriptEntry[];
  diff: FileDiff[];
  filesChanged: string[];
  exitCode: number | null;
  exitReason: ExitReason | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
  endedAt: number | null;
  durationMs: number | null;
  pid: number | null;
  serverPort: number | null;
  approved: boolean | null;
  revisionNote: string | null;
}

// ─── Repo ─────────────────────────────────────────────────────────────

export interface Repo {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  envVars: Record<string, string>;
  createdAt: number;
  lastUsedAt: number | null;
}

// ─── API types ────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TicketCreateInput {
  title: string;
  description: string;
  repoId: string;
  category: TicketCategory;
  priority: TicketPriority;
  tags?: string[];
  baseBranch?: string;
}

export interface TicketUpdateInput {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  notes?: string;
  tags?: string[];
}

export interface RepoCreateInput {
  name: string;
  localPath: string;
  defaultBranch?: string;
  envVars?: Record<string, string>;
}

export interface RepoUpdateInput {
  name?: string;
  localPath?: string;
  defaultBranch?: string;
  envVars?: Record<string, string>;
}

export interface CostSummary {
  weekTotalUsd: number;
  weekTotalTokens: number;
  ticketCount: number;
  sessionCount: number;
  overheadUsd: number;
  overheadTokens: number;
  perRepo: Array<{
    repoId: string;
    repoName: string;
    usd: number;
    tokens: number;
    sessionCount: number;
  }>;
}

// ─── Settings ──────────────────────────────────────────────────────────

export const THEMES = ["amber", "emerald", "violet", "sky"] as const;
export type Theme = (typeof THEMES)[number];

export interface Settings {
  forwardDescription: boolean;
  theme: Theme;
  model: string; // e.g. "opencode/big-pickle"
}

// ─── Journal ───────────────────────────────────────────

export interface TicketDayInfo {
  id: string;
  title: string;
  notes: string;
  filesChanged: string[];
  branch: string;
  repoName: string;
}

export interface JournalDayResult {
  date: string;
  tickets: TicketDayInfo[];
}

export interface JournalResponse {
  days: JournalDayResult[];
  hasMore: boolean;
}

// ─── Opencode TUI config (tui.json) ─────────────────────────────────────────

export const OPENCODE_THEMES = [
  "system",
  "tokyonight",
  "everforest",
  "ayu",
  "catppuccin",
  "catppuccin-macchiato",
  "gruvbox",
  "kanagawa",
  "nord",
  "matrix",
  "one-dark",
  "opencode",
] as const;
export type OpencodeTheme = (typeof OPENCODE_THEMES)[number];

export interface OpencodeTuiConfig {
  theme?: OpencodeTheme;
}

// ─── Opencode config (opencode.json) ─────────────────────────────────────

export interface OpencodeConfig {
  model?: string;
  default_agent?: string;
}

export interface AgentEntry {
  name: string;
  description?: string;
  mode?: string;
}
