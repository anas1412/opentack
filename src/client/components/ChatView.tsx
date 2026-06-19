import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { chatRoute } from "../router";
import { fetchChat, stopChat } from "../api/chats";
import { Square, Loader2, ArrowLeft } from "lucide-react";

/** UTF-8 → base64, matching opencode's pt() for directory slugs */
function encodeDirSlug(dir: string): string {
  const bytes = new TextEncoder().encode(dir);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export default function ChatView() {
  const { chatId } = useParams({ from: chatRoute.id });
  const navigate = useNavigate();
  const [cwd, setCwd] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "active" | "stopped" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chatId) return;
    let active = true;

    // Fetch existing chat details
    fetchChat(chatId)
      .then((chat) => {
        if (!active) return;
        if (chat.endedAt) {
          setPhase("stopped");
          return;
        }
        setCwd(chat.cwd);
        setPort(chat.serverPort);
        setOpencodeSessionId(chat.opencodeSessionId);
        setPhase("active");
      })
      .catch((err) => {
        if (active) {
          setError(err.message || "Failed to load chat");
          setPhase("error");
        }
      });

    return () => { active = false; };
  }, [chatId]);

  const opencodeUrl =
    port && cwd && opencodeSessionId
      ? `http://127.0.0.1:${port}/${encodeDirSlug(cwd)}/session/${opencodeSessionId}`
      : null;

  const handleStop = async () => {
    try {
      await stopChat(chatId);
    } catch {}
    navigate({ to: "/" });
  };

  const handleBack = () => navigate({ to: "/" });

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-4 border-b border-zinc-800 bg-zinc-950 h-9 shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft size={12} />
          Back
        </button>
        <span className="text-xs text-zinc-500 font-mono shrink-0">
          chat · {repoName ?? `port ${port}`}
        </span>
        <div className="flex-1" />
        {phase === "active" && (
          <button
            onClick={handleStop}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          >
            <Square size={12} />
            Stop
          </button>
        )}
      </div>

      {/* Iframe or overlay */}
      <div className="flex-1 min-h-0 relative">
        {opencodeUrl && (
          <iframe
            src={opencodeUrl}
            className="w-full h-full border-0"
            title="opencode chat"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}

        {phase === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80">
            <div className="text-center space-y-4">
              <Loader2 size={24} className="mx-auto animate-spin text-blue-400" />
              <p className="text-sm text-zinc-400">Loading chat...</p>
            </div>
          </div>
        )}

        {phase === "stopped" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
            <div className="text-center space-y-4">
              <p className="text-sm text-zinc-400">Chat ended.</p>
              <button
                onClick={handleBack}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium text-zinc-300 transition-colors"
              >
                <ArrowLeft size={14} />
                Back
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
            <div className="text-center space-y-4">
              <p className="text-sm text-red-400">{error || "Failed to load chat"}</p>
              <button
                onClick={handleBack}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium text-zinc-300 transition-colors"
              >
                <ArrowLeft size={14} />
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
