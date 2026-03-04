"use client";

import React, { useState, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowBackIcon, CheckIcon, CloseIcon, FilterIcon } from "./icons";
import { Spinner, EmptyState } from "./ui";
import { EpisodePanel } from "./EpisodePanel";
import {
  getEvalSessionById,
  getEvalResultForSession,
  getEvalEpisodesForSession,
  type EvalSession,
  type EvalResult,
  type EvalEpisode,
} from "../mocks/evalData";

type FilterMode = "all" | "correct" | "incorrect";

const StatusBadge: React.FC<{ status: EvalSession["status"] }> = ({ status }) => {
  const config = {
    running:   { label: "Running",   bg: "bg-green-100",  text: "text-green-700",  dot: "bg-green-500",  pulse: true },
    completed: { label: "Completed", bg: "bg-layer-2",    text: "text-gray-600",   dot: "bg-gray-400",   pulse: false },
    failed:    { label: "Failed",    bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500",    pulse: false },
    crashed:   { label: "Crashed",   bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", pulse: false },
  }[status] ?? { label: status, bg: "bg-layer-2", text: "text-gray-600", dot: "bg-gray-400", pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className="relative flex w-1.5 h-1.5">
        {config.pulse && (
          <span className={`absolute inset-0 rounded-full ${config.dot} opacity-75 animate-ping`} />
        )}
        <span className={`relative block w-1.5 h-1.5 rounded-full ${config.dot}`} />
      </span>
      {config.label}
    </span>
  );
};

function formatPercent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export const EvalRunDetail: React.FC = () => {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.sessionId as string;

  const session = useMemo(() => getEvalSessionById(sessionId), [sessionId]);
  const result = useMemo(() => getEvalResultForSession(sessionId), [sessionId]);
  const allEpisodes = useMemo(() => {
    // Normalize all episodes to step 0 so EpisodePanel shows them all when selectedStep={0}
    return getEvalEpisodesForSession(sessionId).map((ep) => ({ ...ep, step: 0 }));
  }, [sessionId]);

  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const filteredEpisodes = useMemo(() => {
    if (filterMode === "all") return allEpisodes;
    if (filterMode === "correct") return allEpisodes.filter((ep) => ep.is_correct);
    return allEpisodes.filter((ep) => !ep.is_correct);
  }, [allEpisodes, filterMode]);

  if (!session || !result) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState
          icon={<span className="text-2xl">🔍</span>}
          title="Evaluation not found"
          description="This evaluation run does not exist."
        />
      </div>
    );
  }

  const signals = Object.entries(result.signal_averages);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-3 mb-1">
          <button
            onClick={() => router.push("/evaluation")}
            className="p-1.5 hover:bg-layer-2 text-gray-400 hover:text-gray-600 rounded-md transition-colors"
          >
            <ArrowBackIcon size={18} />
          </button>
          <h1 className="text-lg font-semibold text-black truncate">
            {session.experiment}
          </h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="ml-9 text-xs text-gray-500">
          {result.dataset_name} · {result.model} · {result.agent}
        </div>
      </div>

      {/* Summary Bar */}
      <div className="px-6 py-4 border-b border-gray-200 bg-layer-1 flex-shrink-0">
        <div className="flex items-center gap-6 flex-wrap">
          {/* Score */}
          <div className="text-center">
            <div className="text-3xl font-bold text-black">{formatPercent(result.score)}</div>
            <div className="text-xs text-gray-500 mt-0.5">Score</div>
          </div>

          <div className="w-px h-10 bg-gray-200" />

          {/* Correct/Total */}
          <div className="text-center">
            <div className="text-xl font-semibold text-black font-mono">
              {result.correct}<span className="text-gray-400">/{result.total}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Correct</div>
          </div>

          {/* Errors */}
          <div className="text-center">
            <div className={`text-xl font-semibold font-mono ${result.errors > 0 ? "text-red-500" : "text-gray-400"}`}>
              {result.errors}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Errors</div>
          </div>

          <div className="w-px h-10 bg-gray-200" />

          {/* Signal Averages */}
          {signals.map(([name, value]) => (
            <div key={name} className="text-center">
              <div className="text-lg font-semibold text-black font-mono">
                {formatPercent(value)}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 capitalize">{name}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-6 py-2.5 border-b border-gray-200 bg-white flex-shrink-0 flex items-center gap-2">
        <FilterIcon size={14} className="text-gray-400" />
        <span className="text-xs text-gray-500 mr-1">Filter:</span>
        {(["all", "correct", "incorrect"] as FilterMode[]).map((mode) => {
          const count =
            mode === "all"
              ? allEpisodes.length
              : mode === "correct"
              ? allEpisodes.filter((ep) => ep.is_correct).length
              : allEpisodes.filter((ep) => !ep.is_correct).length;
          return (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filterMode === mode
                  ? mode === "correct"
                    ? "bg-green-100 text-green-700"
                    : mode === "incorrect"
                    ? "bg-red-100 text-red-700"
                    : "bg-accent-50 text-accent-700"
                  : "bg-layer-2 text-gray-600 hover:bg-layer-3"
              }`}
            >
              {mode === "correct" && <CheckIcon size={12} />}
              {mode === "incorrect" && <CloseIcon size={12} />}
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
              <span className="text-[10px] opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Episode Panel */}
      <div className="flex-1 overflow-hidden">
        {filteredEpisodes.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <EmptyState
              icon={<span className="text-xl">📝</span>}
              title={filterMode === "all" ? "No episodes" : `No ${filterMode} episodes`}
              description={filterMode === "all" ? "No episode data available for this run." : `Try changing the filter.`}
            />
          </div>
        ) : (
          <EpisodePanel
            episodes={filteredEpisodes as any}
            selectedStep={0}
            sessionId={sessionId}
            loading={false}
            viewMode="episodes"
          />
        )}
      </div>
    </div>
  );
};

export default EvalRunDetail;
