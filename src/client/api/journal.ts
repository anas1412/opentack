import { request } from "./rpc-client"
import type { JournalResponse } from "../../shared/types"

export function fetchJournal(offset: number = 0, limit: number = 7, repoId?: string): Promise<JournalResponse> {
  return request("getJournal", { offset, limit, repoId })
}
