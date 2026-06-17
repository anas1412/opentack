import { useAppStore } from "./store/app";
import Sidebar from "./components/Sidebar";
import TicketList from "./components/TicketList";
import TicketCreate from "./components/TicketCreate";
import { LayoutDashboard, Plus } from "lucide-react";

export default function App() {
  const { view, setView, setCreateOpen } = useAppStore();

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />

      {/* Main area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
            {view === "list" ? "Tickets" : view === "kanban" ? "Board" : "Settings"}
          </h2>
          {view !== "settings" && (
            <button
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-medium transition-colors"
            >
              <Plus size={14} />
              New ticket
            </button>
          )}
        </header>

        <div className="flex-1 overflow-auto p-6">
          {view === "list" && <TicketList />}
          {view === "kanban" && (
            <div className="text-center text-zinc-500 mt-20">
              <LayoutDashboard size={32} className="mx-auto mb-3 text-zinc-700" />
              <p className="text-lg">Board view coming soon</p>
              <p className="text-sm mt-1">Drag and drop tickets across status columns</p>
            </div>
          )}
          {view === "settings" && (
            <div className="max-w-lg mx-auto text-zinc-500">
              <p className="text-lg text-zinc-300 font-medium">Settings</p>
              <p className="text-sm mt-2">Repo configuration and app preferences coming here.</p>
            </div>
          )}
        </div>
      </main>

      {/* Slide-over create panel */}
      <TicketCreate />
    </div>
  );
}
