import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { onMessage } from "../api/rpc-client"

type SessionRow = {
  id: string
  exitCode: number | null
  endedAt: number | null
  totalTokens: number
  costUsd: number
  [key: string]: unknown
}

/**
 * RPC message listener that patches React Query caches directly on push events.
 * Replaces the old SSE connection.
 *
 * Call once at app root (under QueryClientProvider).
 */
export function useSse() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(
      onMessage("sessionCost", ({ sessionId, ticketId, costUsd, tokens }) => {
        if (!ticketId) return
        // Patch the ticket's session cache with latest cost/tokens (no refetch)
        queryClient.setQueryData<SessionRow[]>(
          ["ticket", ticketId, "sessions"],
          (old) =>
            old?.map((s) =>
              s.id === sessionId
                ? { ...s, totalTokens: tokens, costUsd }
                : s,
            ),
        )

        // Refresh recent sessions (costs changed)
        queryClient.invalidateQueries({ queryKey: ["sessions", "recent"] })
        // Refresh ticket detail (files changed may have updated)
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] })
      }),
    )

    unsubs.push(
      onMessage("sessionStopped", ({ sessionId, ticketId }) => {
        if (!ticketId) return
        // Mark session inactive in cache
        queryClient.setQueryData<SessionRow[]>(
          ["ticket", ticketId, "sessions"],
          (old) =>
            old?.map((s) =>
              s.id === sessionId
                ? { ...s, exitCode: 0, endedAt: Date.now() }
                : s,
            ),
        )

        // Refresh ticket list (active session changed)
        queryClient.invalidateQueries({ queryKey: ["tickets"] })
        queryClient.invalidateQueries({ queryKey: ["sessions", "recent"] })
        // Refresh ticket detail (files changed may have updated)
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] })
      }),
    )

    unsubs.push(
      onMessage("sessionStarted", ({ ticketId }) => {
        queryClient.invalidateQueries({ queryKey: ["tickets"] })
        queryClient.invalidateQueries({ queryKey: ["sessions", "recent"] })
        if (ticketId) {
          queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] })
        }
      }),
    )

    unsubs.push(
      onMessage("ticketCreated", () => {
        queryClient.invalidateQueries({ queryKey: ["tickets"] })
      }),
    )

    unsubs.push(
      onMessage("ticketUpdated", ({ ticketId }) => {
        queryClient.invalidateQueries({ queryKey: ["tickets"] })
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] })
      }),
    )

    unsubs.push(
      onMessage("ticketDeleted", () => {
        queryClient.invalidateQueries({ queryKey: ["tickets"] })
      }),
    )

    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [queryClient])
}
