"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Modal } from "./ui";
import { RewardChart } from "./RewardChart";
import { CloseIcon } from "./icons";
import type { Metric } from "../hooks/useSSE";

interface ChartDetailModalProps {
  open: boolean;
  onClose: () => void;
  metricKey: string;
  /** Sorted array of step numbers for brush mapping. */
  steps: number[];
  /** Render the chart content. Receives the current x-domain range and brush change handler. */
  renderChart: (
    xDomainMin?: number,
    xDomainMax?: number,
    onBrushChange?: (startIndex: number, endIndex: number) => void,
  ) => React.ReactNode;
}

/**
 * Reusable expanded chart modal with step range controls.
 * Works for both single-series and multi-series charts.
 */
export const ChartDetailModal: React.FC<ChartDetailModalProps> = ({
  open,
  onClose,
  metricKey,
  steps,
  renderChart,
}) => {
  const [xMin, setXMin] = useState("");
  const [xMax, setXMax] = useState("");

  const stepRange = useMemo(() => {
    if (steps.length === 0) return { min: 0, max: 0 };
    return { min: steps[0], max: steps[steps.length - 1] };
  }, [steps]);

  useEffect(() => {
    if (open) {
      setXMin(String(stepRange.min));
      setXMax(String(stepRange.max));
    }
  }, [open, metricKey, stepRange.min, stepRange.max]);

  const xDomainMin = xMin !== "" ? parseFloat(xMin) : undefined;
  const xDomainMax = xMax !== "" ? parseFloat(xMax) : undefined;

  const handleReset = () => {
    setXMin(String(stepRange.min));
    setXMax(String(stepRange.max));
  };

  const handleBrushChange = useCallback((startIndex: number, endIndex: number) => {
    if (steps.length > 0) {
      const minStep = steps[Math.min(startIndex, steps.length - 1)];
      const maxStep = steps[Math.min(endIndex, steps.length - 1)];
      setXMin(String(minStep));
      setXMax(String(maxStep));
    }
  }, [steps]);

  const hasCustomRange =
    (xMin !== "" && parseFloat(xMin) !== stepRange.min) ||
    (xMax !== "" && parseFloat(xMax) !== stepRange.max);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800 font-mono truncate">
          {metricKey}
        </h3>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 transition-colors rounded"
        >
          <CloseIcon size={18} />
        </button>
      </div>

      {/* Chart */}
      <div className="h-96">
        {renderChart(xDomainMin, xDomainMax, handleBrushChange)}
      </div>

      {/* Controls */}
      <div className="flex items-end gap-6 pt-4 mt-4 border-t border-gray-100">
        {/* Step range */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500">Step range</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={xMin}
              onChange={(e) => setXMin(e.target.value)}
              placeholder="Auto"
              step="1"
              min={stepRange.min}
              max={stepRange.max}
              className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:border-gray-400 placeholder-gray-400 font-mono tabular-nums"
            />
            <span className="text-gray-400 text-xs">–</span>
            <input
              type="number"
              value={xMax}
              onChange={(e) => setXMax(e.target.value)}
              placeholder="Auto"
              step="1"
              min={stepRange.min}
              max={stepRange.max}
              className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:border-gray-400 placeholder-gray-400 font-mono tabular-nums"
            />
          </div>
        </div>

        {/* Reset */}
        {hasCustomRange && (
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
          >
            Reset
          </button>
        )}
      </div>
    </Modal>
  );
};

/* ─── Single-series convenience wrapper (used by MetricsDashboard) ── */

interface MetricDetailModalProps {
  open: boolean;
  onClose: () => void;
  metrics: Metric[];
  metricKey: string;
  color?: string;
}

export const MetricDetailModal: React.FC<MetricDetailModalProps> = ({
  open,
  onClose,
  metrics,
  metricKey,
  color,
}) => {
  const steps = useMemo(() => {
    const stepSet = new Set<number>();
    metrics.forEach((m) => {
      if (m.data[metricKey] !== undefined) stepSet.add(m.step);
    });
    return Array.from(stepSet).sort((a, b) => a - b);
  }, [metrics, metricKey]);

  return (
    <ChartDetailModal
      open={open}
      onClose={onClose}
      metricKey={metricKey}
      steps={steps}
      renderChart={(xDomainMin, xDomainMax, onBrushChange) => (
        <RewardChart
          metrics={metrics}
          selectedMetric={metricKey}
          selectedStep={null}
          onStepClick={() => {}}
          color={color}
          xDomainMin={xDomainMin}
          xDomainMax={xDomainMax}
          showBrush
          onBrushChange={onBrushChange}
        />
      )}
    />
  );
};
