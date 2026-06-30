import { useState, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { useRepos } from "../hooks/useRepos";
import { useCostSummary } from "../hooks/useCostSummary";
import { useCostPerTicket } from "../hooks/useCostPerTicket";
import { useCostPerModel } from "../hooks/useCostPerModel";
import { BarChart3, ChevronDown, ChevronRight, Layers, Search } from "lucide-react";

type Tab = "repo" | "ticket" | "model";
type Range = 1 | 7 | 30 | 0;

const RANGE_LABELS: Record<Range, string> = {
  1: "Today",
  7: "Past 7 days",
  30: "Past 30 days",
  0: "All time",
};

function parseModelField(model: string | null | undefined): { id: string; provider?: string; variant?: string } {
  if (!model) return { id: "Unknown" };
  try {
    const parsed = JSON.parse(model);
    return {
      id: parsed.id || "Unknown",
      provider: parsed.providerID,
      variant: parsed.variant,
    };
  } catch {
    const parts = model.split("/");
    return {
      id: parts[parts.length - 1] || model,
      provider: parts.length > 1 ? parts[0] : undefined,
    };
  }
}

function formatModelName(model: string | null | undefined): string {
  const { id } = parseModelField(model);
  const cleaned = id.replace(/-\d{8}$/, "");
  const withSpaces = cleaned.replace(/[-_]/g, " ");
  const words = withSpaces.split(" ");
  const formatted = words
    .map((w) => {
      if (!w) return w;
      if (w === w.toUpperCase() && w.length > 1) return w;
      if (/^o\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
  return formatted;
}

export default function UsagePage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const repoId = search.repoId as string | undefined;
  const { data: repos } = useRepos();

  const [tab, setTab] = useState<Tab>("repo");
  const [range, setRange] = useState<Range>(7);
  const [query, setQuery] = useState("");
  const [expandedTickets, setExpandedTickets] = useState<Set<string>>(new Set());

  const daysParam = range === 0 ? undefined : range;

  const { data: costs } = useCostSummary();
  const { data: perTicket, isLoading: ticketLoading } = useCostPerTicket({ days: daysParam, repoId });
  const { data: perModel, isLoading: modelLoading } = useCostPerModel({ days: daysParam });

  const repo = useMemo(
    () => repos?.find((r) => r.id === repoId) ?? null,
    [repos, repoId],
  );

  const filteredPerRepo = useMemo(() => {
    if (!costs?.perRepo) return [];
    let items = costs.perRepo;
    if (repoId) items = items.filter((r) => r.repoId === repoId);
    if (query) {
      const q = query.toLowerCase();
      items = items.filter((r) => r.repoName.toLowerCase().includes(q));
    }
    return items;
  }, [costs, repoId, query]);

  const filteredPerTicket = useMemo(() => {
    if (!perTicket) return [];
    if (!query) return perTicket;
    const q = query.toLowerCase();
    return perTicket.filter(
      (t) =>
        t.ticketTitle.toLowerCase().includes(q) ||
        t.repoName.toLowerCase().includes(q) ||
        t.models.some((m) => formatModelName(m.model).toLowerCase().includes(q) || m.model.toLowerCase().includes(q)),
    );
  }, [perTicket, query]);

  const filteredPerModel = useMemo(() => {
    if (!perModel) return [];
    if (!query) return perModel;
    const q = query.toLowerCase();
    return perModel.filter(
      (m) => formatModelName(m.model).toLowerCase().includes(q) || m.model.toLowerCase().includes(q),
    );
  }, [perModel, query]);

  const totalTokens = useMemo(() => {
    if (tab === "repo") return filteredPerRepo.reduce((s, r) => s + r.tokens, 0);
    if (tab === "ticket") return filteredPerTicket.reduce((s, t) => s + t.totalTokens, 0);
    return filteredPerModel.reduce((s, m) => s + m.totalTokens, 0);
  }, [tab, filteredPerRepo, filteredPerTicket, filteredPerModel]);

  const totalCost = useMemo(() => {
    if (tab === "repo") return filteredPerRepo.reduce((s, r) => s + r.usd, 0);
    if (tab === "ticket") return filteredPerTicket.reduce((s, t) => s + t.totalCost, 0);
    return filteredPerModel.reduce((s, m) => s + m.totalCost, 0);
  }, [tab, filteredPerRepo, filteredPerTicket, filteredPerModel]);

  const totalSessions = useMemo(() => {
    if (tab === "repo") return filteredPerRepo.reduce((s, r) => s + r.sessionCount, 0);
    if (tab === "ticket") return filteredPerTicket.reduce((s, t) => s + t.sessionCount, 0);
    return filteredPerModel.reduce((s, m) => s + m.sessionCount, 0);
  }, [tab, filteredPerRepo, filteredPerTicket, filteredPerModel]);

  const toggleTicket = (id: string) => {
    setExpandedTickets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 size={16} className="text-zinc-400" />
              <h2 className="text-lg font-semibold text-white">AI Usage</h2>
            </div>
            <p className="text-sm text-zinc-500">
              {repo ? `${repo.name} — ` : ""}Cost and token breakdown across all AI sessions
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search..."
                className="w-44 bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-2.5 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
              />
            </div>

            {/* Date range */}
            <select
              value={range}
              onChange={(e) => setRange(Number(e.target.value) as Range)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-600 cursor-pointer"
            >
              {([1, 7, 30, 0] as Range[]).map((r) => (
                <option key={r} value={r}>{RANGE_LABELS[r]}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Total Cost</p>
            <p className="text-xl font-semibold text-white mt-0.5">${totalCost.toFixed(2)}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Total Tokens</p>
            <p className="text-xl font-semibold text-white mt-0.5">{totalTokens.toLocaleString()}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Total Sessions</p>
            <p className="text-xl font-semibold text-white mt-0.5">{totalSessions}</p>
          </div>
        </div>

        {/* Tab toggle + result count */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5 bg-zinc-900/80 rounded-lg p-0.5 border border-zinc-800 w-fit">
            {[
              { key: "repo" as Tab, label: "By Repo", icon: <Layers size={13} /> },
              { key: "ticket" as Tab, label: "By Ticket", icon: <BarChart3 size={13} /> },
              { key: "model" as Tab, label: "By Model", icon: <BarChart3 size={13} /> },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => { setTab(t.key); setExpandedTickets(new Set()); }}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                  tab === t.key
                    ? "tab-active"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          {query && (
            <p className="text-xs text-zinc-500">
              {tab === "repo" ? filteredPerRepo.length : tab === "ticket" ? filteredPerTicket.length : filteredPerModel.length} result{(tab === "repo" ? filteredPerRepo : tab === "ticket" ? filteredPerTicket : filteredPerModel).length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Tab content */}
        {tab === "repo" && (
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
                {filteredPerRepo.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-zinc-600">No usage data for this period</td>
                  </tr>
                ) : (
                  filteredPerRepo.map((r) => (
                    <tr key={r.repoId} className="border-b border-zinc-800/50 last:border-0">
                      <td className="px-4 py-2.5 text-zinc-300">{r.repoName}</td>
                      <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{r.sessionCount}</td>
                      <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{r.tokens.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-zinc-200 text-right font-mono">${r.usd.toFixed(2)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "ticket" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-2.5 font-medium w-6" />
                  <th className="px-4 py-2.5 font-medium">Ticket</th>
                  <th className="px-4 py-2.5 font-medium">Repo</th>
                  <th className="px-4 py-2.5 font-medium text-right">Sessions</th>
                  <th className="px-4 py-2.5 font-medium text-right">Tokens</th>
                  <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {ticketLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-600">Loading…</td>
                  </tr>
                ) : filteredPerTicket.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-600">No ticket usage data for this period</td>
                  </tr>
                ) : (
                  filteredPerTicket.map((t) => {
                    const expanded = expandedTickets.has(t.ticketId);
                    return (
                      <>
                        <tr key={t.ticketId} className="border-b border-zinc-800/50 last:border-0">
                          <td className="px-4 py-2.5">
                            {t.models.length > 1 && (
                              <button
                                onClick={() => toggleTicket(t.ticketId)}
                                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                              >
                                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => navigate({ to: `/tickets/${t.ticketId}`, search: repoId ? { repoId } : {} })}
                              className="text-zinc-300 hover:text-white transition-colors text-left"
                            >
                              {t.ticketTitle}
                            </button>
                          </td>
                          <td className="px-4 py-2.5 text-zinc-500 text-xs">{t.repoName}</td>
                          <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{t.sessionCount}</td>
                          <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{t.totalTokens.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-zinc-200 text-right font-mono">${t.totalCost.toFixed(2)}</td>
                        </tr>
                        {expanded && t.models.length > 1 && (
                          <tr key={`${t.ticketId}-models`} className="bg-zinc-800/30">
                            <td colSpan={6} className="px-4 py-2">
                              <div className="pl-6 space-y-1">
                                {t.models.map((m) => (
                                  <div key={m.model} className="flex items-center gap-4 text-xs">
                                    <span className="text-zinc-400 flex-1 truncate" title={m.model}>{formatModelName(m.model)}</span>
                                    <span className="text-zinc-500 font-mono w-20 text-right">{m.sessionCount} session{m.sessionCount !== 1 ? "s" : ""}</span>
                                    <span className="text-zinc-500 font-mono w-28 text-right">{m.tokens.toLocaleString()} tok</span>
                                    <span className="text-zinc-300 font-mono w-20 text-right">${m.cost.toFixed(2)}</span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "model" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 font-medium text-right">Sessions</th>
                  <th className="px-4 py-2.5 font-medium text-right">Tickets</th>
                  <th className="px-4 py-2.5 font-medium text-right">Tokens</th>
                  <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">Loading…</td>
                  </tr>
                ) : filteredPerModel.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">No model usage data for this period</td>
                  </tr>
                ) : (
                  filteredPerModel.map((m) => {
                    const parsed = parseModelField(m.model);
                    return (
                    <tr key={m.model} className="border-b border-zinc-800/50 last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="text-zinc-300 text-sm">{formatModelName(m.model)}{parsed.variant ? <span className="text-zinc-500 font-normal"> · {parsed.variant}</span> : ""}</span>
                        <span className="text-zinc-600 text-[10px] block">{parsed.provider ? `${parsed.provider}/` : ""}{parsed.id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{m.sessionCount}</td>
                      <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{m.ticketCount}</td>
                      <td className="px-4 py-2.5 text-zinc-400 text-right font-mono text-xs">{m.totalTokens.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-zinc-200 text-right font-mono">${m.totalCost.toFixed(2)}</td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
