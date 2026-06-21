import { request } from "./rpc-client"

export interface ChatSession {
  id: string
  cwd: string
  serverPort: number | null
  opencodeSessionId: string | null
  createdAt: number
  endedAt: number | null
}

export interface ChatCreateResponse {
  id: string
  opencodePort: number
  cwd: string
  opencodeSessionId: string | null
  repoName: string
}

export function createChat(repoId: string, model?: string, prompt?: string): Promise<ChatCreateResponse> {
  return request("createChat", { repoId, model, prompt: prompt ?? "" }).then((r) => ({
    id: r.sessionId,
    opencodePort: r.opencodePort,
    cwd: r.cwd,
    opencodeSessionId: r.opencodeSessionId,
    repoName: "",
  }))
}

export function fetchChats(): Promise<ChatSession[]> {
  return request("listChats").then((sessions) =>
    sessions.map((s) => ({
      id: s.id,
      cwd: s.cwd,
      serverPort: s.serverPort,
      opencodeSessionId: s.opencodeSessionId,
      createdAt: s.createdAt,
      endedAt: s.endedAt,
    })),
  )
}

export function fetchChat(id: string): Promise<ChatSession> {
  return request("getChat", { id }).then((s) => ({
    id: s.id,
    cwd: s.cwd,
    serverPort: s.serverPort,
    opencodeSessionId: s.opencodeSessionId,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
  }))
}

export function stopChat(id: string): Promise<void> {
  return request("stopChat", { sessionId: id })
}
