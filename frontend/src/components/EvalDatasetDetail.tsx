"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowBackIcon, SearchIcon } from "./icons";
import { HighlightedText } from "./HighlightedText";
import { Spinner } from "./ui";
import { apiFetch } from "../config/api";

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
  result: EvalResult;
}

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

export const EvalDatasetDetail: React.FC = () => {
  const params = useParams();
  const router = useRouter();
  const datasetName = decodeURIComponent(params?.datasetName as string);

  const [rows, setRows] = useState<EvalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [sessResp, resultsResp] = await Promise.all([
        apiFetch("/api/sessions?type=eval"),
        apiFetch("/api/eval-results"),
      ]);

      if (!sessResp.ok || !resultsResp.ok) return;

      const sessions: Session[] = await sessResp.json();
      const results: EvalResult[] = await resultsResp.json();

      const resultMap = new Map<string, EvalResult>();
      for (const r of results) resultMap.set(r.session_id, r);

      const matched: EvalRow[] = [];
      for (const s of sessions) {
        const r = resultMap.get(s.id);
        if (r && r.dataset_name === datasetName) {
          matched.push({ session: s, result: r });
        }
      }
      // Sort by score descending
      matched.sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0));
      setRows(matched);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [datasetName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredRows = useMemo(() => {
    if (!searchQuery) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) =>
      r.session.experiment.toLowerCase().includes(q) ||
      r.result.model.toLowerCase().includes(q) ||
      r.result.agent.toLowerCase().includes(q)
    );
  }, [rows, searchQuery]);

  const signalNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) {
      if (row.result.signal_averages) {
        for (const name of Object.keys(row.result.signal_averages)) {
          names.add(name);
        }
      }
    }
    return Array.from(names);
  }, [rows]);

  const bestScore = rows.length > 0 ? Math.max(...rows.map((r) => r.result.score)) : 0;

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
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => router.push("/evaluation")}
              className="p-1 hover:bg-layer-2 text-gray-400 hover:text-gray-700 rounded-md transition-colors"
              title="Back to evaluations"
            >
              <ArrowBackIcon size={20} />
            </button>
            <h1 className="text-lg font-semibold text-black">{datasetName}</h1>
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
            <span className="font-medium text-black">{rows.length}</span> run{rows.length !== 1 ? "s" : ""}
            {rows.length > 0 && (
              <>
                {" "}&middot;{" "}
                Best: <span className={`font-medium ${bestScore >= 0.5 ? "text-green-600" : bestScore >= 0.2 ? "text-amber-600" : "text-red-600"}`}>
                  {formatScore(bestScore)}
                </span>
              </>
            )}
          </p>
        </div>

        {/* Table */}
        <div className="bg-white border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Experiment</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Model</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Agent</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Score</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Correct/Total</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Errors</th>
                {signalNames.map((name) => (
                  <th key={name} className="px-3 py-3 text-left text-sm font-medium text-gray-500">{name}</th>
                ))}
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Status</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.map((row) => {
                const r = row.result;
                return (
                  <tr
                    key={row.session.id}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => router.push(`/evaluation/${row.session.id}`)}
                  >
                    <td className="px-4 py-2.5 text-sm font-medium text-gray-900"><HighlightedText text={row.session.experiment} searchQuery={searchQuery} /></td>
                    <td className="px-3 py-2.5 text-sm text-gray-600 font-mono"><HighlightedText text={r.model} searchQuery={searchQuery} /></td>
                    <td className="px-3 py-2.5 text-sm text-gray-600"><HighlightedText text={r.agent} searchQuery={searchQuery} /></td>
                    <td className="px-3 py-2.5 text-sm font-semibold">
                      <span className={r.score >= 0.5 ? "text-green-600" : r.score >= 0.2 ? "text-amber-600" : "text-red-600"}>
                        {formatScore(r.score)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-gray-500">{r.correct}/{r.total}</td>
                    <td className="px-3 py-2.5 text-sm">
                      <span className={r.errors > 0 ? "text-red-600 font-medium" : "text-gray-400"}>{r.errors}</span>
                    </td>
                    {signalNames.map((name) => (
                      <td key={name} className="px-3 py-2.5 text-sm text-gray-500">
                        {r.signal_averages?.[name] != null ? r.signal_averages[name].toFixed(3) : "-"}
                      </td>
                    ))}
                    <td className="px-3 py-2.5"><StatusBadge status={row.session.status} /></td>
                    <td className="px-3 py-2.5 text-sm text-gray-400">{formatDate(row.session.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
