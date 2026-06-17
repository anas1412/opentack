import { apiFetch } from "./client";
import type { Repo, RepoCreateInput, RepoUpdateInput } from "../../shared/types";

export function fetchRepos(): Promise<Repo[]> {
  return apiFetch("/api/repos");
}

export function fetchRepo(id: string): Promise<Repo> {
  return apiFetch(`/api/repos/${id}`);
}

export function createRepo(input: RepoCreateInput): Promise<Repo> {
  return apiFetch("/api/repos", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRepo(id: string, input: RepoUpdateInput): Promise<Repo> {
  return apiFetch(`/api/repos/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRepo(id: string): Promise<void> {
  return apiFetch(`/api/repos/${id}`, { method: "DELETE" });
}
