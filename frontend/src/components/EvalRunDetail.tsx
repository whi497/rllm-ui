"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowBackIcon } from "./icons";
import SearchBar from "./SearchBar";
import { ActionMenu } from "./ActionMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { EpisodePanel } from "./EpisodePanel";
import { ConfigRenderer } from "./ConfigRenderer";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";

type SessionStatus = "running" | "completed" | "failed" | "crashed";
type TabId = "evaluation" | "metadata";

interface Session {
  id: string;
  project: string;
  experiment: string;
  status: SessionStatus;
  session_type: string;
  config: Record<string, any> | null;
  created_at: string;
  completed_at: string | null;
}

interface EvalItem {
  idx: number;
  reward: number;
  is_correct: boolean;
  error: string | null;
  signals: Record<string, number>;
}

interface EvalResult {
  id: string;
  session_id: string;
  dataset_name: string;
  model: string;
  agent: string;
  score: number;
  total: number;
  correct: number;
  errors: number;
  signal_averages: Record<string, number>;
  items: EvalItem[];
  created_at: string;
}

interface Episode {
  id: string;
  session_id: string;
  step: number;
  task: Record<string, any>;
  is_correct: boolean;
  termination_reason: string | null;
  trajectories: any[];
  metrics?: Record<string, any>;
  info?: Record<string, any>;
  created_at: string;
}

const StatusBadge: React.FC<{ status: SessionStatus }> = ({ status }) => {
  const config = {
    running: { label: "Running", bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", pulse: true },
    completed: { label: "Completed", bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false },
    failed: { label: "Failed", bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500", pulse: false },
    crashed: { label: "Crashed", bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", pulse: false },
  }[status] ?? { label: status, bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400", pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className="relative flex w-1.5 h-1.5">
        {config.pulse && <span className={`absolute inset-0 rounded-full ${config.dot} animate-ping opacity-75`} />}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${config.dot}`} />
      </span>
      {config.label}
    </span>
  );
};

export const EvalRunDetail: React.FC = () => {
  const params = useParams();
  const router = useRouter();
  const sessionId = params?.sessionId as string;

  const [session, setSession] = useState<Session | null>(null);
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("evaluation");
  const [metaSearchQuery, setMetaSearchQuery] = useState("");
  const [metaMatchIndex, setMetaMatchIndex] = useState(0);
  const metaContainerRef = useRef<HTMLDivElement>(null);

  // Rename/delete state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const renamingRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [sessResp, resultsResp, episodesResp] = await Promise.all([
        apiFetch(`/api/sessions/${sessionId}`),
        apiFetch(`/api/eval-results?session_id=${sessionId}`),
        apiFetch(`/api/episodes?session_id=${sessionId}`),
      ]);

      if (sessResp.ok) setSession(await sessResp.json());
      if (resultsResp.ok) {
        const data = await resultsResp.json();
        if (data.length > 0) setEvalResult(data[0]);
      }
      if (episodesResp.ok) setEpisodes(await episodesResp.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const normalizedEpisodes = useMemo(() => {
    return episodes.map((ep) => ({ ...ep, step: 0 }));
  }, [episodes]);

  const scrollToMetaMatch = useCallback((direction: "next" | "prev" = "next") => {
    if (!metaContainerRef.current || !metaSearchQuery.trim()) return;
    const marks = metaContainerRef.current.querySelectorAll("mark");
    if (marks.length === 0) return;
    // Clear previous highlight
    marks.forEach((m) => {
      m.classList.remove("bg-orange-400", "text-white");
      m.classList.add("bg-yellow-200");
    });
    let idx = direction === "next" ? metaMatchIndex + 1 : metaMatchIndex - 1;
    if (idx >= marks.length) idx = 0;
    if (idx < 0) idx = marks.length - 1;
    setMetaMatchIndex(idx);
    const target = marks[idx];
    target.classList.remove("bg-yellow-200");
    target.classList.add("bg-orange-400", "text-white");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [metaSearchQuery, metaMatchIndex]);

  const handleMetaKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      scrollToMetaMatch(e.shiftKey ? "prev" : "next");
    }
  }, [scrollToMetaMatch]);

  const handleMetaQueryChange = useCallback((q: string) => {
    setMetaSearchQuery(q);
    setMetaMatchIndex(-1);
  }, []);

  const handleRenameSession = async () => {
    if (renamingRef.current) return;
    renamingRef.current = true;
    const trimmed = renameValue.trim();
    if (!trimmed || !sessionId) { setIsRenaming(false); renamingRef.current = false; return; }
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_experiment_name: trimmed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSession(updated);
      }
    } catch { /* ignore */ }
    setIsRenaming(false);
    renamingRef.current = false;
  };

  const handleDeleteSession = async () => {
    if (!sessionId) return;
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push("/evaluation");
      }
    } catch { /* ignore */ }
  };

  // Build metadata object for ConfigRenderer
  const metadata = useMemo(() => {
    const data: Record<string, any> = {};

    if (evalResult) {
      data.results = {
        dataset: evalResult.dataset_name,
        model: evalResult.model,
        agent: evalResult.agent,
        score: `${(evalResult.score * 100).toFixed(1)}%`,
        correct: evalResult.correct,
        total: evalResult.total,
        errors: evalResult.errors,
      };
      if (Object.keys(evalResult.signal_averages).length > 0) {
        data.signals = evalResult.signal_averages;
      }
    }

    if (session?.config && Object.keys(session.config).length > 0) {
      data.config = session.config;
    }

    if (session) {
      data.session = {
        id: session.id,
        project: session.project,
        experiment: session.experiment,
        status: session.status,
        created_at: session.created_at,
        completed_at: session.completed_at,
      };
    }

    return data;
  }, [session, evalResult]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Session not found
      </div>
    );
  }

  const r = evalResult;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push("/evaluation")}
              className="p-1 hover:bg-layer-2 text-gray-400 hover:text-gray-700 rounded-md transition-colors"
              title="Back to evaluations"
            >
              <ArrowBackIcon size={20} />
            </button>
            {isRenaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameSession();
                  if (e.key === "Escape") setIsRenaming(false);
                }}
                onBlur={handleRenameSession}
                className="text-lg font-semibold text-gray-900 border border-gray-300 rounded px-2 py-0.5 outline-none ring-0 focus:border-gray-300 focus:ring-0 focus:outline-none"
              />
            ) : (
              <h1 className="text-lg font-semibold text-gray-900">{session.experiment}</h1>
            )}
            <ActionMenu
              onRename={() => {
                setRenameValue(session.experiment);
                setIsRenaming(true);
              }}
              onDelete={() => setShowDeleteConfirm(true)}
            />
            <div className="ml-auto">
              <StatusBadge status={session.status} />
            </div>
          </div>

          {/* Summary stats */}
          {r && (
            <div className="flex items-center gap-5 mt-3 text-[13px]">
              <span><span className="text-gray-400">Score</span> <span className={`font-medium ${r.score >= 0.5 ? "text-green-600" : r.score >= 0.2 ? "text-amber-600" : "text-red-600"}`}>{(r.score * 100).toFixed(1)}%</span> <span className="text-gray-400">({r.correct}/{r.total})</span></span>
              <span><span className="text-gray-400">Dataset</span> <span className="text-gray-700">{r.dataset_name}</span></span>
              <span><span className="text-gray-400">Model</span> <span className="text-gray-700 font-mono">{r.model}</span></span>
              <span><span className="text-gray-400">Agent</span> <span className="text-gray-700">{r.agent}</span></span>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="px-4 flex items-center">
          <nav className="flex gap-1">
            {([
              { id: "evaluation", label: "Evaluation" },
              { id: "metadata", label: "Metadata" },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  px-3 py-2.5 text-sm font-medium
                  transition-colors duration-150 border-b-2 -mb-px
                  ${
                    activeTab === tab.id
                      ? "border-accent-500 text-accent-600"
                      : "border-transparent text-gray-500 hover:text-gray-900"
                  }
                `}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "evaluation" ? (
          <EpisodePanel
            episodes={normalizedEpisodes}
            selectedStep={0}
            sessionId={sessionId}
            loading={false}
            hideStepLabel
          />
        ) : (
          <div className="h-full flex flex-col bg-white">
            {Object.keys(metadata).length > 0 ? (
              <>
                <div className="px-4 h-14 border-b border-gray-200 flex-shrink-0 flex items-center">
                  <SearchBar
                    query={metaSearchQuery}
                    onQueryChange={handleMetaQueryChange}
                    onKeyDown={handleMetaKeyDown}
                    onClear={() => { setMetaSearchQuery(""); setMetaMatchIndex(-1); }}
                    showClear={!!metaSearchQuery}
                    placeholder="Search metadata..."
                  />
                </div>
                <div className="flex-1 overflow-auto" ref={metaContainerRef}>
                  <ConfigRenderer data={metadata} searchQuery={metaSearchQuery.trim()} />
                </div>
              </>
            ) : (
              <EmptyState
                icon={
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                }
                title="No metadata available"
                className="h-full"
              />
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete experiment?"
        message={`This will permanently delete "${session.experiment}" and all its episodes and eval results.`}
        onConfirm={handleDeleteSession}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
};
