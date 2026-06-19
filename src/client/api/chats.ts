import { apiFetch } from "./client";

export interface ChatSession {
  id: string;
  cwd: string;
  serverPort: number | null;
  opencodeSessionId: string | null;
  createdAt: number;
  endedAt: number | null;
}

export interface ChatCreateResponse {
  id: string;
  opencodePort: number;
  cwd: string;
  opencodeSessionId: string;
  repoName: string;
}

export function createChat(repoId: string): Promise<ChatCreateResponse> {
  return apiFetch("/api/chats", {
    method: "POST",
    body: JSON.stringify({ repoId }),
  });
}

export function fetchChats(): Promise<ChatSession[]> {
  return apiFetch("/api/chats");
}

export function fetchChat(id: string): Promise<ChatSession> {
  return apiFetch(`/api/chats/${id}`);
}

export function stopChat(id: string): Promise<void> {
  return apiFetch(`/api/chats/${id}/stop`, { method: "POST" });
}
