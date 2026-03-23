"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActivityIcon, SearchIcon, BarChartIcon, ListIcon, DatabaseIcon } from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";
import { ObservabilityDashboard } from "./ObservabilityDashboard";

interface AgentSession {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, any> | null;
  created_at: string;
  completed_at: string | null;
  span_count: number | null;
}

interface PaginatedSessions {
  items: AgentSession[];
  total: number;
  offset: number;
  limit: number;
}

type DataSource = "clickhouse" | "bigquery" | "postgres";

const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  clickhouse: "ClickHouse",
  bigquery: "BigQuery",
  postgres: "Imported",
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { label: string; bg: string; text: string; dot: string; pulse: boolean }> = {
    running: { label: "Running", bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", pulse: true },
    completed: { label: "Completed", bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false },
    failed: { label: "Failed", bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500", pulse: false },
  };
  const c = config[status] ?? { label: status, bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className="relative flex w-1.5 h-1.5">
        {c.pulse && <span className={`absolute inset-0 rounded-full ${c.dot} animate-ping opacity-75`} />}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${c.dot}`} />
      </span>
      {c.label}
    </span>
  );
};

function formatDate(iso: string): string {
  // Backend returns UTC timestamps without Z suffix — normalize so JS parses as UTC
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

type ViewMode = "dashboard" | "sessions";

const TrashIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);

const RefreshIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

/* ─── Inline BigQuery setup form ──────────────────────────────── */

interface BqConfig {
  project: string;
  dataset: string;
  table: string;
}

const BigQuerySetup: React.FC<{
  onConfigured: () => void;
  onDismiss?: () => void;
  initial?: BqConfig | null;
}> = ({ onConfigured, onDismiss, initial }) => {
  const [project, setProject] = useState(initial?.project ?? "");
  const [dataset, setDataset] = useState(initial?.dataset ?? "");
  const [table, setTable] = useState(initial?.table ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveSetting = async (key: string, value: string) => {
    const res = await apiFetch(`/api/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return res.ok;
  };

  const handleSave = async () => {
    if (!project.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (!(await saveSetting("bq_project", project.trim()))) { setError("Failed to save project."); return; }
      if (dataset.trim() && !(await saveSetting("bq_dataset", dataset.trim()))) { setError("Failed to save dataset."); return; }
      if (table.trim() && !(await saveSetting("bq_table", table.trim()))) { setError("Failed to save table."); return; }
      onConfigured();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 max-w-md mx-auto mt-12 relative">
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          title="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <div className="flex items-center gap-2 mb-1">
        <DatabaseIcon size={18} className="text-gray-400" />
        <h3 className="text-base font-semibold text-gray-900">{initial?.project ? "Update BigQuery Connection" : "Connect BigQuery"}</h3>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Enter your GCP project, dataset, and table to read agent traces.
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">GCP Project</label>
          <input
            type="text"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="my-gcp-project"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Dataset</label>
          <input
            type="text"
            value={dataset}
            onChange={(e) => setDataset(e.target.value)}
            placeholder="agent_traces"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400"
          />
          <p className="mt-1 text-xs text-gray-400">Defaults to &quot;agent_traces&quot; if left blank.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Table</label>
          <input
            type="text"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            placeholder="rllm_traces"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400"
          />
          <p className="mt-1 text-xs text-gray-400">Defaults to &quot;rllm_traces&quot; if left blank.</p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          onClick={handleSave}
          disabled={saving || !project.trim()}
          className="w-full py-2 px-4 bg-black hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
};

const PAGE_SIZE = 20;

const ENABLED_SOURCES: DataSource[] = ["postgres", "clickhouse", "bigquery"];
const VALID_SOURCES: DataSource[] = ["postgres", "clickhouse", "bigquery"];
const VALID_VIEWS: ViewMode[] = ["dashboard", "sessions"];

export const ObservabilityPage: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Initialize state from URL search params
  const initSource = ENABLED_SOURCES.includes(searchParams.get("source") as DataSource)
    ? (searchParams.get("source") as DataSource)
    : "postgres";
  const initView = VALID_VIEWS.includes(searchParams.get("view") as ViewMode)
    ? (searchParams.get("view") as ViewMode)
    : "dashboard";
  const initPage = Math.max(0, parseInt(searchParams.get("page") || "0", 10) || 0);

  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [page, setPage] = useState(initPage);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(initView);
  const [dataSource, setDataSource] = useState<DataSource>(initSource);
  const initialLoadDone = useRef(false);
  const [deleteConfirmSource, setDeleteConfirmSource] = useState<DataSource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bqNeedsSetup, setBqNeedsSetup] = useState(false);
  const [bqConfig, setBqConfig] = useState<{ project: string; dataset: string; table: string } | null>(null);

  // Fetch BQ config when BigQuery is selected
  useEffect(() => {
    if (dataSource !== "bigquery") { setBqConfig(null); return; }
    (async () => {
      try {
        const res = await apiFetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          if (data.bq_project) {
            setBqConfig({
              project: data.bq_project,
              dataset: data.bq_dataset || "agent_traces",
              table: data.bq_table || "rllm_traces",
            });
          }
        }
      } catch { /* ignore */ }
    })();
  }, [dataSource, bqNeedsSetup]);

  // Keep URL in sync (replaceState to avoid polluting history)
  useEffect(() => {
    const params = new URLSearchParams();
    if (dataSource !== "postgres") params.set("source", dataSource);
    if (viewMode !== "dashboard") params.set("view", viewMode);
    if (page > 0) params.set("page", String(page));
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  }, [dataSource, viewMode, page]);

  const fetchSessions = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const offset = page * PAGE_SIZE;
      const resp = await apiFetch(
        `/api/agent-sessions?source=${dataSource}&limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!resp.ok) {
        if (resp.status === 503 && dataSource === "bigquery") {
          setBqNeedsSetup(true);
          setSessions([]);
          setTotalSessions(0);
          return;
        }
        if (resp.status === 503) {
          setSessions([]);
          setTotalSessions(0);
          return;
        }
        throw new Error("Failed to fetch agent sessions");
      }
      if (dataSource === "bigquery") setBqNeedsSetup(false);
      const data: PaginatedSessions = await resp.json();
      setSessions(data.items);
      setTotalSessions(data.total);
    } catch {
      if (!initialLoadDone.current) {
        setSessions([]);
        setTotalSessions(0);
      }
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [dataSource, page]);

  const hasRunning = sessions.some((s) => s.status === "running");
  usePolling(fetchSessions, { interval: hasRunning ? 5000 : 30000 });

  // Fetch immediately when page or dataSource changes (polling hook only fires on interval)
  const prevPage = useRef(page);
  const prevSource = useRef(dataSource);
  useEffect(() => {
    if (prevPage.current !== page || prevSource.current !== dataSource) {
      prevPage.current = page;
      prevSource.current = dataSource;
      fetchSessions();
    }
  }, [page, dataSource, fetchSessions]);

  // Reset page when switching data source
  const handleSourceChange = (source: DataSource) => {
    setDataSource(source);
    setPage(0);
    initialLoadDone.current = false;
    setLoading(true);
    if (source !== "bigquery") setBqNeedsSetup(false);
  };

  const handleDeleteAll = async () => {
    if (!deleteConfirmSource) return;
    setDeleting(true);
    try {
      const resp = await apiFetch(`/api/agent-sessions/all?source=${deleteConfirmSource}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        alert(`Delete failed: ${body.detail || resp.statusText}`);
        return;
      }
      // Refresh data
      setDeleteConfirmSource(null);
      initialLoadDone.current = false;
      setPage(0);
      setLoading(true);
      fetchSessions();
    } catch (err) {
      alert(`Delete failed: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    if (!searchQuery) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  const totalPages = Math.ceil(totalSessions / PAGE_SIZE);

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
        {/* Header with view toggle */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold text-black">Observability</h1>
            {/* Data source toggle */}
            <div className="flex items-center gap-1.5 bg-gray-100 rounded-lg p-0.5">
              <DatabaseIcon size={13} className="text-gray-400 ml-2" />
              {(["postgres", "clickhouse", "bigquery"] as const).map((src) => (
                <button
                  key={src}
                  onClick={() => handleSourceChange(src)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                    dataSource === src
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {DATA_SOURCE_LABELS[src]}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setLoading(true); fetchSessions(); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-100 transition-all"
              title="Refresh sessions"
            >
              <RefreshIcon size={13} />
              Refresh
            </button>
            <button
              onClick={() => setDeleteConfirmSource(dataSource)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-red-600 hover:bg-red-50 transition-all"
              title={`Delete all ${DATA_SOURCE_LABELS[dataSource]} data`}
            >
              <TrashIcon size={13} />
              Delete All
            </button>
          </div>
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("dashboard")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === "dashboard"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <BarChartIcon size={13} />
              Dashboard
            </button>
            <button
              onClick={() => setViewMode("sessions")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === "sessions"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <ListIcon size={13} />
              Sessions
            </button>
          </div>
        </div>

        {/* BigQuery connection info */}
        {dataSource === "bigquery" && bqConfig && !bqNeedsSetup && (
          <div className="mb-4 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg flex items-center gap-2 text-xs text-gray-500">
            <DatabaseIcon size={12} className="text-gray-400 flex-shrink-0" />
            <span className="font-mono">
              {bqConfig.project}.{bqConfig.dataset}.{bqConfig.table}
            </span>
            <button
              onClick={() => setBqNeedsSetup(true)}
              className="ml-auto text-gray-400 hover:text-gray-600 transition-colors"
            >
              Change
            </button>
          </div>
        )}

        {bqNeedsSetup && dataSource === "bigquery" ? (
          <BigQuerySetup
            initial={bqConfig}
            onConfigured={() => { setBqNeedsSetup(false); fetchSessions(); }}
            onDismiss={bqConfig ? () => setBqNeedsSetup(false) : undefined}
          />
        ) : viewMode === "dashboard" ? (
          <ObservabilityDashboard dataSource={dataSource} />
        ) : (
          <>
            {/* Search */}
            <div className="mb-6">
              <div className="relative max-w-md">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <SearchIcon size={18} className="text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Search by name, session ID, or status..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 transition-all duration-200"
                />
              </div>
            </div>

            {/* Summary */}
            <div className="mb-4">
              <p className="text-sm text-gray-600">
                <span className="font-medium text-black">{totalSessions}</span> agent session
                {totalSessions !== 1 ? "s" : ""}
              </p>
            </div>

            {/* Content */}
            {sessions.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
                <EmptyState
                  icon={<ActivityIcon size={32} className="text-gray-400" />}
                  title="No agent sessions yet"
                  description="Instrument an ADK agent with rllm_telemetry to see spans here."
                  iconSize="lg"
                />
              </div>
            ) : (
              <>
                <div className="bg-white border border-gray-200 overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Name</th>
                        <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Status</th>
                        <th className="px-3 py-3 text-right text-sm font-medium text-gray-500">Spans</th>
                        <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Duration</th>
                        <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Created</th>
                        <th className="px-3 py-3 text-left text-sm font-medium text-gray-500">Session ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map((session) => (
                        <tr
                          key={session.id}
                          className="hover:bg-gray-50 cursor-pointer transition-colors"
                          onClick={() =>
                            router.push(`/observability/${session.id}?source=${dataSource}`)
                          }
                        >
                          <td className="px-3 py-2.5 text-sm font-medium text-gray-900">{session.name}</td>
                          <td className="px-3 py-2.5">
                            <StatusBadge status={session.status} />
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-500 text-right tabular-nums">
                            {session.span_count ?? "-"}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-500">
                            {formatDuration(session.created_at, session.completed_at)}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-gray-400">{formatDate(session.created_at)}</td>
                          <td className="px-3 py-2.5 text-sm text-gray-400 font-mono">{session.id.slice(0, 8)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-gray-500">
                      Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalSessions)} of{" "}
                      {totalSessions}
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage(Math.max(0, page - 1))}
                        disabled={page === 0}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        // Show pages around current page
                        let pageNum: number;
                        if (totalPages <= 5) {
                          pageNum = i;
                        } else if (page < 3) {
                          pageNum = i;
                        } else if (page > totalPages - 4) {
                          pageNum = totalPages - 5 + i;
                        } else {
                          pageNum = page - 2 + i;
                        }
                        return (
                          <button
                            key={pageNum}
                            onClick={() => setPage(pageNum)}
                            className={`w-8 h-8 text-xs font-medium rounded-md ${
                              page === pageNum
                                ? "bg-accent-100 text-accent-700 border border-accent-200"
                                : "text-gray-600 hover:bg-gray-50 border border-gray-200"
                            }`}
                          >
                            {pageNum + 1}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                        disabled={page >= totalPages - 1}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirmSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => !deleting && setDeleteConfirmSource(null)} />
          <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-2">
              Delete all {DATA_SOURCE_LABELS[deleteConfirmSource]} data?
            </h3>
            <p className="text-sm text-gray-600 mb-1">
              This will permanently delete:
            </p>
            <ul className="text-sm text-gray-600 mb-4 list-disc list-inside space-y-0.5">
              <li>All sessions and spans in <span className="font-medium">{DATA_SOURCE_LABELS[deleteConfirmSource]}</span></li>
              <li>All distilled skills</li>
              <li>All session clusters</li>
              <li>All eval results and uploads</li>
              <li>All background jobs</li>
            </ul>
            <p className="text-xs text-red-600 font-medium mb-4">
              This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirmSource(null)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {deleting ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Deleting...
                  </>
                ) : (
                  "Delete Everything"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
