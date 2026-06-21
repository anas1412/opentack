import { request } from "./rpc-client"
import type { Settings } from "../../shared/types"

export function fetchSettings(): Promise<Settings> {
  return request("getSettings")
}

export function updateSettings(input: Partial<Settings>): Promise<Settings> {
  return request("updateSettings", input)
}
