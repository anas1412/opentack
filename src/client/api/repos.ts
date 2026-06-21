import { request } from "./rpc-client"
import type { Repo, RepoCreateInput, RepoUpdateInput } from "../../shared/types"

export function fetchRepos(): Promise<Repo[]> {
  return request("listRepos")
}

export function fetchRepo(id: string): Promise<Repo> {
  return request("getRepo", { id })
}

export function createRepo(input: RepoCreateInput): Promise<Repo> {
  return request("createRepo", input)
}

export function updateRepo(id: string, input: RepoUpdateInput): Promise<Repo> {
  return request("updateRepo", { id, ...input })
}

export function deleteRepo(id: string): Promise<void> {
  return request("deleteRepo", { id })
}
