import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useJournal } from "../hooks/useJournal";
import { Calendar, FileCode, BookText, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { TicketDayInfo, JournalDayResult } from "../../shared/types";

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - d.getTime()) / 86_400_000;

  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function isToday(dateStr: string): boolean {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return dateStr === `${yyyy}-${mm}-${dd}`;
}

export default function JournalView() {
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allDays, setAllDays] = useState<JournalDayResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const repoId = search.repoId as string | undefined;
  const { data, isLoading, isError, isFetching } = useJournal(offset, 7, repoId);

  // Accumulate days when new data arrives
  useEffect(() => {
    if (!data) return;

    if (offset === 0) {
      setAllDays(data.days);
      // Expand today by default
      if (data.days[0]?.date) {
        setExpanded(new Set([data.days[0].date]));
      }
    } else {
      setAllDays((prev) => [...prev, ...data.days]);
    }
    setHasMore(data.hasMore);
  }, [data, offset]);

  const toggleDay = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const loadMore = useCallback(() => {
    setOffset((prev) => prev + 7);
  }, []);

  if (isLoading && allDays.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 bg-zinc-800/50 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError && allDays.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-red-400">Could not load journal.</p>
      </div>
    );
  }

  const allEmpty = allDays.every((d) => d.tickets.length === 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-white">Journal</h2>
        <p className="text-xs text-zinc-500 mt-0.5">All days with sessions — live from tickets</p>
      </div>

      <div className="space-y-2">
        {allDays.filter((d) => d.tickets.length > 0).map((day) => (
          <DayCard
            key={day.date}
            date={day.date}
            tickets={day.tickets}
            isExpanded={expanded.has(day.date)}
            onToggle={() => toggleDay(day.date)}
          />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={loadMore}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-zinc-800/60 transition-colors disabled:opacity-40"
          >
            {isFetching ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <ChevronDown size={13} />
            )}
            {isFetching ? "Loading..." : "Load more"}
          </button>
        </div>
      )}

      {allEmpty && !hasMore && (
        <div className="text-center py-12">
          <Calendar size={32} className="mx-auto text-zinc-700 mb-3" />
          <p className="text-sm text-zinc-500">No sessions found.</p>
          <p className="text-xs text-zinc-600 mt-1">
            Start working on tickets and they'll show up here.
          </p>
        </div>
      )}
    </div>
  );
}

function DayCard({
  date,
  tickets,
  isExpanded,
  onToggle,
}: {
  date: string;
  tickets: TicketDayInfo[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  const label = formatDateLabel(date);
  const today = isToday(date);
  const hasWork = tickets.length > 0;

  return (
    <div
      className={`rounded-lg border ${
        hasWork
          ? "bg-zinc-900/50 border-zinc-800/60"
          : "bg-zinc-900/20 border-zinc-800/30 border-dashed"
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown size={14} className="text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500 shrink-0" />
          )}
          <span className="text-sm font-medium text-zinc-200">{label}</span>
          <span className="text-xs text-zinc-600">{date}</span>
          {today && (
            <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
              Today
            </span>
          )}
        </div>
        {hasWork && (
          <span className="text-xs text-zinc-500">{tickets.length} ticket{tickets.length !== 1 ? "s" : ""}</span>
        )}
      </button>

      {isExpanded && (
        <div className="px-4 py-3 space-y-3">
          {hasWork ? (
            tickets.map((t, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <BookText size={13} className="text-zinc-500 shrink-0" />
                  <button
                    onClick={() => navigate({ to: `/tickets/${t.id}` })}
                    className="text-sm font-medium text-zinc-200 hover:text-amber-400 transition-colors text-left"
                  >
                    {t.title}
                  </button>
                  <span className="text-xs text-zinc-600 font-mono">{t.repoName}/{t.branch}</span>
                </div>

                {t.notes && (
                  <div className="ml-5 text-xs text-zinc-400 leading-relaxed [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:text-zinc-200 [&_a]:text-amber-400 [&_a]:underline [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:rounded">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {t.notes}
                    </ReactMarkdown>
                  </div>
                )}

                {t.filesChanged.length > 0 && (
                  <div className="ml-5 flex flex-wrap gap-1">
                    {t.filesChanged.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/50 text-zinc-500"
                      >
                        <FileCode size={9} />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          ) : (
            <p className="text-xs text-zinc-600">No sessions this day.</p>
          )}
        </div>
      )}
    </div>
  );
}
