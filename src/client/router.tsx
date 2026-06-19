import { useMemo } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  Link,
  useSearch,
  useLocation,
} from "@tanstack/react-router";
import { z } from "zod";
import { useAppStore } from "./store/app";
import { useRepos } from "./hooks/useRepos";
import { Plus, List, Columns, LayoutDashboard, BookText } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import TicketList from "./components/TicketList";
import KanbanBoard from "./components/KanbanBoard";
import Settings from "./components/Settings";
import UsagePage from "./components/UsagePage";
import SplitView from "./components/SplitView";
import TicketCreate from "./components/TicketCreate";
import JournalView from "./components/JournalView";

// ─── Search param schema ─────────────────────────────────────────────

const contentSearchSchema = z.object({
  repoId: z.string().optional(),
});

// ─── Root Layout ─────────────────────────────────────────────────────

function RootLayout() {
  const { theme } = useAppStore();

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100" data-theme={theme}>
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </main>
      <TicketCreate />
    </div>
  );
}

// ─── Content Layout (header + view tabs + outlet) ────────────────────

function ContentLayout() {
  const { pathname } = useLocation();
  const search = useSearch({ strict: false }) as { repoId?: string };
  const { setCreateOpen } = useAppStore();
  const { data: repos } = useRepos();

  const repoName = useMemo(
    () =>
      search.repoId
        ? repos?.find((r) => r.id === search.repoId)?.name ?? null
        : null,
    [search.repoId, repos],
  );

  const isActive = (path: string) => pathname === path;

  return (
    <>
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 shrink-0 min-h-[53px]">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-medium text-zinc-300">
            {repoName ? (
              <>
                <span className="text-zinc-500 font-normal">{repoName}</span>
              </>
            ) : (
              "All repos"
            )}
          </h2>

          {/* View toggle — preserves repoId from search params */}
          <div className="flex items-center gap-0.5 bg-zinc-900/80 rounded-lg p-0.5 border border-[var(--border-subtle)]">
            <Link
              to="/"
              search={{ repoId: search.repoId }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                isActive("/")
                  ? "tab-active"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              <LayoutDashboard size={13} />
              Overview
            </Link>
            <Link
              to="/list"
              search={{ repoId: search.repoId }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                isActive("/list")
                  ? "tab-active"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              <List size={13} />
              List
            </Link>
            <Link
              to="/board"
              search={{ repoId: search.repoId }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                isActive("/board")
                  ? "tab-active"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              <Columns size={13} />
              Board
            </Link>
            <Link
              to="/journal"
              search={{ repoId: search.repoId }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                isActive("/journal")
                  ? "tab-active"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              <BookText size={13} />
              Journal
            </Link>
          </div>
        </div>

        <button
          onClick={() => setCreateOpen(true)}
          className="btn-primary shrink-0"
        >
          <Plus size={14} />
          New ticket
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <Outlet />
      </div>
    </>
  );
}

// ─── Route Definitions ───────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: RootLayout,
});

const contentLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "content",
  component: ContentLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => contentLayout,
  path: "/",
  validateSearch: contentSearchSchema,
  component: Dashboard,
});

const listRoute = createRoute({
  getParentRoute: () => contentLayout,
  path: "/list",
  validateSearch: contentSearchSchema,
  component: TicketList,
});

const boardRoute = createRoute({
  getParentRoute: () => contentLayout,
  path: "/board",
  validateSearch: contentSearchSchema,
  component: KanbanBoard,
});

const journalRoute = createRoute({
  getParentRoute: () => contentLayout,
  path: "/journal",
  validateSearch: contentSearchSchema,
  component: JournalView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  validateSearch: contentSearchSchema,
  component: UsagePage,
});

const ticketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tickets/$ticketId",
  component: SplitView,
});

// ─── Route Tree & Router ────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  contentLayout.addChildren([indexRoute, listRoute, boardRoute, journalRoute]),
  settingsRoute,
  usageRoute,
  ticketRoute,
]);

const router = createRouter({ routeTree });

export { router, indexRoute, listRoute, boardRoute, journalRoute, ticketRoute, usageRoute };

// ─── Type augmentation for type-safe router usage ────────────────────

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
