import { request } from "./rpc-client"
import type { CostSummary } from "../../shared/types"

export function fetchCostSummary(): Promise<CostSummary> {
  return request("costSummary") as Promise<CostSummary>
}

export interface CostHistoryEntry {
  date: string
  totalUsd: number
  totalTokens: number
  sessionCount: number
}

export function fetchCostHistory(): Promise<CostHistoryEntry[]> {
  return request("costHistory").then((entries) =>
    entries.map((e) => ({
      date: e.date,
      totalUsd: e.costUsd,
      totalTokens: e.tokens,
      sessionCount: 0,
    })),
  )
}

export interface ModelBreakdown {
  model: string
  tokens: number
  cost: number
  sessionCount: number
}

export interface CostPerTicketEntry {
  ticketId: string
  ticketTitle: string
  repoId: string
  repoName: string
  sessionCount: number
  totalTokens: number
  totalCost: number
  models: ModelBreakdown[]
}

export function fetchCostPerTicket(params?: { days?: number; repoId?: string }): Promise<CostPerTicketEntry[]> {
  return request("costPerTicket", {
    startDate: params?.days ? new Date(Date.now() - params.days * 86400000).toISOString() : undefined,
    search: undefined,
    repoId: params?.repoId,
  }).then((entries) =>
    entries.map((e) => ({
      ticketId: e.ticketId,
      ticketTitle: e.ticketTitle,
      repoId: "",
      repoName: e.repoName,
      sessionCount: 0,
      totalTokens: e.totalTokens,
      totalCost: e.totalCostUsd,
      models: e.models.map((m) => ({
        model: m.model,
        tokens: m.tokens,
        cost: m.costUsd,
        sessionCount: 0,
      })),
    })),
  )
}

export interface CostPerModelEntry {
  model: string
  totalCost: number
  totalTokens: number
  sessionCount: number
  ticketCount: number
}

export function fetchCostPerModel(params?: { days?: number }): Promise<CostPerModelEntry[]> {
  return request("costPerModel", {
    startDate: params?.days ? new Date(Date.now() - params.days * 86400000).toISOString() : undefined,
  }).then((entries) =>
    entries.map((e) => ({
      model: e.model,
      totalCost: e.costUsd,
      totalTokens: e.tokens,
      sessionCount: e.sessionCount,
      ticketCount: e.ticketCount,
    })),
  )
}
