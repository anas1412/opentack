import { useQuery } from "@tanstack/react-query";
import { fetchCostPerModel } from "../api/costs";

export function useCostPerModel(params?: { days?: number }) {
  return useQuery({
    queryKey: ["costs", "per-model", params],
    queryFn: () => fetchCostPerModel(params),
    staleTime: 60_000,
  });
}
