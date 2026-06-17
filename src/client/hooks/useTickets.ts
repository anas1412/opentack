import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTickets, fetchTicket, createTicket, updateTicket, deleteTicket } from "../api/tickets";
import type { TicketCreateInput, TicketUpdateInput } from "../../shared/types";

// ─── Queries ──────────────────────────────────────────────────────────

export function useTickets(params?: {
  status?: string;
  repoId?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ["tickets", params],
    queryFn: () => fetchTickets(params),
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ["ticket", id],
    queryFn: () => fetchTicket(id!),
    enabled: !!id,
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
