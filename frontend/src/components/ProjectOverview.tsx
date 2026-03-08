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
  Brush,
} from "recharts";
import { BarChartIcon, SearchIcon, PushPinIcon, MaximizeIcon } from "./icons";
import { Spinner, EmptyState, ThreeDotMenu, CollapsibleSection } from "./ui";
import { ChartDetailModal } from "./MetricDetailModal";
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
  const expandedStorageKey = `expandedSections:project:${projectId}`;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(expandedStorageKey);
        return stored ? new Set(JSON.parse(stored)) : new Set();
      } catch { return new Set(); }
    }
    return new Set();
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [detailMetric, setDetailMetric] = useState<string | null>(null);
  const pinnedStorageKey = `pinnedSections:project:${projectId}`;
  const [pinnedSections, setPinnedSections] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(pinnedStorageKey);
        return stored ? new Set(JSON.parse(stored)) : new Set();
      } catch { return new Set(); }
    }
    return new Set();
  });

  const toggleSectionPin = useCallback((prefix: string) => {
    setPinnedSections(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      localStorage.setItem(pinnedStorageKey, JSON.stringify([...next]));
      return next;
    });
  }, []);

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
        `${API_BASE_URL}/api/sessions/${session.id}/metrics/stream`,
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

  // Auto-expand all when searching
  useEffect(() => {
    if (searchQuery.trim()) {
      setExpandedGroups(new Set(filteredGroupKeys));
    }
  }, [searchQuery, filteredGroupKeys]);

  const persistExpanded = useCallback((groups: Set<string>) => {
    localStorage.setItem(expandedStorageKey, JSON.stringify([...groups]));
  }, [expandedStorageKey]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      persistExpanded(next);
      return next;
    });
  };

  const expandAll = () => {
    const next = new Set(filteredGroupKeys);
    setExpandedGroups(next);
    persistExpanded(next);
  };
  const collapseAll = () => {
    setExpandedGroups(new Set());
    persistExpanded(new Set());
  };

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
      <MultiSeriesDetailModal
        open={detailMetric !== null}
        onClose={() => setDetailMetric(null)}
        metricKey={detailMetric ?? ""}
        sessions={visibleSessions}
      />

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
          [...filteredGroupKeys].sort((a, b) => {
            const aPinned = pinnedSections.has(a);
            const bPinned = pinnedSections.has(b);
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            return 0;
          }).map((prefix) => {
            const metricKeys = filteredGrouped.get(prefix)!;
            const isExpanded = expandedGroups.has(prefix);
            const totalCount = grouped.get(prefix)?.length ?? 0;
            const isFiltering = searchQuery.trim().length > 0;
            const isPinned = pinnedSections.has(prefix);
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
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {isFiltering ? (
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
                      )}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSectionPin(prefix); }}
                      className={`p-0.5 transition-colors ${isPinned ? 'text-accent-500 hover:text-accent-700' : 'text-gray-300 hover:text-gray-500'}`}
                      title={isPinned ? "Unpin section" : "Pin to top"}
                    >
                      <PushPinIcon size={14} fill={isPinned ? "currentColor" : "none"} />
                    </button>
                  </div>
                }
                contentClassName="px-4 pb-4 grid grid-cols-3 gap-3"
              >
                {metricKeys.map((metricKey) => (
                  <MultiSeriesChart
                    key={metricKey}
                    metricKey={metricKey}
                    sessions={visibleSessions}
                    onExpand={setDetailMetric}
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
  onExpand?: (metricKey: string) => void;
}> = ({ metricKey, sessions, onExpand }) => {
  const displayName =
    metricKey.split("/").slice(1).join("/") || metricKey;

  // Check if there's any data
  const hasData = useMemo(() => {
    return sessions.some((sm) =>
      sm.metrics.some((m) => m.data[metricKey] !== undefined)
    );
  }, [sessions, metricKey]);

  if (!hasData) {
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
      <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700 font-mono truncate">
          {displayName}
        </span>
        {onExpand && (
          <button
            onClick={() => onExpand(metricKey)}
            className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
            title="Expand chart"
          >
            <MaximizeIcon size={14} />
          </button>
        )}
      </div>
      <div className="h-44 p-1">
        <MultiSeriesChartContent metricKey={metricKey} sessions={sessions} />
      </div>
    </div>
  );
};

/* ─── Multi-Series Detail Modal ──────────────────────────────────── */

const MultiSeriesDetailModal: React.FC<{
  open: boolean;
  onClose: () => void;
  metricKey: string;
  sessions: SessionMetrics[];
}> = ({ open, onClose, metricKey, sessions }) => {
  // Collect all unique steps across sessions for this metric
  const steps = useMemo(() => {
    const stepSet = new Set<number>();
    sessions.forEach((sm) => {
      sm.metrics.forEach((m) => {
        if (m.data[metricKey] !== undefined) stepSet.add(m.step);
      });
    });
    return Array.from(stepSet).sort((a, b) => a - b);
  }, [sessions, metricKey]);

  return (
    <ChartDetailModal
      open={open}
      onClose={onClose}
      metricKey={metricKey}
      steps={steps}
      renderChart={(xDomainMin, xDomainMax, onBrushChange) => (
        <MultiSeriesChartContent
          metricKey={metricKey}
          sessions={sessions}
          xDomainMin={xDomainMin}
          xDomainMax={xDomainMax}
          showBrush
          onBrushChange={onBrushChange}
        />
      )}
    />
  );
};

/** Shared multi-series recharts content used in both card and modal. */
const MultiSeriesChartContent: React.FC<{
  metricKey: string;
  sessions: SessionMetrics[];
  xDomainMin?: number;
  xDomainMax?: number;
  showBrush?: boolean;
  onBrushChange?: (startIndex: number, endIndex: number) => void;
}> = ({ metricKey, sessions, xDomainMin, xDomainMax, showBrush = false, onBrushChange }) => {
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

    const data = Array.from(stepMap.values()).sort((a, b) => a.step - b.step);
    return { chartData: data, seriesKeys: keys };
  }, [sessions, metricKey]);

  const xDomain: [any, any] = [
    xDomainMin ?? "dataMin",
    xDomainMax ?? "dataMax",
  ];

  return (
    <>
    {showBrush && (
      <style>{`
        .brush-slider .recharts-brush-slide {
          fill: #3f72af !important;
          fill-opacity: 0.15 !important;
          rx: 2 !important;
          height: 4px !important;
          transform: translateY(7px);
        }
        .brush-slider > rect:first-child {
          fill: #e5e7eb !important;
          rx: 2 !important;
          height: 4px !important;
          transform: translateY(7px);
        }
      `}</style>
    )}
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={chartData}
        margin={{ top: 10, right: 15, left: 10, bottom: showBrush ? 5 : 10 }}
        style={{ outline: "none" }}
        accessibilityLayer={false}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
        <XAxis
          dataKey="step"
          type="number"
          domain={xDomain}
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "#737373" }}
          tickLine={{ stroke: "#d4d4d4" }}
          axisLine={{ stroke: "#d4d4d4" }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#737373" }}
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
                  const sm = sessions.find((s) => s.session.id === entry.dataKey);
                  return (
                    <div key={entry.dataKey} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                      <span className="text-gray-600 truncate max-w-[160px]">{sm?.session.experiment ?? "?"}</span>
                      <span className="font-mono ml-auto">{typeof entry.value === "number" ? entry.value.toFixed(4) : "N/A"}</span>
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
        {showBrush && chartData.length > 1 && (
          <Brush
            dataKey="step"
            height={18}
            stroke="none"
            fill="transparent"
            travellerWidth={14}
            tickFormatter={() => ""}
            className="brush-slider"
            traveller={(props: any) => {
              const { x, y, width, height } = props;
              const cx = x + width / 2;
              const cy = y + height / 2;
              return (
                <g cursor="ew-resize">
                  <circle cx={cx} cy={cy} r={7} fill="#3f72af" stroke="white" strokeWidth={2} />
                </g>
              );
            }}
            onChange={(range: any) => {
              if (onBrushChange && range) {
                onBrushChange(range.startIndex, range.endIndex);
              }
            }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
    </>
  );
};
