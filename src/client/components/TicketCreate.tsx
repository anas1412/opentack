import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRepos } from "../hooks/useRepos";
import { useCreateTicket } from "../hooks/useTickets";
import { useAppStore } from "../store/app";
import { X, ArrowRight } from "lucide-react";
import type { TicketCategory, TicketPriority } from "../../shared/types";

export default function TicketCreate() {
  const { createOpen, setCreateOpen, selectedRepoId } = useAppStore();
  const { data: repos } = useRepos();
  const createTicket = useCreateTicket();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoId, setRepoId] = useState("");
  const [category, setCategory] = useState<TicketCategory>("feature");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [tags, setTags] = useState("");

  // The repo to use: selectedRepoId takes priority, then form state, then auto-pick if only one
  const effectiveRepoId = selectedRepoId || repoId;

  // Focus title when panel opens
  useEffect(() => {
    if (createOpen) {
      setTimeout(() => titleRef.current?.focus(), 100);
      if (selectedRepoId) {
        setRepoId(selectedRepoId); // already in a repo — pre-select it
      } else if (repos && repos.length === 1 && !repoId) {
        setRepoId(repos[0].id); // only one repo — auto-select
      }
    }
  }, [createOpen]);

  // Reset form when closed
  useEffect(() => {
    if (!createOpen) {
      setTitle("");
      setDescription("");
      setRepoId("");
      setCategory("feature");
      setPriority("medium");
      setTags("");
    }
  }, [createOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const repo = effectiveRepoId;
    if (!title.trim() || !description.trim() || !repo) return;

    await createTicket.mutateAsync({
      title: title.trim(),
      description: description.trim(),
      repoId: repo,
      category,
      priority,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });

    setCreateOpen(false);
  };

  const handleCreateAndEnter = async () => {
    const repo = effectiveRepoId;
    if (!title.trim() || !description.trim() || !repo || createTicket.isPending) return;

    const ticket = await createTicket.mutateAsync({
      title: title.trim(),
      description: description.trim(),
      repoId: repo,
      category,
      priority,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });

    setCreateOpen(false);
    navigate({ to: `/tickets/${ticket.id}` });
  };

  if (!createOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => setCreateOpen(false)}
      />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 w-[480px] bg-zinc-900 border-l border-zinc-800 z-50 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-white">New ticket</h2>
          <button
            onClick={() => setCreateOpen(false)}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-auto px-6 py-4 space-y-5">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Title</label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short task description"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Description
              <span className="text-xs text-zinc-500 font-normal ml-2">→ improves initial prompt</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task in detail. This is used to generate the initial prompt for opencode when you start a session."
              rows={6}
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent resize-none"
            />
            <p className="text-xs text-zinc-600 mt-1.5 flex items-center gap-1">
              <span className="inline-block w-1 h-1 rounded-full bg-zinc-600" />
              This description is used to generate an improved initial prompt for opencode when you start a session (can be disabled in Settings).
            </p>
          </div>

          {/* Repo — hidden when already selected in sidebar */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Repo</label>
            {selectedRepoId ? (
              <div className="w-full bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-400">
                {repos?.find((r) => r.id === selectedRepoId)?.name ?? "Selected repo"}
                <span className="text-xs text-zinc-600 ml-2">(from sidebar)</span>
              </div>
            ) : (
              <select
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                required
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
              >
                <option value="" disabled>
                  Select a repo...
                </option>
                {repos?.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Category</label>
            <div className="flex gap-1.5">
              {(["feature", "bug", "refactor", "chore", "docs"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                    category === c
                      ? "tab-active"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Priority</label>
            <div className="flex gap-1.5">
              {(["low", "medium", "high", "critical"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                    priority === p
                      ? "tab-active"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Tags <span className="text-zinc-500 font-normal">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="auth, frontend, urgent"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
            />
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex gap-3">
          <button
            type="button"
            onClick={() => setCreateOpen(false)}
            className="flex-1 px-4 py-2 rounded-md text-sm font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={!title.trim() || !description.trim() || !effectiveRepoId || createTicket.isPending}
            className="btn-primary flex-1 justify-center"
          >
            {createTicket.isPending ? "Creating..." : "Create ticket"}
          </button>
          <button
            type="button"
            onClick={handleCreateAndEnter}
            disabled={!title.trim() || !description.trim() || !effectiveRepoId || createTicket.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {createTicket.isPending ? "Creating..." : <>
              Create & open
              <ArrowRight size={14} />
            </>}
          </button>
        </div>
      </div>
    </>
  );
}
