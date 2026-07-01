import { Electroview } from "electrobun/view"
import type { OpenTackRPC } from "../../shared/rpc"

/**
 * RPC client — connects to main process via Electrobun's WebSocket bridge.
 * Singleton: import `request` and `onMessage` across all API modules.
 */

type Requests = OpenTackRPC["bun"]["requests"]
type Messages = OpenTackRPC["webview"]["messages"]

// Define & set up RPC (gracefully no-ops outside Electrobun/webview)
const rpc = Electroview.defineRPC<OpenTackRPC>({
  maxRequestTime: 60000,
  handlers: {},
})
new Electroview({ rpc })

/**
 * Typed request-response call to the main process.
 *
 * Usage:
 *   const repos = await request("listRepos")
 *   const ticket = await request("getTicket", { id })
 */
export async function request<M extends keyof Requests>(
  method: M,
  ...[params]: Requests[M] extends { params: infer P }
    ? undefined extends P
      ? [params?: P]
      : [params: P]
    : []
): Promise<Requests[M] extends { response: infer R } ? R : void> {
  // Fallback: if running outside Electrobun (Vite dev, tests), try fetch via localhost
  if (typeof window !== "undefined" && !window.__electrobun) {
    return fallbackFetch(method as string, params as any) as any
  }
  return (rpc as any).request(method, params) as Promise<any>
}

/**
 * Subscribe to messages from the main process (replaces SSE EventSource).
 * Returns a cleanup function (call on unmount).
 */
export function onMessage<N extends keyof Messages>(
  name: N,
  handler: (payload: Messages[N]) => void,
): () => void {
  ;(rpc as any).addMessageListener(name, handler)
  return () => {
    ;(rpc as any).removeMessageListener(name, handler)
  }
}

// ─── Fallback for dev/testing outside Electrobun ──────────────────────
// Maps RPC method names to REST endpoints for the local Fastify server

type RestRoute = { method: string; path: string | ((p: any) => string) }

const REST_MAP: Record<string, RestRoute> = {
  health: { method: "GET", path: "/api/health" },
  listRepos: { method: "GET", path: "/api/repos" },
  getRepo: { method: "GET", path: (p) => `/api/repos/${p.id}` },
  createRepo: { method: "POST", path: "/api/repos" },
  updateRepo: { method: "PUT", path: (p) => `/api/repos/${p.id}` },
  deleteRepo: { method: "DELETE", path: (p) => `/api/repos/${p.id}` },
  cloneRepo: { method: "POST", path: "/api/repos/clone" },
  listTickets: { method: "GET", path: "/api/tickets" },
  getTicket: { method: "GET", path: (p) => `/api/tickets/${p.id}` },
  createTicket: { method: "POST", path: "/api/tickets" },
  updateTicket: { method: "PUT", path: (p) => `/api/tickets/${p.id}` },
  deleteTicket: { method: "DELETE", path: (p) => `/api/tickets/${p.id}` },
  generateNotes: { method: "POST", path: (p) => `/api/tickets/${p.id}/generate-notes` },
  batchUpdateTickets: { method: "POST", path: "/api/tickets/batch/update" },
  batchDeleteTickets: { method: "POST", path: "/api/tickets/batch/delete" },
  recentSessions: { method: "GET", path: "/api/sessions/recent" },
  ticketSessions: { method: "GET", path: (p) => `/api/tickets/${p.ticketId}/sessions` },
  getSession: { method: "GET", path: (p) => `/api/sessions/${p.id}` },
  createSession: { method: "POST", path: "/api/sessions" },
  stopSession: { method: "POST", path: (p) => `/api/sessions/${p.id}/stop` },
  improveSession: { method: "POST", path: (p) => `/api/sessions/${p.id}/improve` },
  improvingStatus: { method: "GET", path: (p) => `/api/sessions/${p.id}/improving` },
  sendSessionMessage: { method: "POST", path: (p) => `/api/sessions/${p.id}/send-message` },
  sessionBranch: { method: "GET", path: (p) => `/api/sessions/${p.id}/branch` },
  createChat: { method: "POST", path: "/api/chats" },
  stopChat: { method: "POST", path: (p) => `/api/chats/${p.sessionId}/stop` },
  listChats: { method: "GET", path: "/api/chats" },
  getChat: { method: "GET", path: (p) => `/api/chats/${p.id}` },
  costSummary: { method: "GET", path: "/api/costs/summary" },
  costHistory: { method: "GET", path: "/api/costs/history" },
  costPerTicket: { method: "GET", path: "/api/costs/per-ticket" },
  costPerModel: { method: "GET", path: "/api/costs/per-model" },
  getSettings: { method: "GET", path: "/api/settings" },
  updateSettings: { method: "PUT", path: "/api/settings" },
  getOpencodeConfig: { method: "GET", path: "/api/opencode/config" },
  updateOpencodeConfig: { method: "PUT", path: "/api/opencode/config" },
  listAgents: { method: "GET", path: "/api/opencode/agents" },
  getOpencodeTuiConfig: { method: "GET", path: "/api/opencode/tui-config" },
  updateOpencodeTuiConfig: { method: "PUT", path: "/api/opencode/tui-config" },
  getJournal: { method: "GET", path: "/api/journal" },
  createWorktree: { method: "POST", path: "/api/worktrees" },
  listWorktrees: { method: "GET", path: "/api/worktrees" },
  removeWorktree: { method: "DELETE", path: (p) => `/api/worktrees/${p.ticketId}` },
  pickDirectory: { method: "GET", path: "/api/system/pick-directory" },
  checkUpdates: { method: "GET", path: "/api/version/check-updates" },
  downloadUpdate: { method: "POST", path: "/api/version/download-update" },
  ghTest: { method: "POST", path: "/api/gh/test" },
  ghInstall: { method: "POST", path: "/api/gh/install" },
  ghAuthStart: { method: "POST", path: "/api/gh/auth/start" },
  ghAuthPoll: { method: "POST", path: (p) => `/api/gh/auth/poll` },
  submitForReview: { method: "POST", path: (p) => `/api/tickets/${p.ticketId}/submit-for-review` },
}

async function fallbackFetch(method: string, params: any): Promise<any> {
  const route = REST_MAP[method]
  if (!route) throw new Error(`No fallback route for RPC method: ${method}`)

  const urlPath = typeof route.path === "function" ? route.path(params) : route.path
  const searchParams = new URLSearchParams()
  const body: Record<string, any> = {}

  // Split params into URL query params (GET) vs body (POST/PUT)
  if (params && route.method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) searchParams.set(k, String(v))
    }
  } else if (params) {
    Object.assign(body, params)
  }

  const qs = searchParams.toString()
  const url = `${urlPath}${qs ? `?${qs}` : ""}`

  const res = await fetch(url, {
    method: route.method,
    headers: route.method !== "GET" ? { "Content-Type": "application/json" } : undefined,
    body: route.method !== "GET" ? JSON.stringify(body) : undefined,
  })

  if (res.status === 204) return undefined
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || "Request failed")
  return data
}
