import { request } from "./rpc-client"

export interface WorktreeInfo {
  id: string
  title: string
  branch: string
  repoId: string
  worktreePath: string | null
  status: string
  worktreeExists: boolean
}

export function createWorktree(ticketId: string): Promise<void> {
  return request("createWorktree", { ticketId })
}

export function fetchWorktrees(): Promise<WorktreeInfo[]> {
  return request("listWorktrees").then((tickets) =>
    tickets.map((t) => ({
      id: t.id,
      title: t.title,
      branch: t.branch,
      repoId: t.repoId,
      worktreePath: t.worktreePath,
      status: t.status,
      worktreeExists: !!t.worktreePath,
    })),
  )
}

export function removeWorktree(ticketId: string): Promise<void> {
  return request("removeWorktree", { ticketId })
}
