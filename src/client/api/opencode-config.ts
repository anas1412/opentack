import { request } from "./rpc-client"
import type { OpencodeConfig, AgentEntry, OpencodeTuiConfig } from "../../shared/types"

export function fetchOpencodeConfig(): Promise<OpencodeConfig> {
  return request("getOpencodeConfig")
}

export function updateOpencodeConfig(input: OpencodeConfig): Promise<OpencodeConfig> {
  return request("updateOpencodeConfig", input)
}

export function fetchAgents(): Promise<AgentEntry[]> {
  return request("listAgents")
}

export function fetchOpencodeTuiConfig(): Promise<OpencodeTuiConfig> {
  return request("getOpencodeTuiConfig")
}

export function updateOpencodeTuiConfig(input: OpencodeTuiConfig): Promise<OpencodeTuiConfig> {
  return request("updateOpencodeTuiConfig", input)
}
