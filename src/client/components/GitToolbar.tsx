import { useState } from "react";
import {
  GitCommitHorizontal,
  GitMerge,
  Upload,
  GitPullRequest,
  RefreshCw,
  Wrench,
  MessageCircle,
  Loader2,
} from "lucide-react";
import { sendSessionMessage } from "../api/sessions";

interface GitToolbarProps {
  sessionId: string | null;
}

type ActionId = "commit" | "push" | "merge" | "pr" | "sync" | "fix" | "explain";

interface Action {
  id: ActionId;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  prompt?: string;
}

export default function GitToolbar({ sessionId }: GitToolbarProps) {
  const [loading, setLoading] = useState<ActionId | null>(null);

  const actions: Action[] = [
    {
      id: "commit",
      label: "Commit",
      icon: <GitCommitHorizontal size={14} />,
      enabled: true,
      prompt: "commit changes",
    },
    {
      id: "push",
      label: "Push",
      icon: <Upload size={14} />,
      enabled: true,
      prompt: "push changes",
    },
    {
      id: "merge",
      label: "Merge",
      icon: <GitMerge size={14} />,
      enabled: false,
    },
    {
      id: "pr",
      label: "Create PR",
      icon: <GitPullRequest size={14} />,
      enabled: false,
    },
    {
      id: "sync",
      label: "Sync Branch",
      icon: <RefreshCw size={14} />,
      enabled: false,
    },
    {
      id: "fix",
      label: "Fix Code",
      icon: <Wrench size={14} />,
      enabled: true,
      prompt: "Fix any issues or bugs in the code I'm looking at",
    },
    {
      id: "explain",
      label: "Explain",
      icon: <MessageCircle size={14} />,
      enabled: true,
      prompt: "Explain in simple terms and briefly, I have adhd",
    },
  ];

  async function handleClick(action: Action) {
    if (!sessionId || !action.enabled || loading || !action.prompt) return;
    setLoading(action.id);
    try {
      await sendSessionMessage(sessionId, action.prompt);
    } catch {
      // Error handled silently — the iframe will show any response
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/95 px-2 py-1.5 flex items-center gap-1 overflow-x-auto">
      {actions.map((action) => {
        const isLoading = loading === action.id;
        const disabled = !action.enabled || loading !== null;
        return (
          <button
            key={action.id}
            onClick={() => handleClick(action)}
            disabled={disabled}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors shrink-0 ${
              isLoading
                ? "text-amber-400 bg-amber-500/10"
                : action.enabled
                  ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  : "text-zinc-600 cursor-not-allowed"
            }`}
            title={
              !action.enabled
                ? "Coming soon"
                : isLoading
                  ? "Running..."
                  : action.label
            }
          >
            {isLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              action.icon
            )}
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
