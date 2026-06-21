import { z } from "zod";
import { OPENCODE_THEMES } from "../shared/types";

export const repoCreateSchema = z.object({
  name: z.string().min(1).max(128),
  localPath: z.string().default(""),
  defaultBranch: z.string().min(1).default("main"),
  envVars: z.record(z.string()).optional().default({}),
});

export const repoUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  localPath: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  envVars: z.record(z.string()).optional(),
});

export const ticketCreateSchema = z.object({
  title: z.string().min(1).max(256),
  description: z.string().min(1),
  repoId: z.string().uuid(),
  category: z.enum(["feature", "bug", "refactor", "chore", "docs"]),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  tags: z.array(z.string()).optional().default([]),
  baseBranch: z.string().min(1).max(128).optional(),
});

export const ticketUpdateSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).optional(),
  status: z
    .enum(["open", "in_progress", "needs_review", "changes_requested", "resolved", "closed"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  category: z.enum(["feature", "bug", "refactor", "chore", "docs"]).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const settingsUpdateSchema = z.object({
  forwardDescription: z.boolean().optional(),
  theme: z.enum(["amber", "emerald", "violet", "sky"]).optional(),
  model: z.string().min(1).optional(),
});

export const opencodeConfigUpdateSchema = z.object({
  model: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
});

export const opencodeTuiUpdateSchema = z.object({
  theme: z.enum(OPENCODE_THEMES).optional(),
});

export const ticketListQuerySchema = z.object({
  status: z
    .enum(["open", "in_progress", "needs_review", "changes_requested", "resolved", "closed"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  repoId: z.string().uuid().optional(),
  category: z.enum(["feature", "bug", "refactor", "chore", "docs"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
