import { request } from "./rpc-client"
import type {
  Ticket,
  TicketCreateInput,
  TicketUpdateInput,
} from "../../shared/types"

interface TicketListResponse {
  tickets: Ticket[]
  total: number
  limit: number
  offset: number
}

export function fetchTickets(params?: {
  status?: string
  priority?: string
  repoId?: string
  category?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<TicketListResponse> {
  return request("listTickets", params ?? {}) as Promise<TicketListResponse>
}

export function fetchTicket(id: string): Promise<Ticket> {
  return request("getTicket", { id })
}

export function createTicket(input: TicketCreateInput): Promise<Ticket> {
  return request("createTicket", input)
}

export function updateTicket(id: string, input: TicketUpdateInput): Promise<Ticket> {
  return request("updateTicket", { id, ...input })
}

export function deleteTicket(id: string): Promise<void> {
  return request("deleteTicket", { id })
}

export function batchUpdateTickets(ids: string[], input: { status?: string; priority?: string; category?: string }): Promise<void> {
  return request("batchUpdateTickets", { ids, ...input })
}

export function batchDeleteTickets(ids: string[]): Promise<void> {
  return request("batchDeleteTickets", { ids })
}

export function fetchTicketSessions(ticketId: string): Promise<import("../../shared/types").Session[]> {
  return request("ticketSessions", { ticketId })
}

export function generateNotes(ticketId: string): Promise<{ notes: string }> {
  return request("generateNotes", { id: ticketId })
}

export function createTicketSession(ticketId: string): Promise<{
  id: string
  ticketId: string
  cwd: string
  branch: string
  opencodeSessionId?: string | null
  opencodePort: number
  forwardEnabled: boolean
}> {
  return request("createSession", { ticketId }).then((r) => ({
    id: r.sessionId,
    ticketId,
    cwd: r.cwd,
    branch: r.branch,
    opencodeSessionId: r.opencodeSessionId,
    opencodePort: r.opencodePort,
    forwardEnabled: r.forwardEnabled,
  }))
}

export function improveSessionPrompt(sessionId: string): Promise<void> {
  return request("improveSession", { id: sessionId })
}
