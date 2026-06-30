import { useNavigate } from "@tanstack/react-router";
import { useRecentSessions } from "../hooks/useRecentSessions";
import { Clock, Zap, GitBranch, CheckCircle, XCircle, Loader } from "lucide-react";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function statusIcon(session: { exitCode: number | null; exitReason: string | null }) {
  if (session.exitCode === null) {
    return <Loader size={12} className="text-blue-400 animate-spin" />;
  }
  if (session.exitCode === 0) {
    return <CheckCircle size={12} className="text-green-400" />;
  }
  return <XCircle size={12} className="text-red-400" />;
}

interface ActivityTimelineProps {
  repoId?: string;
  limit?: number;
}

export default function ActivityTimeline({ repoId, limit = 20 }: ActivityTimelineProps) {
  const navigate = useNavigate();
  const { data: sessions, isLoading } = useRecentSessions({ repoId, limit });

  if (isLoading) {
    return <p className="text-sm text-zinc-600">Loading activity…</p>;
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-zinc-600">
        <Clock size={24} />
        <p className="text-sm">No recent activity</p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {sessions.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/40 transition-colors group"
        >
          {/* Status dot */}
          <span className="shrink-0">{statusIcon(s)}</span>

          {/* Time */}
          <span className="text-xs text-zinc-600 w-14 shrink-0 font-mono">
            {timeAgo(s.createdAt)}
          </span>

          {/* Ticket title */}
          <button
            onClick={() => navigate({ to: `/tickets/${s.ticketId}`, search: repoId ? { repoId } : {} })}
            className="text-sm text-zinc-300 hover:text-blue-400 transition-colors truncate flex-1 min-w-0 text-left"
          >
            {s.ticketTitle}
          </button>

          {/* Repo badge */}
          <span className="flex items-center gap-1 text-xs text-zinc-500 shrink-0">
            <GitBranch size={10} />
            {s.repoName}
          </span>

          {/* Model */}
          {s.model && s.model !== "unknown" && (
            <span className="text-xs text-zinc-600 shrink-0 font-mono hidden sm:inline">
              {s.model}
            </span>
          )}

          {/* Tokens */}
          <span className="flex items-center gap-1 text-xs text-zinc-600 shrink-0 font-mono">
            <Zap size={10} />
            {s.totalTokens.toLocaleString()}
          </span>

          {/* Duration */}
          {s.durationMs !== null && (
            <span className="text-xs text-zinc-600 shrink-0 font-mono w-16 text-right">
              {formatDuration(s.durationMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
