"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowBackIcon,
  ActivityIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ListIcon,
  GitBranchIcon,
  ArrowDownIcon,
  MessageSquareIcon,
  CpuIcon,
  WrenchIcon,
  ZapIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSession {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, any> | null;
  created_at: string;
  completed_at: string | null;
}

export interface Span {
  id: string;
  agent_session_id: string;
  span_type: string;
  span_id: string;
  invocation_id: string;
  agent_name: string;
  model: string;
  tool_name: string;
  duration_ms: number | null;
  error: string;
  data: Record<string, any>;
  created_at: string;
}

// Tree node for hierarchical span view
interface SpanNode {
  span: Span;
  children: SpanNode[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPAN_TYPE_COLORS: Record<string, { bg: string; text: string; border: string; bar: string }> = {
  session: { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-200", bar: "bg-cyan-400" },
  "invocation.start": { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", bar: "bg-blue-400" },
  "invocation.end": { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", bar: "bg-blue-400" },
  "agent.start": { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200", bar: "bg-purple-400" },
  "agent.end": { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200", bar: "bg-purple-400" },
  "llm.start": { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", bar: "bg-amber-400" },
  "llm.end": { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", bar: "bg-amber-400" },
  "tool.start": { bg: "bg-green-50", text: "text-green-700", border: "border-green-200", bar: "bg-green-400" },
  "tool.end": { bg: "bg-green-50", text: "text-green-700", border: "border-green-200", bar: "bg-green-400" },
  event: { bg: "bg-gray-50", text: "text-gray-600", border: "border-gray-200", bar: "bg-gray-400" },
};

const DEFAULT_COLORS = { bg: "bg-gray-50", text: "text-gray-600", border: "border-gray-200", bar: "bg-gray-300" };

function getSpanColors(spanType: string) {
  return SPAN_TYPE_COLORS[spanType] || DEFAULT_COLORS;
}

// ---------------------------------------------------------------------------
// Span grouping into invocation tree
// ---------------------------------------------------------------------------

export interface InvocationGroup {
  invocationId: string;
  spans: Span[];
  startTime: number;
  endTime: number;
}

export function groupByInvocation(spans: Span[]): InvocationGroup[] {
  const map = new Map<string, Span[]>();
  const sessionSpans: Span[] = [];

  for (const span of spans) {
    if (span.invocation_id) {
      if (!map.has(span.invocation_id)) map.set(span.invocation_id, []);
      map.get(span.invocation_id)!.push(span);
    } else {
      sessionSpans.push(span);
    }
  }

  const groups: InvocationGroup[] = [];

  // Session-level spans as their own group
  if (sessionSpans.length > 0) {
    const times = sessionSpans.map((s) => new Date(s.created_at).getTime());
    groups.push({
      invocationId: "__session__",
      spans: sessionSpans,
      startTime: Math.min(...times),
      endTime: Math.max(...times),
    });
  }

  for (const [invId, invSpans] of map) {
    const times = invSpans.map((s) => new Date(s.created_at).getTime());
    groups.push({
      invocationId: invId,
      spans: invSpans,
      startTime: Math.min(...times),
      endTime: Math.max(...times),
    });
  }

  groups.sort((a, b) => a.startTime - b.startTime);
  return groups;
}

// Build a tree within an invocation: session > agent > llm/tool
function buildSpanTree(spans: Span[]): SpanNode[] {
  // Sort by created_at
  const sorted = [...spans].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Simple nesting: pair .start/.end by span_id, nest by type hierarchy
  // For now, create a flat list grouped by span pairs
  const nodes: SpanNode[] = [];
  const startSpans = new Map<string, SpanNode>();

  for (const span of sorted) {
    const baseType = span.span_type.replace(/\.(start|end)$/, "");
    const isEnd = span.span_type.endsWith(".end");

    if (isEnd && span.span_id && startSpans.has(span.span_id)) {
      // Merge end data into the start node's span
      const startNode = startSpans.get(span.span_id)!;
      // Keep the start span but add duration from end
      if (span.duration_ms != null) {
        startNode.span = { ...startNode.span, duration_ms: span.duration_ms };
      }
      if (span.error) {
        startNode.span = { ...startNode.span, error: span.error };
      }
      continue;
    }

    const node: SpanNode = { span, children: [] };

    // Try to nest: tool/llm under agent, agent under invocation
    if (baseType === "tool" || baseType === "llm") {
      // Find the last agent node to nest under
      const agentParent = findLastNodeOfType(nodes, "agent");
      if (agentParent) {
        agentParent.children.push(node);
      } else {
        nodes.push(node);
      }
    } else if (baseType === "agent") {
      // Find invocation to nest under
      const invParent = findLastNodeOfType(nodes, "invocation");
      if (invParent) {
        invParent.children.push(node);
      } else {
        nodes.push(node);
      }
    } else {
      nodes.push(node);
    }

    if (span.span_id) {
      startSpans.set(span.span_id, node);
    }
  }

  return nodes;
}

function findLastNodeOfType(nodes: SpanNode[], baseType: string): SpanNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].span.span_type.startsWith(baseType)) return nodes[i];
    // Check children
    const found = findLastNodeOfType(nodes[i].children, baseType);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const SpanTypeBadge: React.FC<{ spanType: string }> = ({ spanType }) => {
  const colors = getSpanColors(spanType);
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono font-medium ${colors.bg} ${colors.text} border ${colors.border}`}>
      {spanType}
    </span>
  );
};

const SpanTreeNode: React.FC<{
  node: SpanNode;
  depth: number;
  selectedSpanId: string | null;
  onSelect: (span: Span) => void;
  globalStart: number;
  globalDuration: number;
}> = ({ node, depth, selectedSpanId, onSelect, globalStart, globalDuration }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedSpanId === node.span.id;
  const colors = getSpanColors(node.span.span_type);

  // Timeline bar positioning
  const spanStart = new Date(node.span.created_at).getTime();
  const offsetPct = globalDuration > 0 ? ((spanStart - globalStart) / globalDuration) * 100 : 0;
  const durationPct = node.span.duration_ms && globalDuration > 0
    ? (node.span.duration_ms / globalDuration) * 100
    : 1; // min width

  const label = node.span.tool_name || node.span.agent_name || node.span.model || "";

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 px-2 cursor-pointer rounded transition-colors ${
          isSelected ? "bg-accent-50 border-l-2 border-accent-500" : "hover:bg-gray-50"
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onSelect(node.span)}
      >
        {/* Expand/collapse */}
        <button
          className="w-4 h-4 flex-shrink-0 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded(!expanded);
          }}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDownIcon size={12} className="text-gray-400" />
            ) : (
              <ChevronRightIcon size={12} className="text-gray-400" />
            )
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
          )}
        </button>

        {/* Span type badge */}
        <SpanTypeBadge spanType={node.span.span_type} />

        {/* Label */}
        {label && (
          <span className="text-xs text-gray-600 truncate max-w-[120px]">{label}</span>
        )}

        {/* Error indicator */}
        {node.span.error && (
          <span className="text-xs text-red-600 font-medium">error</span>
        )}

        {/* Timeline bar (inline) */}
        <div className="flex-1 ml-2 h-4 relative bg-gray-100 rounded overflow-hidden min-w-[100px]">
          <div
            className={`absolute top-0.5 bottom-0.5 rounded ${colors.bar} opacity-80`}
            style={{
              left: `${Math.min(offsetPct, 99)}%`,
              width: `${Math.max(durationPct, 0.5)}%`,
            }}
          />
        </div>

        {/* Duration */}
        <span className="text-xs text-gray-400 font-mono flex-shrink-0 w-16 text-right">
          {node.span.duration_ms != null ? `${node.span.duration_ms.toFixed(0)}ms` : ""}
        </span>
      </div>

      {/* Children */}
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <SpanTreeNode
            key={child.span.id}
            node={child}
            depth={depth + 1}
            selectedSpanId={selectedSpanId}
            onSelect={onSelect}
            globalStart={globalStart}
            globalDuration={globalDuration}
          />
        ))}
    </div>
  );
};

export const SpanDetailPanel: React.FC<{ span: Span }> = ({ span }) => {
  const [activeTab, setActiveTab] = useState<"overview" | "data">("overview");

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <SpanTypeBadge spanType={span.span_type} />
          {span.error && (
            <span className="text-xs text-red-600 font-medium bg-red-50 px-1.5 py-0.5 rounded">
              Error
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 font-mono">{span.id}</div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 px-4 flex-shrink-0">
        {(["overview", "data"] as const).map((tab) => (
          <button
            key={tab}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-accent-500 text-accent-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === "overview" ? (
          <div className="space-y-3">
            <DetailRow label="Span Type" value={span.span_type} />
            <DetailRow label="Span ID" value={span.span_id} mono />
            {span.invocation_id && <DetailRow label="Invocation ID" value={span.invocation_id} mono />}
            {span.agent_name && <DetailRow label="Agent" value={span.agent_name} />}
            {span.model && <DetailRow label="Model" value={span.model} mono />}
            {span.tool_name && <DetailRow label="Tool" value={span.tool_name} />}
            {span.duration_ms != null && (
              <DetailRow label="Duration" value={`${span.duration_ms.toFixed(1)}ms`} />
            )}
            {span.error && <DetailRow label="Error" value={span.error} error />}
            <DetailRow label="Created" value={new Date(span.created_at).toISOString()} />

            {/* Token usage from data */}
            {span.data?.response?.usage && (
              <div className="mt-4 pt-3 border-t border-gray-100">
                <div className="text-xs font-medium text-gray-500 mb-2">Token Usage</div>
                <div className="grid grid-cols-3 gap-2">
                  <TokenStat label="Input" value={span.data.response.usage.input_tokens} />
                  <TokenStat label="Output" value={span.data.response.usage.output_tokens} />
                  <TokenStat label="Total" value={span.data.response.usage.total_tokens} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <pre className="text-xs font-mono text-gray-700 bg-gray-50 p-3 rounded-lg overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(span.data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
};

const DetailRow: React.FC<{
  label: string;
  value: string;
  mono?: boolean;
  error?: boolean;
}> = ({ label, value, mono, error }) => (
  <div>
    <div className="text-xs font-medium text-gray-500 mb-0.5">{label}</div>
    <div
      className={`text-sm ${mono ? "font-mono" : ""} ${
        error ? "text-red-600" : "text-gray-900"
      } break-all`}
    >
      {value}
    </div>
  </div>
);

const TokenStat: React.FC<{ label: string; value?: number }> = ({ label, value }) => (
  <div className="bg-white border border-gray-200 rounded-md px-2 py-1.5 text-center">
    <div className="text-xs text-gray-500">{label}</div>
    <div className="text-sm font-semibold text-gray-900">
      {value != null ? value.toLocaleString() : "-"}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

type ViewMode = "tree" | "flow";

// ---------------------------------------------------------------------------
// Summary Flow View
// ---------------------------------------------------------------------------

interface FlowStep {
  id: string;
  type: "user" | "llm" | "tool" | "agent" | "response" | "event";
  label: string;
  sublabel: string;
  duration_ms: number | null;
  error: string;
  span: Span;
}

function extractFlowSteps(spans: Span[]): FlowStep[] {
  const sorted = [...spans].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Merge .start/.end pairs by span_id
  const merged = new Map<string, Span>();
  const standalone: Span[] = [];

  for (const span of sorted) {
    const isEnd = span.span_type.endsWith(".end");
    const isStart = span.span_type.endsWith(".start");

    if (isEnd && span.span_id && merged.has(span.span_id)) {
      const start = merged.get(span.span_id)!;
      if (span.duration_ms != null) start.duration_ms = span.duration_ms;
      if (span.error) start.error = span.error;
      continue;
    }

    if (isStart && span.span_id) {
      merged.set(span.span_id, { ...span });
    } else if (!isEnd) {
      standalone.push(span);
    }
  }

  const allSpans = [...merged.values(), ...standalone].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const steps: FlowStep[] = [];

  for (const span of allSpans) {
    const baseType = span.span_type.replace(/\.(start|end)$/, "");

    if (baseType === "invocation") {
      steps.push({
        id: span.id,
        type: "user",
        label: "User Message",
        sublabel: `Invocation ${span.invocation_id?.slice(0, 8) || ""}`,
        duration_ms: span.duration_ms,
        error: span.error,
        span,
      });
    } else if (baseType === "llm") {
      steps.push({
        id: span.id,
        type: "llm",
        label: "LLM Call",
        sublabel: span.model || span.agent_name || "",
        duration_ms: span.duration_ms,
        error: span.error,
        span,
      });
    } else if (baseType === "tool") {
      steps.push({
        id: span.id,
        type: "tool",
        label: span.tool_name || "Tool",
        sublabel: span.data?.tool_type || "tool call",
        duration_ms: span.duration_ms,
        error: span.error,
        span,
      });
    } else if (baseType === "agent") {
      steps.push({
        id: span.id,
        type: "agent",
        label: span.agent_name || "Agent",
        sublabel: "agent execution",
        duration_ms: span.duration_ms,
        error: span.error,
        span,
      });
    } else if (baseType === "event") {
      steps.push({
        id: span.id,
        type: "event",
        label: "Event",
        sublabel: span.data?.type || "",
        duration_ms: span.duration_ms,
        error: span.error,
        span,
      });
    }
    // Skip session-level spans in the flow
  }

  return steps;
}

const FLOW_STEP_CONFIG: Record<
  FlowStep["type"],
  { icon: React.ReactNode; bg: string; border: string; text: string }
> = {
  user: {
    icon: <MessageSquareIcon size={16} />,
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-700",
  },
  llm: {
    icon: <CpuIcon size={16} />,
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-700",
  },
  tool: {
    icon: <WrenchIcon size={16} />,
    bg: "bg-green-50",
    border: "border-green-200",
    text: "text-green-700",
  },
  agent: {
    icon: <ZapIcon size={16} />,
    bg: "bg-purple-50",
    border: "border-purple-200",
    text: "text-purple-700",
  },
  response: {
    icon: <MessageSquareIcon size={16} />,
    bg: "bg-cyan-50",
    border: "border-cyan-200",
    text: "text-cyan-700",
  },
  event: {
    icon: <ZapIcon size={16} />,
    bg: "bg-gray-50",
    border: "border-gray-200",
    text: "text-gray-600",
  },
};

export const SummaryFlowView: React.FC<{
  spans: Span[];
  selectedSpanId: string | null;
  onSelectSpan: (span: Span) => void;
}> = ({ spans, selectedSpanId, onSelectSpan }) => {
  const steps = useMemo(() => extractFlowSteps(spans), [spans]);

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No spans found
      </div>
    );
  }

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="flex flex-col items-center max-w-md mx-auto">
        {steps.map((step, idx) => {
          const config = FLOW_STEP_CONFIG[step.type];
          const isSelected = selectedSpanId === step.span.id;

          return (
            <React.Fragment key={step.id}>
              {/* Arrow connector */}
              {idx > 0 && (
                <div className="flex flex-col items-center py-1">
                  <div className="w-px h-4 bg-gray-300" />
                  <ArrowDownIcon size={12} className="text-gray-300 -mt-1" />
                </div>
              )}

              {/* Step block */}
              <button
                onClick={() => onSelectSpan(step.span)}
                className={`
                  w-full flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all
                  text-left cursor-pointer
                  ${
                    isSelected
                      ? "border-accent-400 ring-2 ring-accent-100 shadow-sm"
                      : `${config.border} hover:shadow-sm hover:border-gray-300`
                  }
                  ${config.bg}
                `}
              >
                {/* Icon */}
                <div
                  className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${config.text} bg-white border ${config.border}`}
                >
                  {config.icon}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold ${config.text}`}>
                    {step.label}
                  </div>
                  {step.sublabel && (
                    <div className="text-xs text-gray-500 truncate font-mono">
                      {step.sublabel}
                    </div>
                  )}
                </div>

                {/* Right side: duration + error */}
                <div className="flex-shrink-0 flex items-center gap-2">
                  {step.error && (
                    <span className="text-xs text-red-600 font-medium bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                      Error
                    </span>
                  )}
                  {step.duration_ms != null && (
                    <span className="text-xs text-gray-400 font-mono">
                      {step.duration_ms >= 1000
                        ? `${(step.duration_ms / 1000).toFixed(1)}s`
                        : `${step.duration_ms.toFixed(0)}ms`}
                    </span>
                  )}
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

const SPAN_TYPE_FILTERS = [
  { label: "All", value: "" },
  { label: "Session", value: "session" },
  { label: "Invocation", value: "invocation" },
  { label: "Agent", value: "agent" },
  { label: "LLM", value: "llm" },
  { label: "Tool", value: "tool" },
  { label: "Event", value: "event" },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const ObservabilitySessionDetail: React.FC<{ sessionId: string }> = ({
  sessionId,
}) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dataSource = (searchParams.get("source") || "clickhouse") as "clickhouse" | "bigquery" | "postgres";
  const [session, setSession] = useState<AgentSession | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [totalSpans, setTotalSpans] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("flow");
  const initialLoadDone = useRef(false);

  const fetchData = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const sourceParam = `source=${dataSource}`;
      const [sessResp, spansResp] = await Promise.all([
        apiFetch(`/api/agent-sessions/${sessionId}?${sourceParam}`),
        apiFetch(`/api/agent-sessions/${sessionId}/spans?${sourceParam}&limit=2000`),
      ]);

      if (sessResp.ok) {
        setSession(await sessResp.json());
      }
      if (spansResp.ok) {
        const data = await spansResp.json();
        // Handle paginated response
        if (data.items) {
          setSpans(data.items);
          setTotalSpans(data.total);
        } else {
          // Backward compat: plain array
          setSpans(data);
          setTotalSpans(data.length);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [sessionId, dataSource]);

  const isRunning = session?.status === "running";
  usePolling(fetchData, { interval: isRunning ? 3000 : 60000 });

  // Filter spans
  const filteredSpans = useMemo(() => {
    if (!typeFilter) return spans;
    return spans.filter((s) => s.span_type.startsWith(typeFilter));
  }, [spans, typeFilter]);

  // Group into invocations and build trees
  const invocationGroups = useMemo(() => groupByInvocation(filteredSpans), [filteredSpans]);

  // Global time range for timeline bars
  const globalStart = useMemo(() => {
    if (spans.length === 0) return 0;
    return Math.min(...spans.map((s) => new Date(s.created_at).getTime()));
  }, [spans]);

  const globalEnd = useMemo(() => {
    if (spans.length === 0) return 0;
    return Math.max(...spans.map((s) => new Date(s.created_at).getTime()));
  }, [spans]);

  const globalDuration = globalEnd - globalStart;

  // Span type counts for filter badges
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of spans) {
      const base = s.span_type.replace(/\.(start|end)$/, "");
      counts[base] = (counts[base] || 0) + 1;
    }
    return counts;
  }, [spans]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={<ActivityIcon size={32} className="text-gray-400" />}
          title="Session not found"
          description="This agent session does not exist."
          iconSize="lg"
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <button
          onClick={() => router.push(`/observability`)}
          className="p-1 hover:bg-gray-100 rounded-md transition-colors"
        >
          <ArrowBackIcon size={18} className="text-gray-500" />
        </button>
        {/* Data source badge */}
        <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
          {dataSource === "bigquery" ? "BigQuery" : dataSource === "postgres" ? "Imported" : "ClickHouse"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-black truncate">{session.name}</h1>
            <StatusBadge status={session.status} />
          </div>
          <div className="text-xs text-gray-400 font-mono">{session.id}</div>
        </div>
        <div className="flex items-center gap-3">
          {/* View mode toggle */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("flow")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                viewMode === "flow"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="Summary flow"
            >
              <GitBranchIcon size={14} />
              Flow
            </button>
            <button
              onClick={() => setViewMode("tree")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                viewMode === "tree"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="Detailed tree"
            >
              <ListIcon size={14} />
              Tree
            </button>
          </div>
          <div className="text-sm text-gray-500">
            {spans.length} span{spans.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* Span type filter (tree view only) */}
      {viewMode === "tree" && (
      <div className="flex items-center gap-1.5 px-6 py-2 border-b border-gray-100 bg-white flex-shrink-0 overflow-x-auto">
        {SPAN_TYPE_FILTERS.map((f) => {
          const count = f.value ? typeCounts[f.value] || 0 : spans.length;
          const isActive = typeFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? "bg-accent-100 text-accent-700"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f.label}
              <span className={`${isActive ? "text-accent-500" : "text-gray-400"}`}>{count}</span>
            </button>
          );
        })}
      </div>
      )}

      {/* Main content: view + detail panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Primary view panel */}
        <div className="flex-1 overflow-auto border-r border-gray-200">
          {viewMode === "flow" ? (
            <SummaryFlowView
              spans={filteredSpans}
              selectedSpanId={selectedSpan?.id ?? null}
              onSelectSpan={setSelectedSpan}
            />
          ) : invocationGroups.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              No spans found
            </div>
          ) : (
            <div className="py-1">
              {invocationGroups.map((group) => (
                <InvocationGroupView
                  key={group.invocationId}
                  group={group}
                  selectedSpanId={selectedSpan?.id ?? null}
                  onSelectSpan={setSelectedSpan}
                  globalStart={globalStart}
                  globalDuration={globalDuration}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedSpan && (
          <div className="w-[380px] flex-shrink-0 bg-white overflow-hidden border-l border-gray-200">
            <SpanDetailPanel span={selectedSpan} />
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Invocation group view
// ---------------------------------------------------------------------------

export const InvocationGroupView: React.FC<{
  group: InvocationGroup;
  selectedSpanId: string | null;
  onSelectSpan: (span: Span) => void;
  globalStart: number;
  globalDuration: number;
}> = ({ group, selectedSpanId, onSelectSpan, globalStart, globalDuration }) => {
  const [expanded, setExpanded] = useState(true);
  const tree = useMemo(() => buildSpanTree(group.spans), [group.spans]);
  const isSession = group.invocationId === "__session__";

  return (
    <div className="mb-1">
      {/* Group header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDownIcon size={12} className="text-gray-400" />
        ) : (
          <ChevronRightIcon size={12} className="text-gray-400" />
        )}
        <span className="uppercase tracking-wide">
          {isSession ? "Session" : "Invocation"}
        </span>
        {!isSession && (
          <span className="font-mono text-gray-400">{group.invocationId.slice(0, 8)}</span>
        )}
        <span className="text-gray-400 ml-auto">{group.spans.length} spans</span>
      </button>

      {/* Tree */}
      {expanded && (
        <div className="border-l-2 border-gray-100 ml-4">
          {tree.map((node) => (
            <SpanTreeNode
              key={node.span.id}
              node={node}
              depth={0}
              selectedSpanId={selectedSpanId}
              onSelect={onSelectSpan}
              globalStart={globalStart}
              globalDuration={globalDuration}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Status badge (reused from ObservabilityPage but scoped here too)
// ---------------------------------------------------------------------------

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
