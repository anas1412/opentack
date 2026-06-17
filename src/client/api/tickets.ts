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
  repoId?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function fetchTickets(params?: TicketListParams): Promise<TicketListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
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
