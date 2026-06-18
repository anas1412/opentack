import { apiFetch } from "./client";
import type {
  Ticket,
  TicketCreateInput,
  TicketUpdateInput,
} from "../../shared/types";

interface TicketListResponse {
  tickets: Ticket[];
  total: number;
  limit: number;
  offset: number;
}

interface TicketListParams {
  status?: string;
  priority?: string;
  repoId?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function fetchTickets(params?: TicketListParams): Promise<TicketListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.priority) searchParams.set("priority", params.priority);
  if (params?.repoId) searchParams.set("repoId", params.repoId);
  if (params?.category) searchParams.set("category", params.category);
  if (params?.search) searchParams.set("search", params.search);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));

  const qs = searchParams.toString();
  return apiFetch(`/api/tickets${qs ? `?${qs}` : ""}`);
}

export function fetchTicket(id: string): Promise<Ticket> {
  return apiFetch(`/api/tickets/${id}`);
}

export function createTicket(input: TicketCreateInput): Promise<Ticket> {
  return apiFetch("/api/tickets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTicket(id: string, input: TicketUpdateInput): Promise<Ticket> {
  return apiFetch(`/api/tickets/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteTicket(id: string): Promise<void> {
  return apiFetch(`/api/tickets/${id}`, { method: "DELETE" });
}

export function batchUpdateTickets(ids: string[], input: TicketUpdateInput): Promise<void> {
  return apiFetch("/api/tickets/batch/update", {
    method: "POST",
    body: JSON.stringify({ ids, input }),
  });
}

export function batchDeleteTickets(ids: string[]): Promise<void> {
  return apiFetch("/api/tickets/batch/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function fetchTicketSessions(ticketId: string): Promise<import("../../shared/types").Session[]> {
  return apiFetch(`/api/tickets/${ticketId}/sessions`);
}

export function generateNotes(ticketId: string): Promise<{ notes: string }> {
  return apiFetch(`/api/tickets/${ticketId}/generate-notes`, {
    method: "POST",
  });
}

export function createTicketSession(ticketId: string): Promise<{
  id: string;
  ticketId: string;
  cwd: string;
  branch: string;
  opencodeSessionId?: string | null;
  opencodePort: number;
}> {
  return apiFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ ticketId }),
  });
}

