import { useQuery } from "@tanstack/react-query";
import { fetchCostPerTicket } from "../api/costs";

export function useCostPerTicket(params?: { days?: number; repoId?: string }) {
  return useQuery({
    queryKey: ["costs", "per-ticket", params],
    queryFn: () => fetchCostPerTicket(params),
    staleTime: 60_000,
  });
}
