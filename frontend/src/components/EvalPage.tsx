"use client";

import React, { useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ClipboardCheckIcon,
  SearchIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { HighlightedText } from "./HighlightedText";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

type SessionStatus = "running" | "completed" | "failed" | "crashed";

interface Session {
  id: string;
  project_id: string;
  project: string;
  experiment: string;
  status: SessionStatus;
  session_type: string;
  created_at: string;
  completed_at: string | null;
}

interface EvalResult {
  id: string;
  session_id: string;
  dataset_name: string;
  model: string;
  agent: string;
  score: number;
  total: number;
  correct: number;
  errors: number;
  signal_averages: Record<string, number>;
  created_at: string;
}

interface EvalRow {
  session: Session;
  result: EvalResult | null;
}

type SortField = "dataset" | "experiment" | "model" | "agent" | "score" | "total" | "errors" | "status" | "date";
type SortDir = "asc" | "desc";
type ViewMode = "flat" | "leaderboard";

const StatusBadge: React.FC<{ status: SessionStatus }> = ({ status }) => {
  const config = {
    running: { label: "Running", bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", pulse: true },
    completed: { label: "Completed", bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false },
    failed: { label: "Failed", bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500", pulse: false },
    crashed: { label: "Crashed", bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", pulse: false },
  }[status] ?? { label: status, bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className="relative flex w-1.5 h-1.5">
        {config.pulse && <span className={`absolute inset-0 rounded-full ${config.dot} animate-ping opacity-75`} />}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${config.dot}`} />
      </span>
      {config.label}
    </span>
  );
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export const EvalPage: React.FC = () => {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [results, setResults] = useState<Map<string, EvalResult>>(new Map());
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const initialLoadDone = useRef(false);

  const fetchData = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      // Fetch eval sessions
      const sessResp = await apiFetch("/api/sessions?type=eval");
      if (!sessResp.ok) throw new Error("Failed to fetch sessions");
      const sessData: Session[] = await sessResp.json();
      setSessions(sessData);

      // Fetch eval results for all sessions
      const resultsResp = await apiFetch("/api/eval-results");
      if (resultsResp.ok) {
        const resultsData: EvalResult[] = await resultsResp.json();
        const map = new Map<string, EvalResult>();
        for (const r of resultsData) {
          map.set(r.session_id, r);
        }
        setResults(map);
      }
    } catch {
      if (!initialLoadDone.current) setSessions([]);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  const hasRunning = sessions.some((s) => s.status === "running");
  usePolling(fetchData, { interval: hasRunning ? 5000 : 60000 });

  // Build rows
  const rows: EvalRow[] = useMemo(() => {
    return sessions.map((s) => ({
      session: s,
      result: results.get(s.id) || null,
    }));
  }, [sessions, results]);

  // Filter by search
  const filteredRows = useMemo(() => {
    if (!searchQuery) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) => {
      const res = r.result;
      return (
        r.session.experiment.toLowerCase().includes(q) ||
        r.session.project.toLowerCase().includes(q) ||
        (res?.dataset_name || "").toLowerCase().includes(q) ||
        (res?.model || "").toLowerCase().includes(q) ||
        (res?.agent || "").toLowerCase().includes(q)
      );
    });
  }, [rows, searchQuery]);

  // Sort
  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      let cmp = 0;
      const ar = a.result;
      const br = b.result;
      switch (sortField) {
        case "dataset": cmp = (ar?.dataset_name || "").localeCompare(br?.dataset_name || ""); break;
        case "experiment": cmp = a.session.experiment.localeCompare(b.session.experiment); break;
        case "model": cmp = (ar?.model || "").localeCompare(br?.model || ""); break;
        case "agent": cmp = (ar?.agent || "").localeCompare(br?.agent || ""); break;
        case "score": cmp = (ar?.score ?? -1) - (br?.score ?? -1); break;
        case "total": cmp = (ar?.total ?? 0) - (br?.total ?? 0); break;
        case "errors": cmp = (ar?.errors ?? 0) - (br?.errors ?? 0); break;
        case "status": cmp = a.session.status.localeCompare(b.session.status); break;
        case "date": cmp = new Date(a.session.created_at).getTime() - new Date(b.session.created_at).getTime(); break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return sorted;
  }, [filteredRows, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "date" ? "desc" : "asc");
    }
  };

  // Leaderboard: group by dataset
  const datasetGroups = useMemo(() => {
    const map = new Map<string, EvalRow[]>();
    for (const row of filteredRows) {
      const ds = row.result?.dataset_name || "Unknown";
      if (!map.has(ds)) map.set(ds, []);
      map.get(ds)!.push(row);
    }
    // Sort each group by score descending
    for (const [, rows] of map) {
      rows.sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0));
    }
    return map;
  }, [filteredRows]);

  const SortHeader: React.FC<{ field: SortField; children: React.ReactNode; className?: string }> = ({ field, children, className = "" }) => (
    <th
      className={`px-3 py-3 text-left text-sm font-medium text-gray-500 cursor-pointer select-none hover:text-gray-700 ${className}`}
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortField === field && <span className="text-accent-600">{sortDir === "asc" ? "\u2191" : "\u2193"}</span>}
      </span>
    </th>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full">
        {/* Header */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-lg font-semibold text-black">Evaluation</h1>
            {/* by Dataset toggle */}
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <span className={`text-xs ${viewMode === "leaderboard" ? "text-gray-900" : "text-gray-500"}`}>
                by Dataset
              </span>
              <button
                role="switch"
                aria-checked={viewMode === "leaderboard"}
                onClick={() => setViewMode(viewMode === "leaderboard" ? "flat" : "leaderboard")}
                className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                  viewMode === "leaderboard" ? "bg-accent-500" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                    viewMode === "leaderboard" ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </label>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <SearchIcon size={18} className="text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search runs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 transition-all duration-200"
            />
          </div>
        </div>

        {/* Summary */}
        <div className="mb-4">
          <p className="text-sm text-gray-600">
            <span className="font-medium text-black">{sessions.length}</span> run{sessions.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Content */}
        {sessions.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <EmptyState
              icon={<ClipboardCheckIcon size={32} className="text-gray-400" />}
              title="No evaluation runs yet"
              description="Run rllm eval with --ui to see results here."
              iconSize="lg"
            />
          </div>
        ) : viewMode === "flat" ? (
          /* ── Flat table ── */
          <div className="bg-white border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <SortHeader field="dataset">Dataset</SortHeader>
                  <SortHeader field="experiment">Experiment</SortHeader>
                  <SortHeader field="model">Model</SortHeader>
                  <SortHeader field="agent">Agent</SortHeader>
                  <SortHeader field="score">Score</SortHeader>
                  <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Correct/Total</th>
                  <SortHeader field="errors">Errors</SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                  <SortHeader field="date">Date</SortHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedRows.map((row) => {
                  const r = row.result;
                  return (
                    <tr
                      key={row.session.id}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => router.push(`/evaluation/${row.session.id}`)}
                    >
                      <td className="px-3 py-2.5 text-sm font-medium text-gray-900"><HighlightedText text={r?.dataset_name || "-"} searchQuery={searchQuery} /></td>
                      <td className="px-3 py-2.5 text-sm text-gray-600"><HighlightedText text={row.session.experiment} searchQuery={searchQuery} /></td>
                      <td className="px-3 py-2.5 text-sm text-gray-600 font-mono"><HighlightedText text={r?.model || "-"} searchQuery={searchQuery} /></td>
                      <td className="px-3 py-2.5 text-sm text-gray-600"><HighlightedText text={r?.agent || "-"} searchQuery={searchQuery} /></td>
                      <td className="px-3 py-2.5 text-sm font-semibold">
                        {r ? (
                          <span className={r.score >= 0.5 ? "text-green-600" : r.score >= 0.2 ? "text-amber-600" : "text-red-600"}>
                            {formatScore(r.score)}
                          </span>
                        ) : "-"}
                      </td>
                      <td className="px-3 py-2.5 text-sm text-gray-500">{r ? `${r.correct}/${r.total}` : "-"}</td>
                      <td className="px-3 py-2.5 text-sm">
                        {r ? (
                          <span className={r.errors > 0 ? "text-red-600 font-medium" : "text-gray-400"}>{r.errors}</span>
                        ) : "-"}
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge status={row.session.status} /></td>
                      <td className="px-3 py-2.5 text-sm text-gray-400">{formatDate(row.session.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* ── Leaderboard (dataset folders) ── */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from(datasetGroups.entries()).map(([dataset, groupRows]) => (
              <DatasetFolder
                key={dataset}
                dataset={dataset}
                rows={groupRows}
                onClick={() => router.push(`/evaluation/dataset/${encodeURIComponent(dataset)}`)}
                searchQuery={searchQuery}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const DatasetFolder: React.FC<{
  dataset: string;
  rows: EvalRow[];
  onClick: () => void;
  searchQuery?: string;
}> = ({ dataset, rows, onClick, searchQuery = "" }) => {
  const bestScore = Math.max(...rows.map((r) => r.result?.score ?? 0));
  const latestRow = rows.reduce((a, b) =>
    new Date(a.session.created_at) > new Date(b.session.created_at) ? a : b
  );
  const timeAgo = getTimeAgo(new Date(latestRow.session.created_at));

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl p-4 text-left hover:border-gray-300 hover:shadow-sm transition-all cursor-pointer"
      onClick={onClick}
    >
      <div className="text-sm font-semibold text-black mb-1 truncate">
        <HighlightedText text={dataset} searchQuery={searchQuery} />
      </div>
      <div className="text-xs text-gray-500">
        {rows.length} run{rows.length !== 1 ? "s" : ""}
        <span className="text-gray-400"> &middot; {timeAgo}</span>
      </div>
      <div className="mt-2 text-xs">
        <span className={`font-semibold ${bestScore >= 0.5 ? "text-green-600" : bestScore >= 0.2 ? "text-amber-600" : "text-red-600"}`}>
          Best: {formatScore(bestScore)}
        </span>
      </div>
    </div>
  );
};

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
