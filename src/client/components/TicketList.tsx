import { useTickets } from "../hooks/useTickets";
import { useRepos } from "../hooks/useRepos";
import { useAppStore } from "../store/app";
import type { Ticket } from "../../shared/types";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-500/20 text-blue-400",
  in_progress: "bg-amber-500/20 text-amber-400",
  needs_review: "bg-purple-500/20 text-purple-400",
  changes_requested: "bg-red-500/20 text-red-400",
  resolved: "bg-green-500/20 text-green-400",
  closed: "bg-zinc-500/20 text-zinc-400",
};

const CATEGORY_COLORS: Record<string, string> = {
  bug: "text-red-400",
  feature: "text-emerald-400",
  refactor: "text-cyan-400",
  chore: "text-zinc-400",
  docs: "text-blue-400",
};

function formatCost(cost: number): string {
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function TicketList() {
  const { data, isLoading, isError, error } = useTickets();
  const { data: repos } = useRepos();
  const { setSelectedTicketId } = useAppStore();

  const repoMap = new Map(repos?.map((r) => [r.id, r.name]) ?? []);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 bg-zinc-800/50 rounded-md animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400 text-sm">Could not load tickets.</p>
        <p className="text-zinc-500 text-xs mt-1">{(error as Error)?.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 text-xs text-blue-400 hover:text-blue-300 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const tickets = data?.tickets ?? [];

  if (tickets.length === 0) {
    return (
      <div className="text-center text-zinc-500 mt-20">
        <p className="text-lg">No tickets yet</p>
        <p className="text-sm mt-1">
          Create your first ticket — press{" "}
          <kbd className="px-1.5 py-0.5 bg-zinc-800 rounded text-xs">N</kbd>
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-zinc-500 text-xs uppercase tracking-wider">
            <th className="pb-3 pr-4 font-medium">Status</th>
            <th className="pb-3 pr-4 font-medium">Title</th>
            <th className="pb-3 pr-4 font-medium">Repo</th>
            <th className="pb-3 pr-4 font-medium">Category</th>
            <th className="pb-3 pr-4 font-medium text-right">Cost</th>
            <th className="pb-3 font-medium text-right">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr
              key={ticket.id}
              onClick={() => setSelectedTicketId(ticket.id)}
              className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer transition-colors"
            >
              <td className="py-3 pr-4">
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[ticket.status]}`}
                >
                  {ticket.status.replace("_", " ")}
                </span>
              </td>
              <td className="py-3 pr-4 text-zinc-200 font-medium">{ticket.title}</td>
              <td className="py-3 pr-4 text-zinc-400">
                {repoMap.get(ticket.repoId) ?? ticket.repoId.slice(0, 8)}
              </td>
              <td className={`py-3 pr-4 ${CATEGORY_COLORS[ticket.category]}`}>
                {ticket.category}
              </td>
              <td className="py-3 pr-4 text-right font-mono text-zinc-300">
                {formatCost(ticket.totalCostUsd)}
              </td>
              <td className="py-3 text-right text-zinc-500">
                {timeAgo(ticket.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
