import React, { useMemo } from "react";

interface MetricSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableMetrics: string[];
  selectedMetric: string | null;
  onSelectionChange: (metric: string | null) => void;
}

/**
 * Groups metrics by their first path segment
 * e.g., "reward/mean" -> "reward", "advantage/judge/fraction_zero" -> "advantage"
 */
function groupMetricsByType(metrics: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  metrics.forEach((metric) => {
    const parts = metric.split("/");
    const type = parts[0];

    if (!groups.has(type)) {
      groups.set(type, []);
    }
    groups.get(type)!.push(metric);
  });

  // Sort groups alphabetically, but put common ones first
  const priorityOrder = ["reward", "loss", "accuracy", "progress"];
  const sortedGroups = new Map<string, string[]>();

  // Add priority groups first
  priorityOrder.forEach((key) => {
    if (groups.has(key)) {
      sortedGroups.set(key, groups.get(key)!.sort());
      groups.delete(key);
    }
  });

  // Add remaining groups alphabetically
  Array.from(groups.keys())
    .sort()
    .forEach((key) => {
      sortedGroups.set(key, groups.get(key)!.sort());
    });

  return sortedGroups;
}

export const MetricSelectorModal: React.FC<MetricSelectorModalProps> = ({
  isOpen,
  onClose,
  availableMetrics,
  selectedMetric,
  onSelectionChange,
}) => {
  // Group metrics by type
  const groupedMetrics = useMemo(
    () => groupMetricsByType(availableMetrics),
    [availableMetrics]
  );

  const handleSelectMetric = (metric: string) => {
    onSelectionChange(metric);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="absolute top-full left-0 z-50 bg-white rounded-lg shadow-lg border border-gray-200 w-72 max-h-80 overflow-y-auto">
      {availableMetrics.length === 0 ? (
        <div className="p-4 text-sm text-gray-500 text-center">
          No metrics available
        </div>
      ) : (
        <div className="p-2">
          {Array.from(groupedMetrics.entries()).map(([type, metrics]) => {
            return (
              <div key={type} className="mb-3 last:mb-0">
                {/* Group Header */}
                <div className="flex items-center gap-2 px-2 py-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                    {type}
                  </span>
                  <span className="text-xs text-gray-400">
                    ({metrics.length})
                  </span>
                </div>

                {/* Metrics List */}
                <div className="space-y-0.5">
                  {metrics.map((metric) => {
                    const isSelected = selectedMetric === metric;
                    const displayName = metric.split("/").slice(1).join("/");

                    return (
                      <button
                        key={metric}
                        onClick={() => handleSelectMetric(metric)}
                        className={`w-full flex items-center gap-2 py-1.5 px-2 rounded text-left transition-colors ${
                          isSelected
                            ? "bg-accent-50 text-accent-700"
                            : "hover:bg-layer-1 text-gray-700"
                        }`}
                      >
                        <div
                          className={`w-3 h-3 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            isSelected
                              ? "border-accent-600"
                              : "border-gray-300"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-1.5 h-1.5 rounded-full bg-accent-600" />
                          )}
                        </div>
                        <span className="text-sm font-mono truncate">
                          {displayName || type}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
