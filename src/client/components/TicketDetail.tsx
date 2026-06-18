import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTicket, useUpdateTicket, useDeleteTicket, useTicketSessions, useGenerateNotes } from "../hooks/useTickets";
import { useRepos } from "../hooks/useRepos";
import { useAppStore } from "../store/app";
import type { TicketStatus, TicketPriority, TicketCategory } from "../../shared/types";
import { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES } from "../../shared/types";
import { Clock, GitBranch, DollarSign, FileCode, Pencil, X, Trash2, Check } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  in_progress: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  needs_review: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  changes_requested: "bg-red-500/20 text-red-400 border-red-500/30",
  resolved: "bg-green-500/20 text-green-400 border-green-500/30",
  closed: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

interface TicketDetailProps {
  ticketId: string;
  onStartSession: () => void;
  sessionActive: boolean;
}

export default function TicketDetail({ ticketId, onStartSession, sessionActive }: TicketDetailProps) {
  const { data: ticket, isLoading, isError } = useTicket(ticketId);
  const { data: repos } = useRepos();
  const { data: sessions } = useTicketSessions(ticketId);
  const updateTicket = useUpdateTicket();
  const deleteTicket = useDeleteTicket();
  const { setSelectedTicketId } = useAppStore();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<TicketStatus>("open");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [category, setCategory] = useState<TicketCategory>("feature");
  const [tagsStr, setTagsStr] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const generateNotesMutation = useGenerateNotes();

  const repoName = useMemo(
    () => repos?.find((r) => r.id === ticket?.repoId)?.name,
    [repos, ticket?.repoId],
  );

  // Enter edit mode — populate from current ticket
  function startEditing() {
    if (!ticket) return;
    setTitle(ticket.title);
    setDescription(ticket.description);
    setNotes(ticket.notes);
    setStatus(ticket.status);
    setPriority(ticket.priority);
    setCategory(ticket.category);
    setTagsStr(ticket.tags.join(", "));
    setEditing(true);
  }

  async function saveEdits() {
    if (!ticket || saving) return;
    setSaving(true);
    try {
      await updateTicket.mutateAsync({
        id: ticket.id,
        input: {
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          notes: notes.trim() !== ticket.notes ? notes.trim() : undefined,
          status,
          priority,
          category,
          tags: tagsStr
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        },
      });
      setEditing(false);
    } catch {
      // error handled by react-query
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!ticket) return;
    await deleteTicket.mutateAsync(ticket.id);
    setSelectedTicketId(null);
  }

  async function handleGenerateNotes() {
    if (!ticket) return;
    await generateNotesMutation.mutateAsync(ticket.id);
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="h-6 w-3/4 bg-zinc-800 rounded animate-pulse" />
        <div className="h-4 w-1/2 bg-zinc-800 rounded animate-pulse" />
        <div className="h-24 bg-zinc-800 rounded animate-pulse" />
      </div>
    );
  }

  if (isError || !ticket) {
    return (
      <div className="p-4 text-center text-zinc-500">
        <p className="text-sm text-red-400">Could not load ticket.</p>
      </div>
    );
  }

  // ── READ MODE ──
  if (!editing) {
    return (
      <div className="p-4 space-y-4 overflow-auto h-full">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[ticket.status] || ""}`}
            >
              {ticket.status.replace("_", " ")}
            </span>
            <span className="text-xs text-zinc-500 uppercase">{ticket.category}</span>
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-zinc-500 capitalize">{ticket.priority}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={startEditing}
                className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="Edit ticket"
              >
                <Pencil size={14} />
              </button>
            {!deleteConfirm ? (
              <button
                onClick={() => setDeleteConfirm(true)}
                className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete ticket"
              >
                <Trash2 size={14} />
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleDelete}
                  className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  title="Confirm delete"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        </div>

        <h2 className="text-base font-semibold text-white leading-snug">{ticket.title}</h2>

        {/* Metadata */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-400">
          {repoName && (
            <span className="flex items-center gap-1">
              <FileCode size={12} />
              {repoName}
            </span>
          )}
          <span className="flex items-center gap-1">
            <GitBranch size={12} />
            {ticket.branch}
          </span>
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            {ticket.totalCostUsd > 0 ? `$${ticket.totalCostUsd.toFixed(2)}` : "No cost"}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {new Date(ticket.createdAt).toLocaleDateString()}
          </span>
        </div>

        {/* Description */}
        {ticket.description && (
          <div>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Description</p>
            <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{ticket.description}</p>
          </div>
        )}

        {/* Notes */}
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Notes</p>
          <button
            onClick={handleGenerateNotes}
            disabled={generateNotesMutation.isPending}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {generateNotesMutation.isPending ? (
              <span className="w-3 h-3 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            )}
            {generateNotesMutation.isPending ? "Generating..." : "Generate"}
          </button>
        </div>
        {ticket.notes ? (
          <div className="text-sm text-zinc-400 leading-relaxed [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:text-zinc-200 [&_a]:text-amber-400 [&_a]:underline [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:rounded">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {ticket.notes}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 italic">No notes</p>
        )}

        {/* Files changed */}
        <div>
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Files changed</p>
          {ticket.filesChanged.length === 0 ? (
            <p className="text-xs text-zinc-600 italic">No files changed yet</p>
          ) : (
            <ul className="space-y-1">
              {ticket.filesChanged.map((file) => (
                <li key={file} className="text-sm text-zinc-400 font-mono">{file}</li>
              ))}
            </ul>
          )}
        </div>

        {/* Session (one per ticket) */}
        <div>
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
            Session
          </p>
          {sessions && sessions.length > 0 ? (
            (() => {
              const s = sessions[0];
              const isActive = s.exitCode === null;
              return (
                <div className="bg-zinc-800/30 rounded-lg px-3 py-2 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-400" : "bg-zinc-500"}`} />
                      <span className="text-zinc-300 font-medium">{isActive ? "Active" : s.id.slice(0, 8)}</span>
                    </span>
                    {s.model && s.model !== "unknown" && (
                      <span className="text-zinc-600 font-mono">{s.model}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-zinc-600">
                    <span>{s.totalTokens.toLocaleString()} tokens</span>
                    {s.costUsd > 0 && <span>${s.costUsd.toFixed(2)}</span>}
                    {s.durationMs !== null && (
                      <span>{Math.round(s.durationMs / 60000)}m</span>
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            <p className="text-xs text-zinc-600 italic">No session yet</p>
          )}
        </div>
      </div>
    );
  }

  // ── EDIT MODE ──
  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Edit ticket</p>
        <div className="flex items-center gap-1">
          <button
            onClick={saveEdits}
            disabled={saving}
            className="btn-primary !px-2.5 !py-1 !text-xs"
          >
            <Check size={12} />
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Title */}
      <div>
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
        />
      </div>

      {/* Status */}
      <div>
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TicketStatus)}
          className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
      </div>

      {/* Row: Priority */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
            className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end pb-2">
          <span className="flex items-center gap-2 text-xs text-zinc-600">
            <span className="text-zinc-500 uppercase font-medium">{ticket.category}</span>
          </span>
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={Math.max(4, description.split('\n').length, Math.ceil(description.length / 60))}
          className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 font-mono resize-y"
        />
      </div>

      {/* Tags */}
      <div>
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">
          Tags <span className="font-normal lowercase text-zinc-600">(comma separated)</span>
        </label>
        <input
          value={tagsStr}
          onChange={(e) => setTagsStr(e.target.value)}
          placeholder="ui, performance, urgent"
          className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
        />
      </div>

      {/* Notes */}
      <div>
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1 block">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={Math.max(3, notes.split('\n').length, Math.ceil(notes.length / 60))}
          className="w-full bg-zinc-800/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 font-mono resize-y"
        />
      </div>

      {/* Delete */}
      {!deleteConfirm ? (
        <button
          onClick={() => setDeleteConfirm(true)}
          className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
        >
          <Trash2 size={12} /> Delete ticket
        </button>
      ) : (
        <div className="flex items-center gap-2 pt-2 border-t border-red-900/50">
          <p className="text-xs text-red-400">Delete this ticket?</p>
          <button onClick={handleDelete} className="px-2 py-1 rounded text-xs font-medium bg-red-600 hover:bg-red-500 text-white transition-colors">
            Delete
          </button>
          <button onClick={() => setDeleteConfirm(false)} className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
