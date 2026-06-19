import { useMemo, useState, useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTickets, useUpdateTicket } from "../hooks/useTickets";
import { useRepos } from "../hooks/useRepos";
import { GitBranch, Zap } from "lucide-react";
import type { Ticket, TicketStatus } from "../../shared/types";

const COLUMNS: { status: TicketStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In Progress" },
  { status: "needs_review", label: "Needs Review" },
  { status: "changes_requested", label: "Changes Requested" },
  { status: "resolved", label: "Resolved" },
];

const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-amber-500",
  medium: "bg-blue-500",
  low: "bg-zinc-600",
};

const PRIORITY_BORDERS: Record<string, string> = {
  critical: "border-l-red-500",
  high: "border-l-amber-500",
  medium: "border-l-blue-500",
  low: "border-l-zinc-600",
};

const CATEGORY_COLORS: Record<string, string> = {
  bug: "bg-red-500/15 text-red-400",
  feature: "bg-emerald-500/15 text-emerald-400",
  refactor: "bg-cyan-500/15 text-cyan-400",
  chore: "bg-zinc-500/15 text-zinc-400",
  docs: "bg-blue-500/15 text-blue-400",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  open: "bg-blue-500",
  in_progress: "bg-amber-500",
  needs_review: "bg-purple-500",
  changes_requested: "bg-red-500",
  resolved: "bg-green-500",
  closed: "bg-zinc-500",
};

function formatCost(cost: number): string {
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
}

function TicketCard({
  ticket,
  repoName,
  onSelect,
}: {
  ticket: Ticket;
  repoName: string;
  onSelect: (id: string) => void;
}) {
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", ticket.id);
    e.dataTransfer.effectAllowed = "move";
  }, [ticket.id]);

  return (
    <button
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelect(ticket.id)}
      className={`w-full text-left bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 hover:border-zinc-600 rounded-lg p-3 transition-colors cursor-grab active:cursor-grabbing space-y-2 border-l-[3px] ${PRIORITY_BORDERS[ticket.priority] || "border-l-zinc-700"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200 leading-snug line-clamp-2">
          {ticket.title}
        </p>
      </div>
      {ticket.branch && (
        <div className="flex items-center gap-1 text-xs text-zinc-500">
          <GitBranch size={11} className="shrink-0" />
          <span className="font-mono truncate max-w-[180px]">{ticket.branch}</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span>{repoName}</span>
        <span className="text-zinc-700">·</span>
        <span className="font-mono">{formatCost(ticket.totalCostUsd)}</span>
        <span className="text-zinc-700">·</span>
        <span className="flex items-center gap-1">
          <Zap size={11} className="text-zinc-600" />
          <span className="font-mono">{ticket.totalTokens.toLocaleString()}</span>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${CATEGORY_COLORS[ticket.category] || ""}`}>
          {ticket.category}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_COLORS[ticket.priority] || "bg-zinc-600"}`} />
        <span className="text-[10px] text-zinc-600 capitalize">{ticket.priority}</span>
      </div>
    </button>
  );
}

interface KanbanBoardProps {
  repoId?: string;
  search?: string;
  status?: string;
  priority?: string;
  category?: string;
}

export default function KanbanBoard(_props: KanbanBoardProps) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const repoId = search.repoId as string | undefined;
  const { data, isLoading, isError } = useTickets({ repoId });
  const { data: repos } = useRepos();
  const updateTicket = useUpdateTicket();
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const repoMap = useMemo(
    () => new Map(repos?.map((r) => [r.id, r.name]) ?? []),
    [repos],
  );

  const grouped = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const col of COLUMNS) map[col.status] = [];
    for (const ticket of data?.tickets ?? []) {
      if (ticket.status !== "closed") {
        map[ticket.status]?.push(ticket);
      }
    }
    return map;
  }, [data]);

  const handleDragOver = useCallback((e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(status);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, newStatus: string) => {
    e.preventDefault();
    setDragOverCol(null);
    const ticketId = e.dataTransfer.getData("text/plain");
    if (!ticketId) return;
    updateTicket.mutate({ id: ticketId, input: { status: newStatus as TicketStatus } });
  }, [updateTicket]);

  if (isLoading) {
    return (
      <div className="flex gap-4 h-full">
        {COLUMNS.map((col) => (
          <div key={col.status} className="flex-1 space-y-3">
            <div className="h-5 w-24 bg-zinc-800 rounded animate-pulse" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 bg-zinc-800/50 rounded-lg animate-pulse" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400 text-sm">Could not load board.</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 text-xs text-blue-400 hover:text-blue-300 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const anyTickets = (data?.tickets?.length ?? 0) > 0;

  if (!anyTickets) {
    return (
      <div className="text-center text-zinc-500 mt-20">
        <p className="text-lg">No tickets yet</p>
        <p className="text-sm mt-1">
          Create a ticket to see it on the board
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-full overflow-x-auto pb-4">
      {COLUMNS.map((col) => {
        const tickets = grouped[col.status] ?? [];
        const isOver = dragOverCol === col.status;

        return (
          <div key={col.status} className="flex-1 min-w-[220px] flex flex-col">
            {/* Column header */}
            <div className="flex items-center gap-2 mb-3 px-1">
              <span
                className={`w-2 h-2 rounded-full ${STATUS_DOT_COLORS[col.status]}`}
              />
              <h3 className="text-sm font-medium text-zinc-300">{col.label}</h3>
              <span className="text-xs text-zinc-600 font-mono">{tickets.length}</span>
            </div>

            {/* Cards — droppable zone */}
            <div
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
              className={`flex-1 space-y-2 overflow-y-auto rounded-lg transition-colors`}
              style={isOver ? { backgroundColor: 'var(--accent-subtler)', boxShadow: '0 0 0 1px var(--accent-ring)' } : undefined}
              >
                {tickets.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    repoName={repoMap.get(ticket.repoId) ?? ticket.repoId.slice(0, 8)}
                    onSelect={(id) => navigate({ to: `/tickets/${id}` })}
                  />
                ))}
                {tickets.length === 0 && (
                  <div
                    className={`h-24 rounded-lg border-2 border-dashed transition-colors ${
                      isOver ? "" : "border-zinc-800"
                    }`}
                    style={isOver ? { borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-subtler)' } : undefined}
                  />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
