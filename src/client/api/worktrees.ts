import { apiFetch } from "./client";

export interface WorktreeInfo {
  id: string;
  title: string;
  branch: string;
  repoId: string;
  worktreePath: string | null;
  status: string;
  worktreeExists: boolean;
}

export function createWorktree(ticketId: string): Promise<{ worktreePath: string; branch: string }> {
  return apiFetch("/api/worktrees", {
    method: "POST",
    body: JSON.stringify({ ticketId }),
  });
}

export function fetchWorktrees(): Promise<WorktreeInfo[]> {
  return apiFetch("/api/worktrees");
}

export function removeWorktree(ticketId: string): Promise<void> {
  return apiFetch(`/api/worktrees/${ticketId}`, { method: "DELETE" });
}
