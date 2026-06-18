import { apiFetch } from "./client";
import type { OpencodeConfig } from "../../shared/types";

export function fetchOpencodeConfig(): Promise<OpencodeConfig> {
  return apiFetch<OpencodeConfig>("/api/opencode/config");
}

export function updateOpencodeConfig(input: OpencodeConfig): Promise<OpencodeConfig> {
  return apiFetch<OpencodeConfig>("/api/opencode/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
