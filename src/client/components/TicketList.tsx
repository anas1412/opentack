import { useState, useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTickets, useDeleteTicket, useBatchUpdateTickets, useBatchDeleteTickets } from "../hooks/useTickets";
import { useRepos } from "../hooks/useRepos";
import type { Ticket, TicketStatus } from "../../shared/types";
import { TICKET_STATUSES } from "../../shared/types";
import { Trash2, X, Check } from "lucide-react";

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

interface TicketListProps {
  repoId?: string;
  search?: string;
  status?: string;
  priority?: string;
  category?: string;
}

export default function TicketList(_props: TicketListProps) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const repoId = search.repoId as string | undefined;
  const { data, isLoading, isError, error } = useTickets({ repoId });
  const { data: repos } = useRepos();
  const deleteTicket = useDeleteTicket();
  const batchUpdate = useBatchUpdateTickets();
  const batchDelete = useBatchDeleteTickets();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const repoMap = new Map(repos?.map((r) => [r.id, r.name]) ?? []);

  const tickets = data?.tickets ?? [];
  const anySelected = selectedIds.size > 0;
  const allSelected = tickets.length > 0 && selectedIds.size === tickets.length;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tickets.map((t) => t.id)));
    }
  }, [tickets, allSelected]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBatchStatus = useCallback(async (newStatus: string) => {
    await batchUpdate.mutateAsync({ ids: Array.from(selectedIds), input: { status: newStatus as TicketStatus } });
    clearSelection();
  }, [selectedIds, batchUpdate, clearSelection]);

  const handleBatchDelete = useCallback(async () => {
    await batchDelete.mutateAsync(Array.from(selectedIds));
    clearSelection();
  }, [selectedIds, batchDelete, clearSelection]);

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

  async function handleDelete(e: React.MouseEvent, ticketId: string) {
    e.stopPropagation();
    await deleteTicket.mutateAsync(ticketId);
    setDeletingId(null);
  }

  return (
    <div>
      {/* Batch action bar */}
      {anySelected && (
        <div className="flex items-center gap-3 px-4 py-2 mb-3 bg-zinc-800/60 border border-zinc-700 rounded-lg text-sm">
          <span className="text-zinc-300 font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-1.5">
            <select
              onChange={(e) => { if (e.target.value) handleBatchStatus(e.target.value); e.target.value = ""; }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              defaultValue=""
            >
              <option value="" disabled>Set status…</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace("_", " ")}</option>
              ))}
            </select>
            <button
              onClick={handleBatchDelete}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={12} />
              Delete
            </button>
          </div>
          <button
            onClick={clearSelection}
            className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-500 text-xs uppercase tracking-wider">
              <th className="pb-3 pr-3 w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="accent-checkbox cursor-pointer"
                />
              </th>
              <th className="pb-3 pr-4 font-medium">Status</th>
              <th className="pb-3 pr-4 font-medium">Title</th>
              <th className="pb-3 pr-4 font-medium">Repo</th>
              <th className="pb-3 pr-4 font-medium">Branch</th>
              <th className="pb-3 pr-4 font-medium">Category</th>
              <th className="pb-3 pr-4 font-medium text-right">Tokens</th>
              <th className="pb-3 pr-4 font-medium text-right">Cost</th>
              <th className="pb-3 pr-2 font-medium text-right">Updated</th>
              <th className="pb-3 w-8" />
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => {
              const isSelected = selectedIds.has(ticket.id);
              return (
                <tr
                  key={ticket.id}
                  onClick={() => navigate({ to: `/tickets/${ticket.id}` })}
                  className={`border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer transition-colors group ${
                    isSelected ? "row-accent" : ""
                  }`}
                >
                  <td className="py-3 pr-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(ticket.id)}
                      className="accent-checkbox cursor-pointer"
                    />
                  </td>
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
                  <td className="py-3 pr-4 font-mono text-xs text-zinc-500 max-w-[140px] truncate">
                    {ticket.branch}
                  </td>
                  <td className={`py-3 pr-4 ${CATEGORY_COLORS[ticket.category]}`}>
                    {ticket.category}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-zinc-400">
                    {ticket.totalTokens.toLocaleString()}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-zinc-300">
                    {formatCost(ticket.totalCostUsd)}
                  </td>
                  <td className="py-3 pr-2 text-right text-zinc-500">
                    {timeAgo(ticket.updatedAt)}
                  </td>
                  <td className="py-3">
                    {deletingId === ticket.id ? (
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={(e) => handleDelete(e, ticket.id)}
                          className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeletingId(null); }}
                          className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeletingId(ticket.id); }}
                        className="p-1 rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
