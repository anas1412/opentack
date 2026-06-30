/**
 * Shared prompt improvement logic.
 *
 * Uses @opencode-ai/sdk for all API calls (session create, prompt, messages).
 * Temp sessions are kept in opencode's DB so their cost data persists.
 */
import { createSdkClient } from "./opencode-client";

// ─── Send to session ──────────────────────────────────────────────────

/**
 * Send a text message to an opencode session.
 * Default `noReply=true` (fire-and-forget — response comes via SSE).
 * Pass `noReply=false` to block until AI responds.
 */
export async function sendToSession(
  port: number,
  repoPath: string,
  sessionId: string,
  text: string,
  retries = 3,
  noReply = true,
): Promise<void> {
  const client = createSdkClient(port);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await client.session.prompt({
        sessionID: sessionId,
        directory: repoPath,
        noReply,
        parts: [{ type: "text", text }],
      });
      return;
    } catch (e) {
      if (attempt === retries - 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── Prompt improvement ────────────────────────────────────────────────

/**
 * Generate an improved prompt using a temporary opencode session.
 *
 * 1. Creates a temp session on the same server
 * 2. Sends the improvement prompt (AI rewrites it)
 * 3. Reads the AI response (SDK prompt handles waiting internally)
 * 4. Sends improved text to the real session
 *
 * The temp session is kept — its cost data persists in opencode's DB.
 *
 * @param options.model Optional model override for the temp session
 * @param options.agent Optional agent override for the temp session
 * @param options.onInjecting Called right before improved prompt is sent
 */
export async function generateAndSendImprovedPrompt(
  port: number,
  repoPath: string,
  opencodeSessionId: string,
  description: string,
  options?: {
    model?: { providerID: string; id: string };
    agent?: string;
    onInjecting?: () => void;
  },
): Promise<void> {
  const { model, agent, onInjecting } = options ?? {};
  const tempLabel = `improve-${crypto.randomUUID().slice(0, 8)}`;
  const client = createSdkClient(port);

  try {
    // 1. Create a temporary session on the same server
    const createResult = await client.session.create({
      directory: repoPath,
      title: tempLabel,
      ...(model ? { model: { providerID: model.providerID, id: model.id } } : {}),
      ...(agent ? { agent } : {}),
    });
    const tempSession = createResult.data as any;
    const tempSessionId = tempSession?.id ?? (createResult as any).id;
    if (!tempSessionId) throw new Error("Failed to get temp session ID");

    // 2. Build improvement prompt
    const improvementPrompt = `Make this description clearer. Do NOT use tools or read files. Output ONLY the clearer version.

Original:
${description}

Clearer version:`;

    // 3. Send to temp session — SDK handles streaming internally,
    //    prompt() resolves when AI finishes
    await client.session.prompt({
      sessionID: tempSessionId,
      directory: repoPath,
      parts: [{ type: "text", text: improvementPrompt }],
    });

    // 4. Read the AI response
    const msgResult = await client.session.messages({ sessionID: tempSessionId });
    const messages = Array.isArray(msgResult.data) ? msgResult.data : [];
    const improved = messages
      .filter((m: any) => m.info?.role === "assistant")
      .flatMap((m: any) => m.parts ?? [])
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text!.trim())
      .filter(Boolean)
      .join("\n");

    // 5. Inject the improved prompt into the real session (fire-and-forget).
    //    noReply=false triggers AI response — result arrives via SSE.
    onInjecting?.();
    sendToSession(port, repoPath, opencodeSessionId, improved || description, 3, false).catch(() => {});

    // Temp session kept — cost data persists in opencode DB, no need for saveCost
  } catch (err) {
    console.warn("[prompt-improver] Failed to generate improved prompt, sending raw description:", (err as Error).message);
    onInjecting?.();
    sendToSession(port, repoPath, opencodeSessionId, description, 3, false).catch(() => {});
  }
}
