import { useMemo } from "react";
import { useTickets } from "../hooks/useTickets";
import { useRepos } from "../hooks/useRepos";
import { useCostSummary } from "../hooks/useCostSummary";
import { useAppStore } from "../store/app";
import ActivityTimeline from "./ActivityTimeline";
import CostChart from "./CostChart";
import { Ticket, Layers, Circle, Play, DollarSign, ArrowRight, GitBranch, Clock, CheckCheck } from "lucide-react";

function StatCard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg ${color}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
        <p className="text-xl font-semibold text-white mt-0.5">{value}</p>
        {sub && <p className="text-xs text-zinc-600 mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  );
}

interface DashboardProps {
  repoId?: string;
}

export default function Dashboard({ repoId }: DashboardProps) {
  const { data: ticketsData } = useTickets({ repoId });
  const { data: repos } = useRepos();
  const { data: costs } = useCostSummary();
  const { setSelectedRepoId, setSelectedTicketId, setView } = useAppStore();

  const repo = useMemo(
    () => repos?.find((r) => r.id === repoId) ?? null,
    [repos, repoId],
  );

  const stats = useMemo(() => {
    const tickets = ticketsData?.tickets ?? [];
    const total = tickets.length;
    const open = tickets.filter((t) => t.status === "open" || t.status === "in_progress").length;
    const resolved = tickets.filter((t) => t.status === "resolved" || t.status === "closed").length;
    const active = tickets.filter((t) => t.activeSessionId !== null).length;
    return { total, open, resolved, active };
  }, [ticketsData]);

  const repoCost = useMemo(() => {
    if (!repoId || !costs?.perRepo) return null;
    return costs.perRepo.find((r) => r.repoId === repoId) ?? null;
  }, [repoId, costs]);

  const recentTickets = useMemo(() => {
    let tickets = ticketsData?.tickets ?? [];
    if (repoId) tickets = tickets.filter((t) => t.repoId === repoId);
    return [...tickets].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  }, [ticketsData, repoId]);

  return (
    <div className="space-y-8">
      {/* Greeting */}
      <div>
        <h2 className="text-lg font-semibold text-white">
          {repo ? repo.name : "Overview"}
        </h2>
        <p className="text-sm text-zinc-500 mt-1">
          {repoId
            ? `${stats.total} ticket${stats.total !== 1 ? "s" : ""}`
            : `${repos?.length ?? 0} repo${(repos?.length ?? 0) !== 1 ? "s" : ""} · ${stats.total} ticket${stats.total !== 1 ? "s" : ""}`
          }
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard
          icon={<Ticket size={18} className="text-blue-400" />}
          label="Total tickets"
          value={String(stats.total)}
          color="bg-blue-500/10"
        />
        <StatCard
          icon={<Circle size={18} className="text-amber-400" />}
          label="Open"
          value={String(stats.open)}
          sub={stats.total > 0 ? `${Math.round((stats.open / stats.total) * 100)}% of all` : undefined}
          color="bg-amber-500/10"
        />
        <StatCard
          icon={<CheckCheck size={18} className="text-emerald-400" />}
          label="Resolved"
          value={String(stats.resolved)}
          sub={stats.total > 0 ? `${Math.round((stats.resolved / stats.total) * 100)}% of all` : undefined}
          color="bg-emerald-500/10"
        />
        <StatCard
          icon={<Play size={18} className="text-green-400" />}
          label="Active sessions"
          value={String(stats.active)}
          sub={stats.active === 1 ? "1 running" : `${stats.active} running`}
          color="bg-green-500/10"
        />
        <StatCard
          icon={<DollarSign size={18} className="text-purple-400" />}
          label="Usage"
          value={repoCost
            ? `${repoCost.tokens.toLocaleString()} tok`
            : costs
              ? `${costs.weekTotalTokens.toLocaleString()} tok`
              : "—"
          }
          sub={repoCost
            ? `${repoCost.sessionCount} session${repoCost.sessionCount !== 1 ? "s" : ""} · $${repoCost.usd.toFixed(2)}`
            : costs
              ? `${costs.sessionCount} session${costs.sessionCount !== 1 ? "s" : ""} · $${costs.weekTotalUsd.toFixed(2)}`
              : undefined
          }
          color="bg-purple-500/10"
        />
      </div>

      {/* Chart — only for All Repos view */}
      {!repoId && <CostChart />}

      {/* Two-column layout for details */}
      <div className="grid grid-cols-2 gap-6">
        {/* Repo details or Repos list */}
        <div>
          {repo ? (
            <>
              <h3 className="text-sm font-medium text-zinc-300 mb-3">Repo info</h3>
              <div className="space-y-2 px-1">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <GitBranch size={13} className="shrink-0 text-zinc-500" />
                  <span className="font-mono text-xs">{repo.defaultBranch}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Layers size={13} className="shrink-0 text-zinc-500" />
                  <span className="text-xs truncate">{repo.localPath}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Clock size={13} className="shrink-0 text-zinc-500" />
                  <span className="text-xs">
                    {repo.lastUsedAt
                      ? `Last used ${new Date(repo.lastUsedAt).toLocaleDateString()}`
                      : "Never used"}
                  </span>
                </div>
                <button
                  onClick={() => { setView("list"); }}
                  className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  View all tickets →
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-medium text-zinc-300 mb-3">Repos</h3>
              <div className="space-y-1">
                {repos && repos.length > 0 ? (
                  repos.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => { setSelectedRepoId(r.id); }}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors text-left group"
                    >
                      <Layers size={14} className="shrink-0 text-zinc-500" />
                      <span className="flex-1 text-sm text-zinc-300 group-hover:text-white transition-colors truncate">
                        {r.name}
                      </span>
                      <ArrowRight size={12} className="shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-zinc-600 italic px-3">No repos added yet</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Recent tickets */}
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Recent tickets</h3>
          <div className="space-y-1">
            {recentTickets.length > 0 ? (
              recentTickets.map((ticket) => {
                const name = repos?.find((r) => r.id === ticket.repoId)?.name;
                return (
                  <button
                    key={ticket.id}
                    onClick={() => {
                      setSelectedRepoId(ticket.repoId);
                      setSelectedTicketId(ticket.id);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors text-left group"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        ticket.activeSessionId
                          ? "bg-green-400"
                          : ticket.status === "open"
                            ? "bg-blue-500"
                            : ticket.status === "resolved" || ticket.status === "closed"
                              ? "bg-zinc-600"
                              : "bg-amber-500"
                      }`}
                    />
                    <span className="flex-1 text-sm text-zinc-300 group-hover:text-white transition-colors truncate">
                      {ticket.title}
                    </span>
                    {name && !repoId && (
                      <span className="text-xs text-zinc-600 shrink-0">{name}</span>
                    )}
                    <ArrowRight size={12} className="shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                );
              })
            ) : (
              <p className="text-sm text-zinc-600 italic px-3">No tickets yet</p>
            )}
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} className="text-zinc-500" />
          <h3 className="text-sm font-medium text-zinc-300">Recent activity</h3>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
          <ActivityTimeline repoId={repoId} limit={15} />
        </div>
      </div>

      {/* Cost breakdown — only for All Repos view */}
      {!repoId && costs?.perRepo && costs.perRepo.length > 1 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Costs by repo</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-2.5 font-medium">Repo</th>
                  <th className="px-4 py-2.5 font-medium text-right">Sessions</th>
                  <th className="px-4 py-2.5 font-medium text-right">Tokens</th>
                  <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {costs.perRepo.map((r) => (
                  <tr key={r.repoId} className="border-b border-zinc-800/50 last:border-0">
                    <td className="px-4 py-2.5 text-zinc-300">{r.repoName}</td>
                    <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{r.sessionCount}</td>
                    <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{r.tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-zinc-200 text-right font-mono">${r.usd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
