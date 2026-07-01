import { request } from "./rpc-client"
import type { Settings, SettingsUpdateInput } from "../../shared/types"

export function fetchSettings(): Promise<Settings> {
  return request("getSettings")
}

export function updateSettings(input: SettingsUpdateInput): Promise<Settings> {
  return request("updateSettings", input)
}
