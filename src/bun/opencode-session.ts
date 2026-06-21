/**
 * Opencode model — providers are e.g. "opencode", "anthropic", "openai".
 * IDs are e.g. "big-pickle", "claude-sonnet-4-20250514", "gpt-4o".
 */
export interface OpencodeModel {
  providerID: string
  id: string
}

/** Parse "providerID/id" string into OpencodeModel. Returns undefined if invalid. */
export function parseModel(modelStr: string): OpencodeModel | undefined {
  if (!modelStr) return undefined
  const parts = modelStr.split("/")
  if (parts.length === 2) return { providerID: parts[0], id: parts[1] }
  if (parts.length === 1) return { providerID: "", id: parts[0] }
  return undefined
}

/**
 * Create an opencode session on the running server.
 *
 * @param port - opencode server port
 * @param repoPath - absolute path to the repo
 * @param title - session title
 * @param model - model to use (from OpenTack settings). If omitted, no model is sent.
 * @param retries - retry on failure (default 1 = no retry, delay 500ms between attempts)
 * @returns opencode session ID
 */
export async function createOpencodeSession(
  port: number,
  repoPath: string,
  title: string,
  retries = 1,
  model?: OpencodeModel,
): Promise<string> {
  const body: Record<string, unknown> = { title }
  if (model) body.model = model

  const url = `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(repoPath)}`
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const data = await resp.json() as { id: string }
        return data.id
      }
      // Non-ok response on last attempt — throw immediately
      if (attempt === retries - 1) {
        const text = await resp.text().catch(() => "unknown")
        throw new Error(`Failed to create opencode session: ${resp.status} ${text.slice(0, 200)}`)
      }
    } catch (e) {
      if (attempt === retries - 1) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("Failed to create opencode session: no response")
}
