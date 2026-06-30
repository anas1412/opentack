import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun"
import Electrobun from "electrobun/bun"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { isNull } from "drizzle-orm"
import path from "path"
import { db, schema } from "../db"
import { isSessionAlive, registerRecoveredSession, stopAll } from "../server/opencode-manager"
import { startSdkCostWatcher } from "../server/sdk-cost-watcher"
import { sseEmitter, SSE_EVENT } from "../server/sse"
import type { SseEvent } from "../server/sse"
import * as handlers from "./handlers"
import type { OpenTackRPC } from "../shared/rpc"

// ─── RPC Setup ───────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<OpenTackRPC>({
  maxRequestTime: 60000,
  handlers: {
    requests: {
      // Repos
      listRepos: () => handlers.listRepos(),
      getRepo: ({ id }) => handlers.getRepo({ id }),
      createRepo: (input) => handlers.createRepo(input),
      updateRepo: ({ id, ...data }) => handlers.updateRepo({ id, ...data }),
      deleteRepo: ({ id }) => handlers.deleteRepo({ id }),
      cloneRepo: (input) => handlers.cloneRepo(input),

      // Tickets
      listTickets: (params) => handlers.listTickets(params),
      getTicket: ({ id }) => handlers.getTicket({ id }),
      createTicket: (input) => handlers.createTicket(input),
      updateTicket: ({ id, ...data }) => handlers.updateTicket({ id, ...data }),
      deleteTicket: ({ id }) => handlers.deleteTicket({ id }),
      generateNotes: ({ id }) => handlers.generateNotes({ id }),
      batchUpdateTickets: (params) => handlers.batchUpdateTickets(params),
      batchDeleteTickets: ({ ids }) => handlers.batchDeleteTickets({ ids }),

      // Sessions
      recentSessions: (params) => handlers.recentSessions(params),
      ticketSessions: ({ ticketId }) => handlers.ticketSessions({ ticketId }),
      getSession: ({ id }) => handlers.getSession({ id }),
      createSession: ({ ticketId }) => handlers.createSession({ ticketId }),
      stopSession: ({ id }) => handlers.stopSession({ id }),
      improveSession: ({ id, description }) => handlers.improveSession({ id, description }),
      improvingStatus: ({ id }) => handlers.improvingStatus({ id }),
      sendSessionMessage: ({ id, text }) => handlers.sendSessionMessage({ id, text }),
      sessionBranch: ({ id }) => handlers.sessionBranch({ id }),

      // Chats
      createChat: (params) => handlers.createChat(params),
      stopChat: ({ sessionId }) => handlers.stopChat({ sessionId }),
      listChats: () => handlers.listChats(),
      getChat: ({ id }) => handlers.getChat({ id }),

      // Costs
      costSummary: () => handlers.costSummary(),
      costHistory: () => handlers.costHistory(),
      costPerTicket: (params) => handlers.costPerTicket(params),
      costPerModel: (params) => handlers.costPerModel(params),

      // Settings
      getSettings: () => handlers.getSettings(),
      updateSettings: (params) => handlers.updateSettings(params),

      // Opencode Config
      getOpencodeConfig: () => handlers.getOpencodeConfig(),
      updateOpencodeConfig: (params) => handlers.updateOpencodeConfig(params),
      listAgents: () => handlers.listAgents(),
      getOpencodeTuiConfig: () => handlers.getOpencodeTuiConfig(),
      updateOpencodeTuiConfig: (params) => handlers.updateOpencodeTuiConfig(params),

      // Journal
      getJournal: (params) => handlers.getJournal(params),

      // Worktrees
      createWorktree: ({ ticketId }) => handlers.createWorktree({ ticketId }),
      listWorktrees: () => handlers.listWorktrees(),
      removeWorktree: ({ ticketId }) => handlers.removeWorktree({ ticketId }),

      // Version / Updates
      checkUpdates: () => handlers.checkUpdates(),
      downloadUpdate: () => handlers.downloadUpdate(),

      // System
      health: () => handlers.health(),
      pickDirectory: () => handlers.pickDirectory(),
    },
    messages: {
      "*": (name, _payload) => {
        console.log("[rpc message]", name)
      },
    },
  },
})

// ─── Orphan Recovery ─────────────────────────────────────────────────────

async function recoverOrphanedSessions() {
  const active = await db
    .select()
    .from(schema.sessions)
    .where(isNull(schema.sessions.endedAt))

  let recovered = 0
  for (const session of active) {
    if (session.pid != null && session.serverPort != null) {
      if (isSessionAlive(session.pid, session.serverPort, session.cwd)) {
        registerRecoveredSession(session.id, session.serverPort, session.cwd)
        console.log(`[recovery] Session ${session.id} recovered on port ${session.serverPort}`)
        recovered++
      }
    }
  }
  if (recovered > 0) {
    console.log(`[recovery] ${recovered} sessions recovered`)
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────

async function main() {
  // Run DB migrations
  console.log("[opentack] Running database migrations...")
  migrate(db, { migrationsFolder: path.resolve(import.meta.dir, "../drizzle") })

  // Recover orphaned sessions
  await recoverOrphanedSessions()

  // Start background cost watchers:
  //   startSdkCostWatcher — fetches cost data from opencode via SDK
  startSdkCostWatcher(3000)

  // Create main window
  const win = new BrowserWindow({
    title: "OpenTack",
    frame: {
      x: 0,
      y: 0,
      width: 1400,
      height: 900,
    },
    url: "views://mainview/index.html",
    rpc,
  })

  // ─── SSE→RPC Bridge ──────────────────────────────────────────────────
  // Forward internal SSE events to the webview as typed RPC messages.
  // The sseEmitter is used by all handlers and the cost-watcher internally.
  const sseSenders: Record<string, (event: SseEvent) => void> = {
    "session.started": (e) => rpc.send.sessionStarted(e as any),
    "session.stopped": (e) => rpc.send.sessionStopped(e as any),
    "session.ended": (e) => rpc.send.sessionEnded(e as any),
    "session.cost": (e) => rpc.send.sessionCost(e as any),
    "session.improving.done": (e) => rpc.send.sessionImprovingDone(e as any),
    "session.improving_done": (e) => rpc.send.sessionImprovingDone(e as any),
    "session.file_changed": (e) => rpc.send.sessionFileChanged(e as any),
    "ticket.created": (e) => rpc.send.ticketCreated(e as any),
    "ticket.updated": (e) => rpc.send.ticketUpdated(e as any),
    "ticket.deleted": (e) => rpc.send.ticketDeleted(e as any),
    "ticket.resolved": (e) => rpc.send.ticketResolved(e as any),
    "pr.created": (e) => rpc.send.prCreated(e as any),
    "system.opencode_upgraded": (e) => rpc.send.opencodeUpgraded(e as any),
  }
  const sseBridge = (event: SseEvent) => {
    sseSenders[event.type]?.(event)
  }
  sseEmitter.on(SSE_EVENT, sseBridge)

  // Handle menu actions
  Electrobun.events.on("application-menu-clicked", (e) => {
    const { action } = e.data
    switch (action) {
      case "new-ticket":
        // Send message to webview to open new ticket modal
        win.webview.rpc?.send.notify({ type: "new-ticket", data: null })
        break
      case "open-settings":
        win.webview.rpc?.send.notify({ type: "navigate", data: "/settings" })
        break
      case "about":
        win.webview.rpc?.send.notify({ type: "about", data: null })
        break
    }
  })

  // Clean up on quit
  Electrobun.events.on("before-quit", async () => {
    console.log("[opentack] Shutting down...")
    sseEmitter.off(SSE_EVENT, sseBridge)
    stopAll()
  })
}

main().catch((err) => {
  console.error("[opentack] Fatal error:", err)
  process.exit(1)
})
