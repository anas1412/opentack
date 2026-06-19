import { EventEmitter } from "events";

export type SseEvent =
  | { type: "session.started"; sessionId: string; ticketId: string | null }
  | { type: "session.stopped"; sessionId: string; ticketId: string | null }
  | { type: "session.ended"; sessionId: string; ticketId: string | null; exitCode: number | null }
  | { type: "session.cost"; sessionId: string; ticketId: string | null; costUsd: number; tokens: number }
  | { type: "session.improving_done"; sessionId: string; ticketId: string | null }
  | { type: "ticket.created"; ticketId: string }
  | { type: "ticket.updated"; ticketId: string }
  | { type: "ticket.deleted"; ticketId: string }
  | { type: "session.file_changed"; sessionId: string; file: string }
  | { type: "pr.created"; sessionId: string; ticketId: string; prUrl: string }
  | { type: "ticket.resolved"; ticketId: string }
  | { type: "system.opencode_upgraded"; version: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export const sseEmitter = emitter;
export const SSE_EVENT = "sse";

export function emitSse(event: SseEvent): void {
  emitter.emit(SSE_EVENT, event);
}
