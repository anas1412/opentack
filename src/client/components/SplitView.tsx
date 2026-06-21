import { useState, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ticketRoute } from "../router";
import TicketDetail from "./TicketDetail";
import GitToolbar from "./GitToolbar";
import { ArrowLeft, Play, Square, ExternalLink, Loader2 } from "lucide-react";
import { request } from "../api/rpc-client";
import { createTicketSession, fetchTicket, improveSessionPrompt } from "../api/tickets";

type SessionPhase = "idle" | "starting" | "active" | "stopped" | "error";

/** UTF-8 → base64, matching opencode's pt() for directory slugs */
function encodeDirSlug(dir: string): string {
  const bytes = new TextEncoder().encode(dir);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export default function SplitView() {
  const { ticketId } = useParams({ from: ticketRoute.id });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [opencodePort, setOpencodePort] = useState<number | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [overlayText, setOverlayText] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Session URL: /<base64-directory>/session/<session-id>
  // The SPA routes this via :dir parent + /session/:id? child
  const opencodeUrl =
    opencodePort && cwd && opencodeSessionId
      ? `http://127.0.0.1:${opencodePort}/${encodeDirSlug(cwd)}/session/${opencodeSessionId}`
      : null;

  // On ticket switch: don't reset iframe URL state (keeps the iframe alive).
  // Reset only sessionId (for stop) + phase. Overlays hide the transition.
  useEffect(() => {
    if (!ticketId) return;

    setSessionId(null);
    setPhase("starting");
    setError(null);

    let active = true;

    (async () => {
      try {
        const ticket = await fetchTicket(ticketId);
        if (!active) return;

        if (ticket.activeSessionId) {
          setOverlayText("opening opencode");
          const session = await createTicketSession(ticketId);
          if (!active) return;
          setSessionId(session.id);
          setOpencodePort(session.opencodePort);
          setCwd(session.cwd);
          setOpencodeSessionId(session.opencodeSessionId ?? null);
          setForwardEnabled(session.forwardEnabled);
          setOverlayText(null);
          setPhase("active");
          queryClient.invalidateQueries({ queryKey: ["tickets"] });
        } else {
          setOverlayText(null);
          setPhase("idle");
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not resume session");
          setPhase("idle");
        }
      }
    })();

    return () => { active = false; };
  }, [ticketId, queryClient]);

  // Reset iframe loading state whenever the URL changes
  useEffect(() => {
    setIframeLoaded(false);
  }, [opencodeUrl]);

  // Poll current git branch live from the repo while session is active
  useEffect(() => {
    if (!sessionId) { setCurrentBranch(null); return; }
    let active = true;
    const fetchBranch = () =>
      request("sessionBranch", { id: sessionId })
        .then((data) => { if (active) setCurrentBranch(data.branch ?? null); })
        .catch(() => {});
    fetchBranch();
    const interval = setInterval(fetchBranch, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [sessionId]);

  const handleStartSession = useCallback(async () => {
    if (!ticketId || phase === "starting") return;
    setPhase("starting");
    setError(null);

    try {
      setOverlayText("opening opencode");
      const session = await createTicketSession(ticketId);

      setSessionId(session.id);
      setOpencodePort(session.opencodePort);
      setCwd(session.cwd);
      setOpencodeSessionId(session.opencodeSessionId ?? null);
      setForwardEnabled(session.forwardEnabled);

      if (session.forwardEnabled) {
        setOverlayText("creating your prompt");
        await improveSessionPrompt(session.id);
        // RPC response already signals completion — no need for separate event
      }

      setOverlayText(null);
      setPhase("active");
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      setError((err as Error).message || "Failed to start session");
      setPhase("idle");
    }
  }, [ticketId, phase, queryClient]);

  const handleStopSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await request("stopSession", { id: sessionId });
    } catch {
      // ignore
    }
    setPhase("stopped");
    setOpencodePort(null);
    setCwd(null);
    setCurrentBranch(null);
    setOpencodeSessionId(null);
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
  }, [sessionId, queryClient]);

  // After creating a worktree, stop the old session on main then restart on the worktree
  const handleWorktreeCreated = useCallback(async () => {
    if (sessionId) {
      try {
        await request("stopSession", { id: sessionId });
      } catch {}
    }
    // Clear stale state so handleStartSession sees "idle"
    setOpencodePort(null);
    setCwd(null);
    setCurrentBranch(null);
    setOpencodeSessionId(null);
    setPhase("idle");
    // Small delay to let the server cleanup finish, then start fresh
    setTimeout(() => handleStartSession(), 100);
  }, [sessionId, handleStartSession]);

  const handleBack = useCallback(() => {
    window.history.back();
  }, []);

  const sessionActive = phase === "active";

  // Overlay content for the right panel
  let overlay: React.ReactNode = null;
  if (phase === "starting" || (phase === "active" && !iframeLoaded)) {
    overlay = (
      <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 z-10">
        <div className="text-center space-y-4">
          <Loader2 size={24} className="mx-auto animate-spin text-blue-400" />
          <p className="text-sm text-zinc-400">{overlayText ?? "opening opencode"}</p>
        </div>
      </div>
    );
  } else if (phase === "stopped") {
    overlay = (
      <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 z-10">
        <div className="text-center space-y-4">
          <p className="text-sm text-zinc-400">Session ended.</p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium text-zinc-300 transition-colors"
          >
            <ArrowLeft size={14} />
            Back to tickets
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* ── LEFT: ticket detail panel ── */}
      <div className="w-[380px] min-w-[380px] border-r border-zinc-800 flex flex-col bg-zinc-950">
        <HeaderBar onBack={handleBack} />
        <div className="flex-1 overflow-hidden">
          <TicketDetail ticketId={ticketId} onStartSession={handleStartSession} sessionActive={sessionActive} />
        </div>
      </div>

      {/* ── RIGHT: opencode panel ── */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        {/* Top bar — only when we have an active/starting session with a URL */}
        {opencodeUrl && (
          <div className="flex items-center gap-2 px-4 border-b border-zinc-800 bg-zinc-950 h-9">
            <span className="text-xs text-zinc-500 font-mono shrink-0">
              opencode · port {opencodePort}{currentBranch ? ` · ${currentBranch}` : ""}
            </span>
            <div className="flex-1" />
            <GitToolbar sessionId={sessionId} ticketId={ticketId} currentBranch={currentBranch} onWorktreeCreated={handleWorktreeCreated} />
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={opencodeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                <ExternalLink size={12} />
                Open in new tab
              </a>
              <button
                onClick={handleStopSession}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              >
                <Square size={12} />
                Stop
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {/* iframe — always mounted when URL exists */}
          {opencodeUrl && (
            <iframe
              src={opencodeUrl}
              className="w-full h-full border-0"
              title="opencode"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={() => setIframeLoaded(true)}
            />
          )}

          {/* Overlay during transitions */}
          {overlay}

          {/* Idle / error — no URL yet */}
          {!opencodeUrl && !overlay && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <p className="text-sm text-zinc-400">
                  opencode will start working on this ticket
                </p>
                {error && <p className="text-xs text-red-400 max-w-sm">{error}</p>}
                <button onClick={handleStartSession} className="btn-primary-lg">
                  <Play size={16} />
                  Start session
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared back button bar for the left panel */
function HeaderBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 border-b border-zinc-800 h-9">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        <ArrowLeft size={14} />
        Back
      </button>
    </div>
  );
}
