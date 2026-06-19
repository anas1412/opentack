import { useState, useEffect, useCallback } from "react";
import {
  GitCommitHorizontal,
  GitMerge,
  Upload,
  GitPullRequest,
  RefreshCw,
  Loader2,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import { sendSessionMessage } from "../api/sessions";
import { fetchWorktrees, removeWorktree } from "../api/worktrees";

interface GitToolbarProps {
  sessionId: string | null;
  ticketId: string;
}

type ActionId = "commit" | "push" | "pr" | "merge" | "sync";

interface Action {
  id: ActionId;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  prompt?: string;
}

export default function GitToolbar({ sessionId, ticketId }: GitToolbarProps) {
  const [loading, setLoading] = useState<ActionId | null>(null);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [hasWorktree, setHasWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // Check if a worktree exists for this ticket on mount
  useEffect(() => {
    let cancelled = false;
    fetchWorktrees()
      .then((list) => {
        if (!cancelled) {
          setHasWorktree(list.some((w) => w.id === ticketId));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ticketId]);

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
      prompt: "push the current branch to GitHub",
    },
    {
      id: "sync",
      label: "Sync Branch",
      icon: <RefreshCw size={14} />,
      enabled: true,
      prompt: "sync this branch with the latest main — fetch and rebase",
    },
    {
      id: "pr",
      label: "Create PR",
      icon: <GitPullRequest size={14} />,
      enabled: true,
      prompt: "create a pull request for this branch on GitHub",
    },
    {
      id: "merge",
      label: "Merge",
      icon: <GitMerge size={14} />,
      enabled: true,
      prompt: "merge this branch directly into main and delete the branch — no pull request",
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

  async function handleRemoveWorktree() {
    setWorktreeLoading(true);
    setWorktreeError(null);
    try {
      await removeWorktree(ticketId);
      setHasWorktree(false);
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : "Failed to remove worktree");
    } finally {
      setWorktreeLoading(false);
    }
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/95 px-2 py-1.5 flex items-center gap-1 overflow-x-auto">
      {/* Worktree status + remove (worktree auto-created on session start) */}
      {hasWorktree && (
        <>
          <span className="flex items-center gap-1 px-1.5 text-xs text-emerald-500 shrink-0">
            <CheckCircle2 size={12} />
            Worktree
          </span>
          <button
            onClick={handleRemoveWorktree}
            disabled={worktreeLoading}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 disabled:opacity-40"
            title="Remove worktree + delete branch"
          >
            {worktreeLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            Remove
          </button>
          <span className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
        </>
      )}

      {worktreeError && (
        <span className="text-xs text-red-400 shrink-0 px-1" title={worktreeError}>
          Error
        </span>
      )}

      {/* Git / opencode actions */}
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
