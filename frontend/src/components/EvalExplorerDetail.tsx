"use client";

import React, { useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowBackIcon,
  GitBranchIcon,
  ListIcon,
  ActivityIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";
import {
  Span,
  InvocationGroup,
  SummaryFlowView,
  SpanDetailPanel,
  InvocationGroupView,
  groupByInvocation,
} from "./ObservabilitySessionDetail";

interface EvalRowData {
  id: number;
  upload_id: string;
  session_id: string;
  ground_truth: string;
  rating: string;
  trajectory_alignment: string;
  task_success: string;
  tags: string;
  reference_trajectory: string;
  reference_state: string;
  reference_answer: string;
  created_at: string;
  session: {
    name: string;
    status: string;
    agent_name: string | null;
    span_count: number;
    llm_calls: number;
    tool_calls: number;
    created_at: string | null;
  } | null;
}

type ViewMode = "flow" | "tree";

export const EvalExplorerDetail: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const router = useRouter();
  const [spans, setSpans] = useState<Span[]>([]);
  const [evalRows, setEvalRows] = useState<EvalRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("flow");
  const initialLoadDone = useRef(false);

  const fetchData = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const [spansResp, explorerResp] = await Promise.all([
        apiFetch(`/api/agent-sessions/${sessionId}/spans?source=postgres&limit=2000`),
        apiFetch(`/api/eval-uploads/explorer`),
      ]);

      if (spansResp.ok) {
        const data = await spansResp.json();
        setSpans(data.items || data);
      }
      if (explorerResp.ok) {
        const allRows: EvalRowData[] = await explorerResp.json();
        setEvalRows(allRows.filter((r) => r.session_id === sessionId));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [sessionId]);

  usePolling(fetchData, { interval: 60000 });

  const invocationGroups = useMemo(() => groupByInvocation(spans), [spans]);

  const globalStart = useMemo(() => {
    if (spans.length === 0) return 0;
    return Math.min(...spans.map((s) => new Date(s.created_at).getTime()));
  }, [spans]);

  const globalEnd = useMemo(() => {
    if (spans.length === 0) return 0;
    return Math.max(...spans.map((s) => new Date(s.created_at).getTime()));
  }, [spans]);

  const globalDuration = globalEnd - globalStart;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <button
          onClick={() => router.back()}
          className="p-1 hover:bg-gray-100 rounded-md transition-colors"
          title="Back to Eval Explorer"
        >
          <ArrowBackIcon size={18} className="text-gray-500" />
        </button>
        <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
          Imported
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-black truncate">
            {evalRows[0]?.session?.name || sessionId}
          </div>
          <div className="text-xs text-gray-400 font-mono">{sessionId}</div>
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

      {/* Main content: trace + ground truth side by side */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Agent trace visualization */}
        <div className="flex-1 flex overflow-hidden min-w-0">
          {/* Trace view */}
          <div className="flex-1 overflow-auto">
            {spans.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <EmptyState
                  icon={<ActivityIcon size={32} className="text-gray-400" />}
                  title="No spans"
                  description="No agent spans found for this session."
                  iconSize="lg"
                />
              </div>
            ) : viewMode === "flow" ? (
              <SummaryFlowView
                spans={spans}
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

          {/* Span detail panel (shown when a span is selected) */}
          {selectedSpan && (
            <div className="w-[340px] flex-shrink-0 overflow-hidden border-l border-gray-200">
              <SpanDetailPanel span={selectedSpan} />
            </div>
          )}
        </div>

        {/* Right: Ground truth panel */}
        <div className="w-[380px] flex-shrink-0 border-l border-gray-200 bg-white overflow-auto">
          <div className="p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Ground Truth</h2>

            {evalRows.length === 0 ? (
              <p className="text-sm text-gray-400">No eval results for this session.</p>
            ) : (
              <div className="space-y-4">
                {evalRows.map((row) => (
                  <div key={row.id} className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* Ground truth content */}
                    <div className="p-4">
                      <div className="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed">
                        {row.ground_truth}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {row.rating && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200">
                            <span className="text-[11px] text-amber-600 font-medium">Rating:</span>
                            <span className="text-xs font-semibold text-amber-700">{row.rating}</span>
                          </span>
                        )}
                        {row.trajectory_alignment && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200">
                            <span className="text-[11px] text-blue-600 font-medium">Alignment:</span>
                            <span className="text-xs font-semibold text-blue-700">{row.trajectory_alignment}</span>
                          </span>
                        )}
                        {row.task_success && (
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${row.task_success === "true" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                            <span className={`text-[11px] font-medium ${row.task_success === "true" ? "text-green-600" : "text-red-600"}`}>Task:</span>
                            <span className={`text-xs font-semibold ${row.task_success === "true" ? "text-green-700" : "text-red-700"}`}>{row.task_success}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Reference fields */}
                    {(row.reference_trajectory || row.reference_state || row.reference_answer) && (
                      <div className="px-4 pb-3 space-y-2.5">
                        {row.reference_trajectory && (
                          <div>
                            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Reference Trajectory</div>
                            <div className="text-sm text-gray-700 whitespace-pre-wrap break-words bg-gray-50 rounded p-2.5 border border-gray-100">
                              {row.reference_trajectory}
                            </div>
                          </div>
                        )}
                        {row.reference_state && (
                          <div>
                            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Reference State</div>
                            <div className="text-sm text-gray-700 whitespace-pre-wrap break-words bg-gray-50 rounded p-2.5 border border-gray-100">
                              {row.reference_state}
                            </div>
                          </div>
                        )}
                        {row.reference_answer && (
                          <div>
                            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Reference Answer</div>
                            <div className="text-sm text-gray-700 whitespace-pre-wrap break-words bg-gray-50 rounded p-2.5 border border-gray-100">
                              {row.reference_answer}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tags + metadata footer */}
                    <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100">
                      {row.tags && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {row.tags.split(";").map((tag, i) => (
                            <span
                              key={i}
                              className="inline-block px-1.5 py-0.5 text-[11px] bg-white border border-gray-200 text-gray-600 rounded"
                            >
                              {tag.trim()}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-400">
                        Upload: {row.upload_id}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Session info summary */}
            {evalRows[0]?.session && (
              <div className="mt-6 pt-4 border-t border-gray-100">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Session Info</h3>
                <dl className="space-y-2 text-sm">
                  {evalRows[0].session.agent_name && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Agent</dt>
                      <dd className="text-gray-900 font-medium">{evalRows[0].session.agent_name}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Total spans</dt>
                    <dd className="text-gray-900 tabular-nums">{evalRows[0].session.span_count}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">LLM calls</dt>
                    <dd className="text-gray-900 tabular-nums">{evalRows[0].session.llm_calls}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Tool calls</dt>
                    <dd className="text-gray-900 tabular-nums">{evalRows[0].session.tool_calls}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
