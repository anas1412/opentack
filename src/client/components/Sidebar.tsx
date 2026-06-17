import { useAppStore } from "../store/app";
import { useRepos } from "../hooks/useRepos";
import { LayoutDashboard, ListTodo, Settings, Plus, GitBranch } from "lucide-react";

export default function Sidebar() {
  const { view, setView, setCreateOpen } = useAppStore();
  const { data: repos } = useRepos();

  return (
    <aside className="w-[220px] min-w-[220px] border-r border-zinc-800 flex flex-col bg-zinc-950">
      <div className="p-4">
        <h1 className="text-lg font-bold tracking-tight text-white">OpenDev</h1>
      </div>

      <nav className="flex-1 px-2 space-y-1">
        <button
          onClick={() => setView("list")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            view === "list"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <ListTodo size={16} />
          List
        </button>
        <button
          onClick={() => setView("kanban")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            view === "kanban"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <LayoutDashboard size={16} />
          Kanban
        </button>
      </nav>

      {/* Repos section */}
      <div className="px-4 py-2">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Repos</p>
      </div>
      <div className="px-2 space-y-0.5">
        {repos?.map((repo) => (
          <div
            key={repo.id}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-400"
          >
            <GitBranch size={12} className="text-zinc-600" />
            <span className="truncate">{repo.name}</span>
          </div>
        ))}
        {(!repos || repos.length === 0) && (
          <p className="px-3 py-1.5 text-xs text-zinc-600 italic">No repos added</p>
        )}
      </div>

      {/* Weekly cost */}
      <div className="px-4 py-3 border-t border-zinc-800 mt-auto">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">This week</p>
        <p className="text-sm text-zinc-300 font-mono mt-1">$0.00</p>
        <p className="text-xs text-zinc-600 font-mono">0 tokens</p>
      </div>

      {/* Actions */}
      <div className="p-2 border-t border-zinc-800 space-y-1">
        <button
          onClick={() => setCreateOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <Plus size={16} />
          New ticket
        </button>
        <button
          onClick={() => setView("settings")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            view === "settings"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Settings size={16} />
          Settings
        </button>
      </div>
    </aside>
  );
}
