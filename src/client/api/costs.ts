import { apiFetch } from "./client";

export interface CostSummary {
  weekTotalUsd: number;
  weekTotalTokens: number;
  sessionCount: number;
  ticketCount: number;
  overheadUsd: number;
  overheadTokens: number;
  perRepo: {
    repoId: string;
    repoName: string;
    usd: number;
    tokens: number;
    sessionCount: number;
  }[];
}

export function fetchCostSummary(): Promise<CostSummary> {
  return apiFetch("/api/costs/summary");
}

export interface CostHistoryEntry {
  date: string;
  totalUsd: number;
  totalTokens: number;
  sessionCount: number;
}

export function fetchCostHistory(): Promise<CostHistoryEntry[]> {
  return apiFetch("/api/costs/history");
}

export interface ModelBreakdown {
  model: string;
  tokens: number;
  cost: number;
  sessionCount: number;
}

export interface CostPerTicketEntry {
  ticketId: string;
  ticketTitle: string;
  repoId: string;
  repoName: string;
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  models: ModelBreakdown[];
}

export function fetchCostPerTicket(params?: { days?: number; repoId?: string }): Promise<CostPerTicketEntry[]> {
  const searchParams = new URLSearchParams();
  if (params?.days) searchParams.set("days", String(params.days));
  if (params?.repoId) searchParams.set("repoId", params.repoId);
  const qs = searchParams.toString();
  return apiFetch(`/api/costs/per-ticket${qs ? `?${qs}` : ""}`);
}

export interface CostPerModelEntry {
  model: string;
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
  ticketCount: number;
}

export function fetchCostPerModel(params?: { days?: number }): Promise<CostPerModelEntry[]> {
  const searchParams = new URLSearchParams();
  if (params?.days) searchParams.set("days", String(params.days));
  const qs = searchParams.toString();
  return apiFetch(`/api/costs/per-model${qs ? `?${qs}` : ""}`);
}
