import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "./store/app";
import { useRepos } from "./hooks/useRepos";
import { fetchSettings } from "./api/settings";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import TicketList from "./components/TicketList";
import KanbanBoard from "./components/KanbanBoard";
import SplitView from "./components/SplitView";
import TicketCreate from "./components/TicketCreate";
import TicketFilter, { type FilterValues } from "./components/TicketFilter";
import Settings from "./components/Settings";
import { Plus, List, Columns, LayoutDashboard } from "lucide-react";

export default function App() {
  const { view, setView, setCreateOpen, selectedTicketId, selectedRepoId, theme, setTheme } = useAppStore();
  const { data: repos } = useRepos();

  // Load saved theme on mount
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (settings?.theme) {
      setTheme(settings.theme);
    }
  }, [settings, setTheme]);
  const [filters, setFilters] = useState<FilterValues>({
    search: "", status: "", priority: "", category: "",
  });

  const repoName = useMemo(
    () => (selectedRepoId ? repos?.find((r) => r.id === selectedRepoId)?.name : null),
    [selectedRepoId, repos],
  );

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100" data-theme={theme}>
      <Sidebar />

      {/* Main area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {selectedTicketId ? (
          <SplitView />
        ) : view === "settings" ? (
          <div className="flex-1 overflow-auto p-6">
            <Settings />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 shrink-0 min-h-[53px]">
              <div className="flex items-center gap-4">
                <h2 className="text-sm font-medium text-zinc-300">
                  {repoName ? (
                    <><span className="text-zinc-500 font-normal">{repoName}</span></>
                  ) : (
                    "All repos"
                  )}
                </h2>
                {/* View toggle */}
                <div className="flex items-center gap-0.5 bg-zinc-900/80 rounded-lg p-0.5 border border-[var(--border-subtle)]">
                  <button
                    onClick={() => setView("dashboard")}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                      view === "dashboard"
                        ? "tab-active"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                    }`}
                  >
                    <LayoutDashboard size={13} />
                    Overview
                  </button>
                  <button
                    onClick={() => setView("list")}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                      view === "list"
                        ? "tab-active"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                    }`}
                  >
                    <List size={13} />
                    List
                  </button>
                  <button
                    onClick={() => setView("kanban")}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                      view === "kanban"
                        ? "tab-active"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                    }`}
                  >
                    <Columns size={13} />
                    Board
                  </button>
                </div>
              </div>

              {/* Filters — show on list/board views */}
              {view !== "dashboard" && (
                <TicketFilter values={filters} onChange={setFilters} />
              )}

              <button
                onClick={() => setCreateOpen(true)}
                className="btn-primary shrink-0"
              >
                <Plus size={14} />
                New ticket
              </button>
            </header>
            <div className="flex-1 overflow-auto p-6">
              {view === "dashboard" ? (
                <Dashboard repoId={selectedRepoId ?? undefined} />
              ) : view === "list" ? (
                <TicketList
                  repoId={selectedRepoId ?? undefined}
                  search={filters.search || undefined}
                  status={filters.status || undefined}
                  priority={filters.priority || undefined}
                  category={filters.category || undefined}
                />
              ) : (
                <KanbanBoard
                  repoId={selectedRepoId ?? undefined}
                  search={filters.search || undefined}
                  status={filters.status || undefined}
                  priority={filters.priority || undefined}
                  category={filters.category || undefined}
                />
              )}
            </div>
          </>
        )}
      </main>

      {/* Slide-over create panel */}
      <TicketCreate />
    </div>
  );
}
