import { useMemo, useState } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  Link,
  useSearch,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { useAppStore } from "./store/app";
import { useRepos } from "./hooks/useRepos";
import { createChat } from "./api/chats";
import { Plus, List, LayoutDashboard, BookText, MessageSquare, GitBranch, Loader2 } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import TicketsView from "./components/TicketsView";
import Settings from "./components/Settings";
import UsagePage from "./components/UsagePage";
import SplitView from "./components/SplitView";
import TicketCreate from "./components/TicketCreate";
import JournalView from "./components/JournalView";
import ChatView from "./components/ChatView";

// ─── Search param schema ─────────────────────────────────────────────

const contentSearchSchema = z.object({
  repoId: z.string().optional(),
});

const ticketsSearchSchema = z.object({
  repoId: z.string().optional(),
  view: z.enum(["list", "board"]).optional(),
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
  const navigate = useNavigate();
  const { setCreateOpen, setSelectedRepoId } = useAppStore();
  const { data: repos } = useRepos();
  const [chatRepoOpen, setChatRepoOpen] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);

  const handleNewChat = () => {
    if (!repos || repos.length === 0) return;
    const repoId = search.repoId || (repos.length === 1 ? repos[0].id : null);
    if (repoId) {
      setCreatingChat(true);
      createChat(repoId).then((chat) => {
        navigate({ to: `/chat/${chat.id}` });
      }).catch(() => {}).finally(() => setCreatingChat(false));
    } else {
      setChatRepoOpen(true);
    }
  };

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
              to="/tickets"
              search={{ repoId: search.repoId }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                isActive("/tickets")
                  ? "tab-active"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              <List size={13} />
              Tickets
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

        <div className="flex items-center gap-2">
          <button
            onClick={handleNewChat}
            disabled={creatingChat}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {creatingChat ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
            {creatingChat ? "Starting..." : "New Chat"}
          </button>
          <button
            onClick={() => {
              if (search.repoId) setSelectedRepoId(search.repoId);
              setCreateOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all duration-150 shrink-0 bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
            style={{ boxShadow: '0 0 12px rgba(var(--accent-glow-rgb), 0.12)' }}
          >
            <Plus size={14} />
            New Ticket
          </button>
        </div>
      </header>

      {/* Repo picker for new chat */}
      {chatRepoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 w-80 shadow-2xl">
            <h3 className="text-sm font-medium text-zinc-200 mb-3">Start chat in...</h3>
            <div className="space-y-1">
              {repos?.map((repo) => (
                <button
                  key={repo.id}
                  onClick={() => {
                    setChatRepoOpen(false);
                    createChat(repo.id).then((chat) => {
                      navigate({ to: `/chat/${chat.id}` });
                    }).catch(() => {});
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-zinc-800 transition-colors text-left"
                >
                  <GitBranch size={14} className="shrink-0 text-zinc-500" />
                  <span className="truncate">{repo.name}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setChatRepoOpen(false)}
              className="mt-3 w-full px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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

const ticketsRoute = createRoute({
  getParentRoute: () => contentLayout,
  path: "/tickets",
  validateSearch: ticketsSearchSchema,
  component: TicketsView,
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

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$chatId",
  component: ChatView,
});

// ─── Route Tree & Router ────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  contentLayout.addChildren([indexRoute, ticketsRoute, journalRoute]),
  settingsRoute,
  usageRoute,
  ticketRoute,
  chatRoute,
]);

const router = createRouter({ routeTree });

export { router, indexRoute, ticketsRoute, journalRoute, ticketRoute, usageRoute, chatRoute };

// ─── Type augmentation for type-safe router usage ────────────────────

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
