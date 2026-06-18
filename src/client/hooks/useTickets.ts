import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchTickets, fetchTicket, createTicket, updateTicket, deleteTicket,
  fetchTicketSessions, batchUpdateTickets, batchDeleteTickets, generateNotes,
} from "../api/tickets";
import type { TicketCreateInput, TicketUpdateInput } from "../../shared/types";

// ─── Queries ──────────────────────────────────────────────────────────

export function useTickets(params?: {
  status?: string;
  priority?: string;
  repoId?: string;
  category?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ["tickets", params],
    queryFn: () => fetchTickets(params),
    refetchInterval: 3000,
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ["ticket", id],
    queryFn: () => fetchTicket(id!),
    enabled: !!id,
  });
}

export function useTicketSessions(ticketId: string | null) {
  return useQuery({
    queryKey: ["ticket", ticketId, "sessions"],
    queryFn: () => fetchTicketSessions(ticketId!),
    enabled: !!ticketId,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TicketCreateInput) => createTicket(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
      qc.invalidateQueries({ queryKey: ["costs"] });
    },
  });
}

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: TicketUpdateInput }) =>
      updateTicket(id, input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
      qc.invalidateQueries({ queryKey: ["ticket", data.id] });
    },
  });
}

export function useDeleteTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTicket(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

// ─── Batch mutations ───────────────────────────────────────────────────

export function useBatchUpdateTickets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, input }: { ids: string[]; input: TicketUpdateInput }) =>
      batchUpdateTickets(ids, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useBatchDeleteTickets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => batchDeleteTickets(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useGenerateNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => generateNotes(ticketId),
    onSuccess: (data, ticketId) => {
      qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}
