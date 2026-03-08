"use client";

import React, { useState, useMemo, useCallback } from "react";
import type { Metric } from "../hooks/useSSE";
import { RewardChart, getAvailableMetrics } from "./RewardChart";
import { BarChartIcon, SearchIcon, MaximizeIcon, PushPinIcon } from "./icons";
import { EmptyState, ThreeDotMenu, CollapsibleSection } from "./ui";
import { MetricDetailModal } from "./MetricDetailModal";

interface MetricsDashboardProps {
  metrics: Metric[];
  isConnected: boolean;
  onChartClick: (step: number, metric: string) => void;
  color?: string;
  expandedGroups: Set<string>;
  onExpandedGroupsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedStorageKey: string;
  pinnedStorageKey: string;
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
  onExpand: (metricKey: string) => void;
  color?: string;
}> = ({ metricKey, metrics, searchQuery, onStepClick, onExpand, color }) => {
  const displayName = metricKey.split("/").slice(1).join("/") || metricKey;

  const handleStepClick = (step: number | null) => {
    if (step !== null) {
      onStepClick(step, metricKey);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden hover:border-gray-300 transition-colors">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700 font-mono truncate">
          <HighlightText text={displayName} query={searchQuery} />
        </span>
        <button
          onClick={() => onExpand(metricKey)}
          className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
          title="Expand chart"
        >
          <MaximizeIcon size={14} />
        </button>
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
  onExpand: (metricKey: string) => void;
  isPinned: boolean;
  onTogglePin: (prefix: string) => void;
  color?: string;
}> = ({ prefix, metricKeys, totalCount, metrics, searchQuery, isExpanded, onToggle, onStepClick, onExpand, isPinned, onTogglePin, color }) => {
  const isFiltering = searchQuery.trim().length > 0;
  return (
    <CollapsibleSection
      isExpanded={isExpanded}
      onToggle={onToggle}
      title={
        <h3 className="text-sm font-medium text-gray-900 capitalize">
          {prefix.replace(/_/g, " ")}
        </h3>
      }
      rightLabel={
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {isFiltering ? (
              <><span className="text-accent-600 font-medium">{metricKeys.length}</span> / {totalCount}</>
            ) : (
              <>{metricKeys.length} metric{metricKeys.length !== 1 ? "s" : ""}</>
            )}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin(prefix); }}
            className={`p-0.5 transition-colors ${isPinned ? 'text-accent-500 hover:text-accent-700' : 'text-gray-300 hover:text-gray-500'}`}
            title={isPinned ? "Unpin section" : "Pin to top"}
          >
            <PushPinIcon size={14} fill={isPinned ? "currentColor" : "none"} />
          </button>
        </div>
      }
      contentClassName="px-4 pb-4 grid grid-cols-3 gap-3"
    >
      {metricKeys.map((key) => (
        <DashboardChart
          key={key}
          metricKey={key}
          metrics={metrics}
          searchQuery={searchQuery}
          onStepClick={onStepClick}
          onExpand={onExpand}
          color={color}
        />
      ))}
    </CollapsibleSection>
  );
};

export const MetricsDashboard: React.FC<MetricsDashboardProps> = ({
  metrics,
  isConnected,
  onChartClick,
  color,
  expandedGroups,
  onExpandedGroupsChange: setExpandedGroups,
  expandedStorageKey,
  pinnedStorageKey,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [detailMetric, setDetailMetric] = useState<string | null>(null);
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
  }, [pinnedStorageKey]);

  const availableMetrics = useMemo(() => getAvailableMetrics(metrics), [metrics]);
  const grouped = useMemo(() => groupMetricsByPrefix(availableMetrics), [availableMetrics]);

  const groupKeys = useMemo(() => Array.from(grouped.keys()), [grouped]);

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

  const persistExpanded = useCallback((groups: Set<string>) => {
    localStorage.setItem(expandedStorageKey, JSON.stringify([...groups]));
  }, [expandedStorageKey]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
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

  if (availableMetrics.length === 0) {
    return (
      <EmptyState
        icon={<BarChartIcon size={24} className="text-gray-400" />}
        title={isConnected ? "Waiting for metrics" : "Connecting"}
        className="flex-1 h-full"
      />
    );
  }

  const filteredCount = Array.from(filteredGrouped.values()).reduce((sum, keys) => sum + keys.length, 0);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <MetricDetailModal
        open={detailMetric !== null}
        onClose={() => setDetailMetric(null)}
        metrics={metrics}
        metricKey={detailMetric ?? ""}
        color={color}
      />

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
          <EmptyState
            icon={<SearchIcon size={24} className="text-gray-400" />}
            title="No matching metrics"
            className="h-32"
          />
        ) : (
          <>
            {/* Pinned sections first, then unpinned */}
            {[...filteredGroupKeys].sort((a, b) => {
              const aPinned = pinnedSections.has(a);
              const bPinned = pinnedSections.has(b);
              if (aPinned && !bPinned) return -1;
              if (!aPinned && bPinned) return 1;
              return 0;
            }).map((prefix) => (
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
                onExpand={setDetailMetric}
                isPinned={pinnedSections.has(prefix)}
                onTogglePin={toggleSectionPin}
                color={color}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
};
