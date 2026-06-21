import { request } from "./rpc-client"

export interface RecentSessionItem {
  id: string
  ticketId: string
  ticketTitle: string
  repoId: string
  repoName: string
  model: string
  opencodeSessionId: string | null
  totalTokens: number
  costUsd: number
  createdAt: number
  endedAt: number | null
  durationMs: number | null
  exitCode: number | null
  exitReason: string | null
}

export interface RecentSessionsParams {
  limit?: number
  repoId?: string
}

export function fetchRecentSessions(params?: RecentSessionsParams): Promise<RecentSessionItem[]> {
  return request("recentSessions", { limit: params?.limit, repoId: params?.repoId }).then((sessions) =>
    sessions.map((s) => ({
      id: s.id,
      ticketId: s.ticketId ?? "",
      ticketTitle: s.ticketTitle ?? "",
      repoId: s.repoId ?? "",
      repoName: s.repoName ?? "",
      model: s.model,
      opencodeSessionId: s.opencodeSessionId,
      totalTokens: s.totalTokens,
      costUsd: s.costUsd,
      createdAt: s.createdAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      exitCode: s.exitCode,
      exitReason: s.exitReason,
    })),
  )
}

export function sendSessionMessage(sessionId: string, text: string): Promise<void> {
  return request("sendSessionMessage", { id: sessionId, text })
}
