"use client";

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { Metric } from "../hooks/useSSE";
import { EmptyState } from "./ui";

interface ChartDataPoint {
  step: number;
  value?: number;
}

interface MetricChartProps {
  metrics: Metric[];
  selectedMetric: string | null;
  selectedStep: number | null;
  onStepClick: (step: number | null) => void;
  color?: string;
}

/**
 * MetricChart - Displays a single selected metric over training steps.
 * Clicking on a data point selects that step to show episodes.
 */
export const RewardChart: React.FC<MetricChartProps> = ({
  metrics,
  selectedMetric,
  selectedStep,
  onStepClick,
  color = "#345f94",
}) => {
  // Transform metrics into chart data points for the selected metric
  const chartData: ChartDataPoint[] = React.useMemo(() => {
    if (!selectedMetric) return [];

    const dataMap = new Map<number, ChartDataPoint>();

    metrics.forEach((metric) => {
      const step = metric.step;
      if (metric.data[selectedMetric] !== undefined) {
        dataMap.set(step, { step, value: metric.data[selectedMetric] });
      }
    });

    // Sort by step and return as array
    return Array.from(dataMap.values()).sort((a, b) => a.step - b.step);
  }, [metrics, selectedMetric]);

  // Custom click handler for the chart area
  const handleChartClick = (data: any) => {
    // Try activePayload first (clicked on data point)
    if (data && data.activePayload && data.activePayload.length > 0) {
      const step = data.activePayload[0].payload.step;
      onStepClick(step);
      return;
    }

    // Fallback to activeLabel (which is the step value on x-axis)
    if (data && data.activeLabel !== undefined) {
      onStepClick(data.activeLabel);
      return;
    }

    // Clicked on empty area (background) - deselect step
    onStepClick(null);
  };

  // Check if we have any data to show
  const hasData = chartData.some((d) => d.value !== undefined);

  if (chartData.length === 0 || !hasData || !selectedMetric) {
    return (
      <EmptyState
        icon={
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        }
        title={!selectedMetric ? "No metric selected" : "No data available"}
        className="h-full"
      />
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={chartData}
        onClick={handleChartClick}
        margin={{ top: 10, right: 15, left: 10, bottom: 10 }}
        style={{ cursor: "crosshair", outline: "none" }}
        accessibilityLayer={false}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
        <XAxis
          dataKey="step"
          type="number"
          domain={["dataMin", "dataMax"]}
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "#737373", fontFamily: "inherit" }}
          tickLine={{ stroke: "#d4d4d4" }}
          axisLine={{ stroke: "#d4d4d4" }}
          interval="preserveStartEnd"
          ticks={(() => {
            if (chartData.length === 0) return undefined;
            const min = chartData[0].step;
            const max = chartData[chartData.length - 1].step;
            const result: number[] = [];
            const start = Math.ceil(min / 5) * 5;
            for (let i = start; i <= max; i += 5) {
              result.push(i);
            }
            if (result.length === 0 || result[0] !== min) result.unshift(min);
            return result;
          })()}
          label={{
            value: "Step",
            position: "insideBottomRight",
            offset: -5,
            fontSize: 11,
            fill: "#737373",
          }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#737373", fontFamily: "inherit" }}
          tickLine={{ stroke: "#d4d4d4" }}
          axisLine={{ stroke: "#d4d4d4" }}
          domain={["auto", "auto"]}
          padding={{ top: 10, bottom: 10 }}
        />
        <Tooltip
          allowEscapeViewBox={{ x: true, y: true }}
          content={({ active, payload, label, coordinate, viewBox }: any) => {
            if (!active || !payload || payload.length === 0) return null;
            const value = payload[0]?.value;
            const formatted = typeof value === "number" ? (value as number).toFixed(4) : "N/A";
            const cx = coordinate?.x ?? 0;
            const cy = coordinate?.y ?? 0;
            const chartWidth = (viewBox as any)?.width ?? 300;
            const chartLeft = (viewBox as any)?.x ?? 0;
            const midX = chartLeft + chartWidth / 2;
            // Place above the point; shift left or right so it doesn't go off-chart
            const isRightHalf = cx > midX;
            return (
              <div
                style={{
                  position: "absolute",
                  left: isRightHalf ? cx - 10 : cx + 10,
                  top: cy - 10,
                  transform: isRightHalf
                    ? "translate(-100%, -100%)"
                    : "translate(0%, -100%)",
                  backgroundColor: "white",
                  border: "1px solid #d4d4d4",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  padding: "6px 8px",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  zIndex: 10,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "2px" }}>Step {label}</div>
                <div style={{ color }}>
                  {selectedMetric}: {formatted}
                </div>
              </div>
            );
          }}
        />

        {/* Reference line for selected step */}
        {selectedStep !== null && (
          <ReferenceLine
            x={selectedStep}
            stroke="#000"
            strokeWidth={2}
            strokeDasharray="4 4"
          />
        )}

        <Line
          type="monotone"
          dataKey="value"
          name={selectedMetric}
          stroke={color}
          strokeWidth={2}
          isAnimationActive={false}
          dot={chartData.length === 1 ? (props: any) => {
            const { cx, cy, payload } = props;
            if (cx === undefined || cy === undefined) return null;
            return (
              <circle
                cx={cx}
                cy={cy}
                r={3}
                fill={color}
                cursor="pointer"
                onClick={() => onStepClick(payload.step)}
                style={{ pointerEvents: "all" }}
              />
            );
          } : false}
          activeDot={{
            r: 5,
            fill: color,
            stroke: "#fff",
            strokeWidth: 2,
            cursor: "pointer",
          }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

/**
 * Extract all unique metric keys from the metrics data
 */
export function getAvailableMetrics(metrics: Metric[]): string[] {
  const metricSet = new Set<string>();

  metrics.forEach((metric) => {
    Object.keys(metric.data).forEach((key) => {
      metricSet.add(key);
    });
  });

  // Sort alphabetically, but put reward/mean first if it exists
  const sorted = Array.from(metricSet).sort((a, b) => {
    if (a === "reward/mean") return -1;
    if (b === "reward/mean") return 1;
    return a.localeCompare(b);
  });

  return sorted;
}
