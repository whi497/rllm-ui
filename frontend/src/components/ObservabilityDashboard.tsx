"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
} from "recharts";
import {
  CpuIcon,
  WrenchIcon,
  ZapIcon,
  ActivityIcon,
  MessageSquareIcon,
  SparklesIcon,
} from "./icons";
import { Spinner } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpanActivityBucket {
  day: string;
  count: number;
}

interface DashboardStats {
  total_spans: number;
  llm_calls: number;
  tool_calls: number;
  invocations: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_llm_latency_ms: number;
  avg_tool_latency_ms: number;
  error_count: number;
}

interface TimeseriesBucket {
  bucket: string;
  total: number;
  llm_calls: number;
  tool_calls: number;
  agent_spans: number;
  tokens: number;
  errors: number;
}

interface ModelUsage {
  model: string;
  call_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number;
}

interface ToolUsage {
  tool_name: string;
  call_count: number;
  avg_latency_ms: number;
  error_count: number;
}

interface SessionCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

interface DashboardData {
  stats: DashboardStats;
  timeseries: TimeseriesBucket[];
  models: ModelUsage[];
  tools: ToolUsage[];
  sessions: SessionCounts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatLatency(ms: number): string {
  if (!ms || ms === 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBucketTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDayRange(data: SpanActivityBucket[]): string {
  if (data.length === 0) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const first = new Date(data[0].day + "T00:00:00");
  const last = new Date(data[data.length - 1].day + "T00:00:00");
  return `${first.toLocaleDateString("en-US", opts)} – ${last.toLocaleDateString("en-US", opts)}`;
}

function formatDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

const KpiCard: React.FC<{
  label: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  color: string;
}> = ({ label, value, subValue, icon, color }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4">
    <div className="flex items-center gap-2 mb-2">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
    </div>
    <div className="text-2xl font-semibold text-gray-900">{value}</div>
    {subValue && <div className="text-xs text-gray-400 mt-0.5">{subValue}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// Span Activity Chart (daily counts, full time range)
// ---------------------------------------------------------------------------

const SpanActivityChart: React.FC<{ data: TimeseriesBucket[] }> = ({ data }) => {
  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">
        No span data yet
      </div>
    );
  }

  const chartData = data.map((b) => ({
    time: formatBucketTime(b.bucket),
    spans: b.total,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="spanActivityGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={{ stroke: "#e5e7eb" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatNumber(v)}
        />
        <Tooltip
          contentStyle={{ fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8 }}
          formatter={(value) => [formatNumber(Number(value ?? 0)), "Spans"]}
        />
        <Area type="monotone" dataKey="spans" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#spanActivityGradient)" />
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ---------------------------------------------------------------------------
// Token Usage Chart
// ---------------------------------------------------------------------------

const TokenChart: React.FC<{ data: TimeseriesBucket[] }> = ({ data }) => {
  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">
        No token data yet
      </div>
    );
  }

  const chartData = data.map((b) => ({
    time: formatBucketTime(b.bucket),
    tokens: b.tokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="tokenUsageGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={{ stroke: "#e5e7eb" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatNumber(v)}
        />
        <Tooltip
          contentStyle={{ fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8 }}
          formatter={(value) => [formatNumber(Number(value ?? 0)), "Tokens"]}
        />
        <Area type="monotone" dataKey="tokens" stroke="#3b82f6" strokeWidth={2.5} fill="url(#tokenUsageGradient)" />
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ---------------------------------------------------------------------------
// Model & Tool Tables
// ---------------------------------------------------------------------------

const ModelTable: React.FC<{ models: ModelUsage[] }> = ({ models }) => {
  if (models.length === 0) return <div className="text-sm text-gray-400 py-4 text-center">No LLM calls yet</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100">
          <th className="text-left py-2 px-2 font-medium text-gray-500">Model</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Calls</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Tokens</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Avg Latency</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model} className="border-b border-gray-50">
            <td className="py-1.5 px-2 font-mono text-xs text-gray-800 truncate max-w-[200px]">{m.model}</td>
            <td className="py-1.5 px-2 text-right text-gray-600">{formatNumber(m.call_count)}</td>
            <td className="py-1.5 px-2 text-right text-gray-600">{formatNumber(m.total_tokens)}</td>
            <td className="py-1.5 px-2 text-right text-gray-600">{formatLatency(m.avg_latency_ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const ToolTable: React.FC<{ tools: ToolUsage[] }> = ({ tools }) => {
  if (tools.length === 0) return <div className="text-sm text-gray-400 py-4 text-center">No tool calls yet</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100">
          <th className="text-left py-2 px-2 font-medium text-gray-500">Tool</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Calls</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Avg Latency</th>
          <th className="text-right py-2 px-2 font-medium text-gray-500">Errors</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={t.tool_name} className="border-b border-gray-50">
            <td className="py-1.5 px-2 font-mono text-xs text-gray-800 truncate max-w-[200px]">{t.tool_name}</td>
            <td className="py-1.5 px-2 text-right text-gray-600">{formatNumber(t.call_count)}</td>
            <td className="py-1.5 px-2 text-right text-gray-600">{formatLatency(t.avg_latency_ms)}</td>
            <td className="py-1.5 px-2 text-right">
              {t.error_count > 0 ? (
                <span className="text-red-600">{t.error_count}</span>
              ) : (
                <span className="text-gray-400">0</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ---------------------------------------------------------------------------
// Distilled Skills Panel
// ---------------------------------------------------------------------------

interface SkillSummary {
  id: string;
  title: string;
  category: string;
  reward_delta: number;
  evidence_count: number;
  is_active: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  "tool-strategy": "bg-blue-400",
  "error-recovery": "bg-red-400",
  "prompt-technique": "bg-purple-400",
  "task-decomposition": "bg-green-400",
  "verification-pattern": "bg-yellow-400",
  "resource-optimization": "bg-orange-400",
  general: "bg-gray-400",
};

const DistilledSkillsPanel: React.FC = () => {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchSkills = useCallback(async () => {
    try {
      const resp = await apiFetch("/api/skills");
      if (!resp.ok) return;
      const data: SkillSummary[] = await resp.json();
      // Sort by reward_delta descending, take top 5
      data.sort((a, b) => b.reward_delta - a.reward_delta);
      setSkills(data.slice(0, 5));
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  usePolling(fetchSkills, { interval: 60000 });

  const maxDelta = Math.max(...skills.map((s) => s.reward_delta), 0.01);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md flex items-center justify-center bg-violet-50">
            <SparklesIcon size={14} className="text-violet-500" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900">Distilled Skills</h3>
        </div>
        <button
          onClick={() => router.push("/skills")}
          className="text-[11px] text-accent-600 hover:text-accent-700 font-medium"
        >
          View all
        </button>
      </div>

      {!loaded ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-xs text-gray-400 mb-2">No skills distilled yet.</p>
          <button
            onClick={() => router.push("/skills")}
            className="text-xs text-accent-600 hover:text-accent-700 font-medium"
          >
            Distill from sessions
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill, i) => {
            const pct = Math.round(skill.reward_delta * 100);
            const barWidth = Math.round((skill.reward_delta / maxDelta) * 100);
            const dotColor = CATEGORY_COLORS[skill.category] || CATEGORY_COLORS.general;
            return (
              <div
                key={skill.id}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => router.push(`/skills/${skill.id}`)}
              >
                <span className="text-xs font-bold text-gray-300 w-4 text-right tabular-nums">
                  {i + 1}
                </span>
                <div className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-800 truncate">
                    {skill.title}
                  </div>
                </div>
                <div className="w-16 flex-shrink-0">
                  <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
                <span className="text-[11px] font-semibold text-gray-600 w-10 text-right tabular-nums">
                  +{pct}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Dashboard Component
// ---------------------------------------------------------------------------

export const ObservabilityDashboard: React.FC<{ dataSource?: string }> = ({ dataSource = "postgres" }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [spanActivity, setSpanActivity] = useState<SpanActivityBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoadDone = useRef(false);

  const fetchDashboard = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const [dashResp, actResp] = await Promise.all([
        apiFetch(`/api/agent-sessions/dashboard?days=7&source=${dataSource}`),
        apiFetch(`/api/agent-sessions/span-activity?source=${dataSource}`),
      ]);
      if (!dashResp.ok) {
        if (dashResp.status === 503) {
          setData(null);
          return;
        }
        throw new Error("Failed to fetch dashboard");
      }
      const d: DashboardData = await dashResp.json();
      setData(d);
      if (actResp.ok) {
        const a: { buckets: SpanActivityBucket[] } = await actResp.json();
        setSpanActivity(a.buckets);
      }
    } catch {
      if (!initialLoadDone.current) setData(null);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [dataSource]);

  // Reset when data source changes
  useEffect(() => {
    initialLoadDone.current = false;
    setLoading(true);
    setData(null);
    setSpanActivity([]);
  }, [dataSource]);

  usePolling(fetchDashboard, { interval: 60000 });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-sm text-gray-400 text-center py-12">
        Dashboard data unavailable. Check {dataSource === "bigquery" ? "BigQuery" : "ClickHouse"} connection.
      </div>
    );
  }

  const { stats, timeseries, models, tools, sessions } = data;
  const errorRate = stats.total_spans > 0 ? ((stats.error_count / stats.total_spans) * 100).toFixed(1) : "0";

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Sessions"
          value={formatNumber(sessions.total)}
          subValue={sessions.running > 0 ? `${sessions.running} running` : undefined}
          icon={<ActivityIcon size={14} className="text-blue-500" />}
          color="bg-blue-50"
        />
        <KpiCard
          label="LLM Calls"
          value={formatNumber(stats.llm_calls)}
          subValue={`avg ${formatLatency(stats.avg_llm_latency_ms)}`}
          icon={<CpuIcon size={14} className="text-amber-500" />}
          color="bg-amber-50"
        />
        <KpiCard
          label="Tool Calls"
          value={formatNumber(stats.tool_calls)}
          subValue={`avg ${formatLatency(stats.avg_tool_latency_ms)}`}
          icon={<WrenchIcon size={14} className="text-green-500" />}
          color="bg-green-50"
        />
        <KpiCard
          label="Total Tokens"
          value={formatNumber(stats.total_tokens)}
          subValue={`${formatNumber(stats.total_input_tokens)} in / ${formatNumber(stats.total_output_tokens)} out`}
          icon={<MessageSquareIcon size={14} className="text-indigo-500" />}
          color="bg-indigo-50"
        />
        <KpiCard
          label="Error Rate"
          value={`${errorRate}%`}
          subValue={`${stats.error_count} errors / ${formatNumber(stats.total_spans)} spans`}
          icon={<ZapIcon size={14} className={stats.error_count > 0 ? "text-red-500" : "text-gray-400"} />}
          color={stats.error_count > 0 ? "bg-red-50" : "bg-gray-50"}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Span Activity</h3>
          <SpanActivityChart data={timeseries} />
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Token Usage</h3>
          <TokenChart data={timeseries} />
        </div>
      </div>

      {/* Model / Tool Tables + AI Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Models</h3>
          <ModelTable models={models} />
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Tools</h3>
          <ToolTable tools={tools} />
        </div>
        <DistilledSkillsPanel />
      </div>
    </div>
  );
};
