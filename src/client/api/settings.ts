import { apiFetch } from "./client";
import type { Settings } from "../../shared/types";

export function fetchSettings(): Promise<Settings> {
  return apiFetch<Settings>("/api/settings");
}

export function updateSettings(input: Partial<Settings>): Promise<Settings> {
  return apiFetch<Settings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
