import React, { useState, useMemo } from "react";
import type { Metric } from "../hooks/useSSE";
import { RewardChart, getAvailableMetrics } from "./RewardChart";
import { ChevronRightIcon, ChevronDownIcon, BarChartIcon, MoreVertIcon, SearchIcon } from "./icons";

interface MetricsDashboardProps {
  metrics: Metric[];
  isConnected: boolean;
  onChartClick: (step: number, metric: string) => void;
  color?: string;
  expandedGroups: Set<string>;
  onExpandedGroupsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  hasAutoExpanded: boolean;
  onHasAutoExpandedChange: (v: boolean) => void;
}

/** Groups metric keys by first `/` segment, with priority ordering. */
function groupMetricsByPrefix(metricKeys: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  metricKeys.forEach((key) => {
    const prefix = key.split("/")[0];
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
    }
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
    .forEach((k) => {
      sorted.set(k, groups.get(k)!.sort());
    });

  return sorted;
}

/** Highlights matching portions of text. */
const HighlightText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query.trim()) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-200 text-gray-900 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

/** Single chart card inside a group grid. */
const DashboardChart: React.FC<{
  metricKey: string;
  metrics: Metric[];
  searchQuery: string;
  onStepClick: (step: number, metricKey: string) => void;
  color?: string;
}> = ({ metricKey, metrics, searchQuery, onStepClick, color }) => {
  const displayName = metricKey.split("/").slice(1).join("/") || metricKey;

  const handleStepClick = (step: number | null) => {
    if (step !== null) {
      onStepClick(step, metricKey);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden hover:border-gray-300 transition-colors">
      <div className="px-3 py-2 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-700 font-mono truncate">
          <HighlightText text={displayName} query={searchQuery} />
        </span>
      </div>
      <div className="h-44 p-1">
        <RewardChart
          metrics={metrics}
          selectedMetric={metricKey}
          selectedStep={null}
          onStepClick={handleStepClick}
          color={color}
        />
      </div>
    </div>
  );
};

/** Collapsible section for a metric prefix group. */
const MetricGroup: React.FC<{
  prefix: string;
  metricKeys: string[];
  totalCount: number;
  metrics: Metric[];
  searchQuery: string;
  isExpanded: boolean;
  onToggle: () => void;
  onStepClick: (step: number, metricKey: string) => void;
  color?: string;
}> = ({ prefix, metricKeys, totalCount, metrics, searchQuery, isExpanded, onToggle, onStepClick, color }) => {
  const isFiltering = searchQuery.trim().length > 0;
  return (
    <div className="border-b border-gray-200 last:border-b-0 bg-gray-50">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDownIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          )}
          <h3 className="text-sm font-medium text-gray-900 capitalize">
            {prefix.replace(/_/g, " ")}
          </h3>
        </div>
        <span className="text-xs text-gray-400">
          {isFiltering ? (
            <><span className="text-blue-600 font-medium">{metricKeys.length}</span> / {totalCount}</>
          ) : (
            <>{metricKeys.length} metric{metricKeys.length !== 1 ? "s" : ""}</>
          )}
        </span>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 grid grid-cols-3 gap-3">
          {metricKeys.map((key) => (
            <DashboardChart
              key={key}
              metricKey={key}
              metrics={metrics}
              searchQuery={searchQuery}
              onStepClick={onStepClick}
              color={color}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Three-dot menu for expand/collapse actions. */
const ThreeDotMenu: React.FC<{
  actions: { label: string; onClick: () => void }[];
}> = ({ actions }) => {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        title="Options"
      >
        <MoreVertIcon sx={{ fontSize: 18 }} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 w-36">
          {actions.map((action) => (
            <button
              key={action.label}
              onClick={() => {
                action.onClick();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const MetricsDashboard: React.FC<MetricsDashboardProps> = ({
  metrics,
  isConnected,
  onChartClick,
  color,
  expandedGroups,
  onExpandedGroupsChange: setExpandedGroups,
  hasAutoExpanded,
  onHasAutoExpandedChange: setHasAutoExpanded,
}) => {
  const [searchQuery, setSearchQuery] = useState("");

  const availableMetrics = useMemo(() => getAvailableMetrics(metrics), [metrics]);
  const grouped = useMemo(() => groupMetricsByPrefix(availableMetrics), [availableMetrics]);

  // Auto-expand first group when metrics first arrive
  const groupKeys = useMemo(() => Array.from(grouped.keys()), [grouped]);

  React.useEffect(() => {
    if (groupKeys.length > 0 && !hasAutoExpanded) {
      setExpandedGroups(new Set([groupKeys[0]]));
      setHasAutoExpanded(true);
    }
  }, [groupKeys, hasAutoExpanded]);

  // Filter groups based on search query
  const filteredGrouped = useMemo(() => {
    if (!searchQuery.trim()) return grouped;
    const query = searchQuery.toLowerCase();
    const filtered = new Map<string, string[]>();
    grouped.forEach((keys, prefix) => {
      const matching = keys.filter((k) => k.toLowerCase().includes(query));
      if (matching.length > 0) {
        filtered.set(prefix, matching);
      }
    });
    return filtered;
  }, [grouped, searchQuery]);

  const filteredGroupKeys = useMemo(() => Array.from(filteredGrouped.keys()), [filteredGrouped]);

  // Auto-expand all groups when searching
  React.useEffect(() => {
    if (searchQuery.trim()) {
      setExpandedGroups(new Set(filteredGroupKeys));
    }
  }, [searchQuery, filteredGroupKeys]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  };

  const expandAll = () => setExpandedGroups(new Set(filteredGroupKeys));
  const collapseAll = () => setExpandedGroups(new Set());

  if (availableMetrics.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
          <BarChartIcon sx={{ fontSize: 24 }} className="text-gray-400" />
        </div>
        <p className="text-sm font-medium text-gray-900">
          {isConnected ? "Waiting for metrics" : "Connecting"}
        </p>
      </div>
    );
  }

  const filteredCount = Array.from(filteredGrouped.values()).reduce((sum, keys) => sum + keys.length, 0);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sticky header with search */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3 bg-white flex-shrink-0">
        <div className="flex-1 relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${availableMetrics.length} metrics...`}
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:border-gray-400 placeholder-gray-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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

      {/* Scrollable group list */}
      <div className="flex-1 overflow-y-auto">
        {filteredGroupKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <SearchIcon sx={{ fontSize: 24 }} className="text-gray-400" />
            </div>
            <p className="text-sm font-medium text-gray-900">No matching metrics</p>
          </div>
        ) : (
          filteredGroupKeys.map((prefix) => (
            <MetricGroup
              key={prefix}
              prefix={prefix}
              metricKeys={filteredGrouped.get(prefix)!}
              totalCount={grouped.get(prefix)?.length ?? 0}
              metrics={metrics}
              searchQuery={searchQuery}
              isExpanded={expandedGroups.has(prefix)}
              onToggle={() => toggleGroup(prefix)}
              onStepClick={onChartClick}
              color={color}
            />
          ))
        )}
      </div>
    </div>
  );
};
