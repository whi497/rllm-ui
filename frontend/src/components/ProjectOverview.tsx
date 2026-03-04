"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { BarChartIcon, SearchIcon } from "./icons";
import { Spinner, EmptyState, ThreeDotMenu, CollapsibleSection } from "./ui";
import { getExperimentColor } from "../utils/experimentColors";
import { useExperimentVisibility } from "../contexts/ExperimentVisibilityContext";
import type { Metric } from "../hooks/useSSE";
import { API_BASE_URL, apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

interface Session {
  id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  color: string | null;
  status: "running" | "completed" | "failed" | "crashed";
  created_at: string;
  completed_at: string | null;
}

interface SessionMetrics {
  session: Session;
  metrics: Metric[];
  color: string;
}

/** Groups metric keys by first `/` segment, with priority ordering. */
function groupMetricsByPrefix(metricKeys: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  metricKeys.forEach((key) => {
    const prefix = key.split("/")[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(key);
  });
  const priorityOrder = ["reward", "loss", "accuracy", "progress"];
  const sorted = new Map<string, string[]>();
  priorityOrder.forEach((p) => {
    if (groups.has(p)) {
      sorted.set(p, groups.get(p)!.sort());
      groups.delete(p);
    }
  });
  Array.from(groups.keys())
    .sort()
    .forEach((k) => sorted.set(k, groups.get(k)!.sort()));
  return sorted;
}

export const ProjectOverview: React.FC = () => {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as string;
  const { hiddenExperiments, colorOverrides } = useExperimentVisibility();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionMetrics, setSessionMetrics] = useState<
    Map<string, SessionMetrics>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch sessions for this project (poll to pick up color changes etc.)
  const fetchSessions = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await apiFetch("/api/sessions");
      if (!res.ok) return;
      const data: Session[] = await res.json();
      const projectSessions = data.filter(
        (s: any) => s.project_id === projectId
      );
      setSessions(projectSessions);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const hasRunningSessions = sessions.some(s => s.status === 'running');
  usePolling(fetchSessions, { interval: hasRunningSessions ? 5000 : 60000 });

  // Fetch metrics for each session
  useEffect(() => {
    if (sessions.length === 0) return;
    const apiUrl = API_BASE_URL;

    sessions.forEach(async (session) => {
      try {
        const res = await apiFetch(
          `/api/sessions/${session.id}/metrics`
        );
        if (!res.ok) return;
        const metrics: Metric[] = await res.json();
        setSessionMetrics((prev) => {
          const next = new Map(prev);
          next.set(session.id, {
            session,
            metrics,
            color: session.color || getExperimentColor(session.id),
          });
          return next;
        });
      } catch {
        // ignore
      }
    });

    // Also open SSE streams for live updates (only for running sessions)
    const eventSources: EventSource[] = [];
    const runningSessions = sessions.filter(s => s.status === 'running');
    runningSessions.forEach((session) => {
      const es = new EventSource(
        `${apiUrl}/api/sessions/${session.id}/metrics/stream`,
        { withCredentials: true }
      );
      es.onmessage = (event) => {
        try {
          const metric: Metric = JSON.parse(event.data);
          setSessionMetrics((prev) => {
            const existing = prev.get(session.id);
            if (!existing) return prev;
            if (existing.metrics.some((m) => m.id === metric.id)) return prev;
            const next = new Map(prev);
            next.set(session.id, {
              ...existing,
              metrics: [...existing.metrics, metric],
            });
            return next;
          });
        } catch {
          // ignore
        }
      };
      eventSources.push(es);
    });

    return () => eventSources.forEach((es) => es.close());
  }, [sessions]);

  // Collect all metric keys across all visible sessions
  const allMetricKeys = useMemo(() => {
    const keys = new Set<string>();
    sessionMetrics.forEach((sm, sessionId) => {
      if (hiddenExperiments.has(sessionId)) return;
      sm.metrics.forEach((m) => {
        Object.keys(m.data).forEach((k) => keys.add(k));
      });
    });
    return Array.from(keys).sort();
  }, [sessionMetrics, hiddenExperiments]);

  const grouped = useMemo(
    () => groupMetricsByPrefix(allMetricKeys),
    [allMetricKeys]
  );
  const groupKeys = useMemo(() => Array.from(grouped.keys()), [grouped]);

  // Filter groups by search
  const filteredGrouped = useMemo(() => {
    if (!searchQuery.trim()) return grouped;
    const q = searchQuery.toLowerCase();
    const filtered = new Map<string, string[]>();
    grouped.forEach((keys, prefix) => {
      const matching = keys.filter((k) => k.toLowerCase().includes(q));
      if (matching.length > 0) filtered.set(prefix, matching);
    });
    return filtered;
  }, [grouped, searchQuery]);

  const filteredGroupKeys = useMemo(
    () => Array.from(filteredGrouped.keys()),
    [filteredGrouped]
  );

  // Auto-expand first group
  useEffect(() => {
    if (groupKeys.length > 0 && !hasAutoExpanded) {
      setExpandedGroups(new Set([groupKeys[0]]));
      setHasAutoExpanded(true);
    }
  }, [groupKeys, hasAutoExpanded]);

  // Auto-expand all when searching
  useEffect(() => {
    if (searchQuery.trim()) {
      setExpandedGroups(new Set(filteredGroupKeys));
    }
  }, [searchQuery, filteredGroupKeys]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  };

  const expandAll = () => setExpandedGroups(new Set(filteredGroupKeys));
  const collapseAll = () => setExpandedGroups(new Set());

  // Visible sessions for the charts — resolve color from shared overrides first
  const visibleSessions = useMemo(() => {
    return Array.from(sessionMetrics.values())
      .filter((sm) => !hiddenExperiments.has(sm.session.id))
      .map((sm) => {
        const latestSession = sessions.find((s) => s.id === sm.session.id);
        const color =
          colorOverrides[sm.session.id] ||
          (latestSession?.color ?? sm.session.color) ||
          getExperimentColor(sm.session.id);
        return { ...sm, color };
      });
  }, [sessionMetrics, hiddenExperiments, sessions, colorOverrides]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" variant="black" label="Loading project..." />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        }
        title="No experiments found"
        className="flex-1"
      />
    );
  }

  const filteredCount = Array.from(filteredGrouped.values()).reduce(
    (sum, keys) => sum + keys.length,
    0
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Search + expand/collapse toolbar */}
      <div className="px-4 h-14 border-b border-gray-200 flex items-center gap-3 bg-white flex-shrink-0">
        <div className="flex-1 relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${allMetricKeys.length} metrics...`}
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:border-gray-400 placeholder-gray-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
        {searchQuery && (
          <span className="text-xs text-gray-500 flex-shrink-0">
            {filteredCount} result{filteredCount !== 1 ? "s" : ""}
          </span>
        )}
        <ThreeDotMenu
          actions={[
            { label: "Expand all", onClick: expandAll },
            { label: "Collapse all", onClick: collapseAll },
          ]}
        />
      </div>

      {/* Charts */}
      <div className="flex-1 overflow-y-auto">
        {allMetricKeys.length === 0 ? (
          <EmptyState
            icon={<BarChartIcon size={24} className="text-gray-400" />}
            title="Waiting for metrics"
            className="h-64"
          />
        ) : filteredGroupKeys.length === 0 ? (
          <EmptyState
            icon={<SearchIcon size={24} className="text-gray-400" />}
            title="No matching metrics"
            className="h-32"
          />
        ) : (
          filteredGroupKeys.map((prefix) => {
            const metricKeys = filteredGrouped.get(prefix)!;
            const isExpanded = expandedGroups.has(prefix);
            const totalCount = grouped.get(prefix)?.length ?? 0;
            const isFiltering = searchQuery.trim().length > 0;
            return (
              <CollapsibleSection
                key={prefix}
                isExpanded={isExpanded}
                onToggle={() => toggleGroup(prefix)}
                title={
                  <h3 className="text-sm font-medium text-gray-900 capitalize">
                    {prefix.replace(/_/g, " ")}
                  </h3>
                }
                rightLabel={
                  isFiltering ? (
                    <>
                      <span className="text-accent-600 font-medium">
                        {metricKeys.length}
                      </span>{" "}
                      / {totalCount}
                    </>
                  ) : (
                    <>
                      {metricKeys.length} metric
                      {metricKeys.length !== 1 ? "s" : ""}
                    </>
                  )
                }
                contentClassName="px-4 pb-4 grid grid-cols-3 gap-3"
              >
                {metricKeys.map((metricKey) => (
                  <MultiSeriesChart
                    key={metricKey}
                    metricKey={metricKey}
                    sessions={visibleSessions}
                  />
                ))}
              </CollapsibleSection>
            );
          })
        )}
      </div>
    </div>
  );
};

/* ─── Multi-Series Chart ─────────────────────────────────────────── */

const MultiSeriesChart: React.FC<{
  metricKey: string;
  sessions: SessionMetrics[];
}> = ({ metricKey, sessions }) => {
  const displayName =
    metricKey.split("/").slice(1).join("/") || metricKey;

  // Build chart data: merge all sessions' data points by step
  const { chartData, seriesKeys } = useMemo(() => {
    const stepMap = new Map<number, Record<string, number>>();
    const keys: string[] = [];

    sessions.forEach((sm) => {
      const seriesKey = sm.session.id;
      keys.push(seriesKey);
      sm.metrics.forEach((metric) => {
        if (metric.data[metricKey] === undefined) return;
        const step = metric.step;
        if (!stepMap.has(step)) stepMap.set(step, { step });
        stepMap.get(step)![seriesKey] = metric.data[metricKey];
      });
    });

    const data = Array.from(stepMap.values()).sort(
      (a, b) => a.step - b.step
    );
    return { chartData: data, seriesKeys: keys };
  }, [sessions, metricKey]);

  if (chartData.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-700 font-mono truncate">
            {displayName}
          </span>
        </div>
        <div className="h-44 flex items-center justify-center">
          <p className="text-xs text-gray-400">No data</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden hover:border-gray-300 transition-colors">
      <div className="px-3 py-2 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-700 font-mono truncate">
          {displayName}
        </span>
      </div>
      <div className="h-44 p-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: 15, left: 10, bottom: 10 }}
            style={{ outline: "none" }}
            accessibilityLayer={false}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
            <XAxis
              dataKey="step"
              type="number"
              domain={["dataMin", "dataMax"]}
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "#737373" }}
              tickLine={{ stroke: "#d4d4d4" }}
              axisLine={{ stroke: "#d4d4d4" }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#737373" }}
              tickLine={{ stroke: "#d4d4d4" }}
              axisLine={{ stroke: "#d4d4d4" }}
              domain={["auto", "auto"]}
              padding={{ top: 10, bottom: 10 }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                return (
                  <div className="bg-white border border-gray-200 rounded shadow-sm p-2 text-xs">
                    <div className="font-semibold mb-1">Step {label}</div>
                    {payload.map((entry: any) => {
                      const sm = sessions.find(
                        (s) => s.session.id === entry.dataKey
                      );
                      return (
                        <div
                          key={entry.dataKey}
                          className="flex items-center gap-1.5"
                        >
                          <span
                            className="w-2 h-2 rounded-full inline-block"
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="text-gray-600 truncate max-w-[120px]">
                            {sm?.session.experiment ?? "?"}
                          </span>
                          <span className="font-mono ml-auto">
                            {typeof entry.value === "number"
                              ? entry.value.toFixed(4)
                              : "N/A"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
            {seriesKeys.map((sessionId) => {
              const sm = sessions.find((s) => s.session.id === sessionId);
              return (
                <Line
                  key={sessionId}
                  type="monotone"
                  dataKey={sessionId}
                  stroke={sm?.color ?? "#999"}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
