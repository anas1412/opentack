import { useQuery } from "@tanstack/react-query";
import { fetchJournal } from "../api/journal";

export function useJournal(offset: number = 0, limit: number = 7, repoId?: string) {
  return useQuery({
    queryKey: ["journal", offset, limit, repoId],
    queryFn: () => fetchJournal(offset, limit, repoId),
    placeholderData: (prev) => prev,
  });
}
