import { apiFetch } from "./client";
import type { JournalResponse } from "../../shared/types";

export function fetchJournal(offset: number = 0, limit: number = 7, repoId?: string): Promise<JournalResponse> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (repoId) params.set("repoId", repoId);
  return apiFetch(`/api/journal?${params.toString()}`);
}
