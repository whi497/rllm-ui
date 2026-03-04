"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LayoutListIcon, TableIcon, ChevronDownIcon, ChevronRightIcon, SortIcon, FolderOpenIcon } from "./icons";
import { EmptyState } from "./ui";
import {
  MOCK_EVAL_SESSIONS,
  MOCK_EVAL_RESULTS,
  getEvalSessionsByDataset,
  type EvalSession,
  type EvalResult,
} from "../mocks/evalData";

type ViewMode = "table" | "leaderboard";
type SortKey = "dataset" | "score" | "model" | "agent" | "correct" | "errors" | "date";
type SortDir = "asc" | "desc";

const StatusBadge: React.FC<{ status: EvalSession["status"] }> = ({ status }) => {
  const config = {
    running:   { label: "Running",   bg: "bg-green-100",  text: "text-green-700",  dot: "bg-green-500",  pulse: true },
    completed: { label: "Completed", bg: "bg-layer-2",    text: "text-gray-600",   dot: "bg-gray-400",   pulse: false },
    failed:    { label: "Failed",    bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500",    pulse: false },
    crashed:   { label: "Crashed",   bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", pulse: false },
  }[status] ?? { label: status, bg: "bg-layer-2", text: "text-gray-600", dot: "bg-gray-400", pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className="relative flex w-1.5 h-1.5">
        {config.pulse && (
          <span className={`absolute inset-0 rounded-full ${config.dot} opacity-75 animate-ping`} />
        )}
        <span className={`relative block w-1.5 h-1.5 rounded-full ${config.dot}`} />
      </span>
      {config.label}
    </span>
  );
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatPercent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export const EvalPage: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const grouped = useMemo(() => getEvalSessionsByDataset(), []);
  const datasets = Object.keys(grouped);

  const allRuns = useMemo(() => {
    const runs: Array<EvalSession & { result: EvalResult }> = [];
    for (const dataset of datasets) {
      runs.push(...grouped[dataset]);
    }
    return runs;
  }, [grouped, datasets]);

  if (datasets.length === 0) {
    return (
      <div className="h-full p-8 overflow-auto flex items-center justify-center">
        <EmptyState
          icon={<span className="text-2xl">📋</span>}
          title="No evaluations yet"
          description="Run an evaluation to see results here."
        />
      </div>
    );
  }

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold text-black">Evaluation</h1>
          <div className="flex items-center gap-1 bg-layer-2 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("table")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "table"
                  ? "bg-white shadow-subtle text-gray-900"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="Table view"
            >
              <LayoutListIcon size={16} />
            </button>
            <button
              onClick={() => setViewMode("leaderboard")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "leaderboard"
                  ? "bg-white shadow-subtle text-gray-900"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="Leaderboard view"
            >
              <TableIcon size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        {viewMode === "table" ? (
          <FlatTableView runs={allRuns} />
        ) : (
          <LeaderboardView grouped={grouped} datasets={datasets} />
        )}
      </div>
    </div>
  );
};

// ─── Flat Table View (default) ──────────────────────────────────────

const FlatTableView: React.FC<{
  runs: Array<EvalSession & { result: EvalResult }>;
}> = ({ runs }) => {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });

  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "desc" ? "asc" : "desc" };
      }
      return { key, dir: "desc" };
    });
  };

  const sorted = useMemo(() => {
    return [...runs].sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "dataset": cmp = a.result.dataset_name.localeCompare(b.result.dataset_name); break;
        case "score": cmp = a.result.score - b.result.score; break;
        case "model": cmp = a.result.model.localeCompare(b.result.model); break;
        case "agent": cmp = a.result.agent.localeCompare(b.result.agent); break;
        case "correct": cmp = a.result.correct - b.result.correct; break;
        case "errors": cmp = a.result.errors - b.result.errors; break;
        case "date": cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
      }
      return sort.dir === "desc" ? -cmp : cmp;
    });
  }, [runs, sort]);

  const SortHeader: React.FC<{ sortKey: SortKey; label: string }> = ({ sortKey, label }) => {
    const isActive = sort.key === sortKey;
    return (
      <th
        onClick={() => handleSort(sortKey)}
        className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive && <SortIcon size={12} className="text-accent-500" />}
        </span>
      </th>
    );
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <table className="w-full">
        <thead className="bg-layer-1">
          <tr>
            <SortHeader sortKey="dataset" label="Dataset" />
            <SortHeader sortKey="model" label="Model" />
            <SortHeader sortKey="agent" label="Agent" />
            <SortHeader sortKey="score" label="Score" />
            <SortHeader sortKey="correct" label="Correct/Total" />
            <SortHeader sortKey="errors" label="Errors" />
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
            <SortHeader sortKey="date" label="Date" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((run) => (
            <tr
              key={run.id}
              onClick={() => router.push(`/evaluation/${run.id}`)}
              className="hover:bg-layer-1 cursor-pointer transition-colors"
            >
              <td className="px-3 py-2.5 text-sm text-gray-600">
                {run.result.dataset_name}
              </td>
              <td className="px-3 py-2.5 text-sm font-medium text-gray-900">
                {run.result.model}
              </td>
              <td className="px-3 py-2.5 text-sm text-gray-600">
                {run.result.agent}
              </td>
              <td className="px-3 py-2.5 text-sm font-semibold text-black">
                {formatPercent(run.result.score)}
              </td>
              <td className="px-3 py-2.5 text-sm text-gray-600 font-mono">
                {run.result.correct}/{run.result.total}
              </td>
              <td className="px-3 py-2.5 text-sm text-gray-600">
                {run.result.errors > 0 ? (
                  <span className="text-red-500">{run.result.errors}</span>
                ) : (
                  <span className="text-gray-400">0</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={run.status} />
              </td>
              <td className="px-3 py-2.5 text-xs text-gray-400">
                {formatDate(run.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Leaderboard View (grouped by dataset folders) ──────────────────

const LeaderboardView: React.FC<{
  grouped: Record<string, Array<EvalSession & { result: EvalResult }>>;
  datasets: string[];
}> = ({ grouped, datasets }) => {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sortState, setSortState] = useState<Record<string, { key: SortKey; dir: SortDir }>>({});

  const toggleDataset = (dataset: string) => {
    setExpanded((prev) => ({ ...prev, [dataset]: !prev[dataset] }));
  };

  const handleSort = (dataset: string, key: SortKey) => {
    setSortState((prev) => {
      const current = prev[dataset];
      if (current?.key === key) {
        return { ...prev, [dataset]: { key, dir: current.dir === "desc" ? "asc" : "desc" } };
      }
      return { ...prev, [dataset]: { key, dir: "desc" } };
    });
  };

  const getSorted = (dataset: string, runs: Array<EvalSession & { result: EvalResult }>) => {
    const sort = sortState[dataset] ?? { key: "score" as SortKey, dir: "desc" as SortDir };
    return [...runs].sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "score": cmp = a.result.score - b.result.score; break;
        case "model": cmp = a.result.model.localeCompare(b.result.model); break;
        case "agent": cmp = a.result.agent.localeCompare(b.result.agent); break;
        case "correct": cmp = a.result.correct - b.result.correct; break;
        case "errors": cmp = a.result.errors - b.result.errors; break;
        case "date": cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
      }
      return sort.dir === "desc" ? -cmp : cmp;
    });
  };

  const SortHeader: React.FC<{ dataset: string; sortKey: SortKey; label: string }> = ({
    dataset, sortKey, label,
  }) => {
    const sort = sortState[dataset] ?? { key: "score", dir: "desc" };
    const isActive = sort.key === sortKey;
    return (
      <th
        onClick={() => handleSort(dataset, sortKey)}
        className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive && <SortIcon size={12} className="text-accent-500" />}
        </span>
      </th>
    );
  };

  return (
    <div className="space-y-3">
      {datasets.map((dataset) => {
        const runs = grouped[dataset];
        const isExpanded = expanded[dataset] ?? false;
        const bestScore = Math.max(...runs.map((r) => r.result.score));

        return (
          <div key={dataset} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {/* Dataset folder header */}
            <button
              onClick={() => toggleDataset(dataset)}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-layer-1 transition-colors text-left"
            >
              {isExpanded ? (
                <ChevronDownIcon size={16} className="text-gray-400 flex-shrink-0" />
              ) : (
                <ChevronRightIcon size={16} className="text-gray-400 flex-shrink-0" />
              )}
              <FolderOpenIcon size={16} className="text-accent-500 flex-shrink-0" />
              <span className="text-sm font-semibold text-gray-900 flex-1">{dataset}</span>
              <span className="text-xs text-gray-400 mr-2">
                {runs.length} run{runs.length !== 1 ? "s" : ""}
              </span>
              <span className="text-sm font-semibold text-black font-mono">
                {formatPercent(bestScore)}
              </span>
              <span className="text-xs text-gray-400">best</span>
            </button>

            {/* Expanded table */}
            {isExpanded && (
              <div className="border-t border-gray-200">
                <table className="w-full">
                  <thead className="bg-layer-1">
                    <tr>
                      <SortHeader dataset={dataset} sortKey="model" label="Model" />
                      <SortHeader dataset={dataset} sortKey="agent" label="Agent" />
                      <SortHeader dataset={dataset} sortKey="score" label="Score" />
                      <SortHeader dataset={dataset} sortKey="correct" label="Correct/Total" />
                      <SortHeader dataset={dataset} sortKey="errors" label="Errors" />
                      {(() => {
                        const allSignals = new Set<string>();
                        runs.forEach((r) => Object.keys(r.result.signal_averages).forEach((s) => allSignals.add(s)));
                        return Array.from(allSignals).map((sig) => (
                          <th key={sig} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {sig}
                          </th>
                        ));
                      })()}
                      <SortHeader dataset={dataset} sortKey="date" label="Date" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {getSorted(dataset, runs).map((run) => {
                      const allSignals = new Set<string>();
                      runs.forEach((r) => Object.keys(r.result.signal_averages).forEach((s) => allSignals.add(s)));
                      const signals = Array.from(allSignals);

                      return (
                        <tr
                          key={run.id}
                          onClick={() => router.push(`/evaluation/${run.id}`)}
                          className="hover:bg-layer-1 cursor-pointer transition-colors"
                        >
                          <td className="px-3 py-2.5 text-sm font-medium text-gray-900">
                            {run.result.model}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-600">
                            {run.result.agent}
                          </td>
                          <td className="px-3 py-2.5 text-sm font-semibold text-black">
                            {formatPercent(run.result.score)}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-600 font-mono">
                            {run.result.correct}/{run.result.total}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-600">
                            {run.result.errors > 0 ? (
                              <span className="text-red-500">{run.result.errors}</span>
                            ) : (
                              <span className="text-gray-400">0</span>
                            )}
                          </td>
                          {signals.map((sig) => (
                            <td key={sig} className="px-3 py-2.5 text-sm text-gray-600 font-mono">
                              {run.result.signal_averages[sig] != null
                                ? formatPercent(run.result.signal_averages[sig])
                                : "—"}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-xs text-gray-400">
                            {formatDate(run.created_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EvalPage;
