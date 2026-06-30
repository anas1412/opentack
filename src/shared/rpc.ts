import type { RPCSchema } from "electrobun/view"
import type {
  Ticket,
  TicketCreateInput,
  TicketUpdateInput,
  Repo,
  RepoCreateInput,
  RepoUpdateInput,
  Session,
  Settings,
  CostSummary,
  OpencodeConfig,
  OpencodeTuiConfig,
  AgentEntry,
  JournalResponse,
  CheckUpdatesResponse,
  DownloadUpdateResponse,
} from "./types"

/**
 * RPC type definitions for OpenTack's main<->renderer communication.
 *
 * Mirror of all current REST API endpoints, converted to typed RPC calls.
 */
export type OpenTackRPC = {
  bun: RPCSchema<{
    requests: {
      // ─── Health ──────────────────────────────────────────────
      health: { params: void; response: { status: string; version: string } }

      // ─── Repos ──────────────────────────────────────────────
      listRepos: { params: void; response: Repo[] }
      getRepo: { params: { id: string }; response: Repo }
      createRepo: { params: RepoCreateInput; response: Repo }
      updateRepo: { params: { id: string } & RepoUpdateInput; response: Repo }
      deleteRepo: { params: { id: string }; response: void }
      cloneRepo: { params: { gitUrl: string; name?: string }; response: Repo }

      // ─── Tickets ────────────────────────────────────────────
      listTickets: {
        params: {
          status?: string
          priority?: string
          repoId?: string
          category?: string
          search?: string
          limit?: number
          offset?: number
        }
        response: { tickets: Ticket[]; total: number; limit: number; offset: number }
      }
      getTicket: { params: { id: string }; response: Ticket }
      createTicket: { params: TicketCreateInput; response: Ticket }
      updateTicket: { params: { id: string } & TicketUpdateInput; response: Ticket }
      deleteTicket: { params: { id: string }; response: void }
      generateNotes: { params: { id: string }; response: { notes: string; costUsd: number } }
      batchUpdateTickets: {
        params: { ids: string[]; status?: string; priority?: string; category?: string }
        response: void
      }
      batchDeleteTickets: { params: { ids: string[] }; response: void }

      // ─── Sessions ───────────────────────────────────────────
      recentSessions: {
        params: { limit?: number; offset?: number; repoId?: string }
        response: Array<
          Session & {
            ticketTitle: string | null
            repoId: string | null
            repoName: string | null
          }
        >
      }
      ticketSessions: { params: { ticketId: string }; response: Session[] }
      getSession: { params: { id: string }; response: Session }
      createSession: {
        params: { ticketId: string }
        response: {
          sessionId: string
          opencodePort: number
          cwd: string
          branch: string
          opencodeSessionId: string | null
          forwardEnabled: boolean
        }
      }
      stopSession: { params: { id: string }; response: void }
      improveSession: { params: { id: string; description?: string }; response: void }
      improvingStatus: { params: { id: string }; response: { improving: boolean } }
      sendSessionMessage: { params: { id: string; text: string }; response: void }
      sessionBranch: { params: { id: string }; response: { branch: string } }

      // ─── Chats (no-ticket sessions) ──────────────────────────
      createChat: {
        params: { repoId: string; model?: string; prompt: string }
        response: {
          sessionId: string
          opencodePort: number
          cwd: string
          opencodeSessionId: string | null
        }
      }
      stopChat: { params: { sessionId: string }; response: void }
      listChats: { params: void; response: Session[] }
      getChat: { params: { id: string }; response: Session }

      // ─── Costs ──────────────────────────────────────────────
      costSummary: { params: void; response: CostSummary }
      costHistory: { params: void; response: Array<{ date: string; costUsd: number; tokens: number; sessionCount: number }> }
      costPerTicket: {
        params: { startDate?: string; endDate?: string; search?: string; repoId?: string }
        response: Array<{
          ticketId: string
          ticketTitle: string
          repoName: string
          models: Array<{ model: string; costUsd: number; tokens: number }>
          totalCostUsd: number
          totalTokens: number
        }>
      }
      costPerModel: {
        params: { startDate?: string; endDate?: string }
        response: Array<{
          model: string
          costUsd: number
          tokens: number
          sessionCount: number
          ticketCount: number
        }>
      }

      // ─── Settings ───────────────────────────────────────────
      getSettings: { params: void; response: Settings }
      updateSettings: { params: Partial<Settings>; response: Settings }

      // ─── Opencode Config ────────────────────────────────────
      getOpencodeConfig: { params: void; response: OpencodeConfig }
      updateOpencodeConfig: { params: Partial<OpencodeConfig>; response: OpencodeConfig }
      listAgents: { params: void; response: AgentEntry[] }
      getOpencodeTuiConfig: { params: void; response: OpencodeTuiConfig }
      updateOpencodeTuiConfig: { params: OpencodeTuiConfig; response: OpencodeTuiConfig }

      // ─── Journal ────────────────────────────────────────────
      getJournal: { params: { offset?: number; limit?: number; repoId?: string }; response: JournalResponse }

      // ─── Worktrees ──────────────────────────────────────────
      createWorktree: { params: { ticketId: string }; response: void }
      listWorktrees: { params: void; response: Ticket[] }
      removeWorktree: { params: { ticketId: string }; response: void }

      // ─── Version / Updates ────────────────────────────────
      checkUpdates: { params: void; response: CheckUpdatesResponse }
      downloadUpdate: { params: void; response: DownloadUpdateResponse }

      // ─── System dialogs ────────────────────────────────────
      pickDirectory: { params: void; response: string | null }
    }
  }>
  webview: RPCSchema<{
    // Main → Renderer events (bun pushes these to webview)
    messages: {
      sessionStarted: { sessionId: string; ticketId: string | null }
      sessionStopped: { sessionId: string; ticketId: string | null }
      sessionEnded: { sessionId: string; ticketId: string | null; exitCode: number | null }
      sessionCost: { sessionId: string; ticketId: string | null; costUsd: number; tokens: number }
      sessionImprovingDone: { sessionId: string; ticketId: string | null }
      sessionFileChanged: { sessionId: string; file: string }
      ticketCreated: { ticketId: string }
      ticketUpdated: { ticketId: string }
      ticketDeleted: { ticketId: string }
      ticketResolved: { ticketId: string }
      prCreated: { sessionId: string; ticketId: string; prUrl: string }
      opencodeUpgraded: { version: string }
      notify: { type: string; data: unknown }
    }
  }>
}
