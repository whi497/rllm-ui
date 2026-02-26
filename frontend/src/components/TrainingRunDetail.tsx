import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMetricsSSE, useLogsSSE } from "../hooks/useSSE";
import { RewardChart, getAvailableMetrics } from "./RewardChart";
import { EpisodePanel } from "./EpisodePanel";
import { WorkflowDiagram } from "./WorkflowDiagram";
import { ChatPanel } from "./ChatPanel";
import { ChatSessionMenu } from "./ChatSessionMenu";
import { LogsPanel } from "./LogsPanel";
import { MetricSelectorModal } from "./MetricSelectorModal";
import { MetricsDashboard } from "./MetricsDashboard";
import {
  WarningIcon,
  ArrowBackIcon,
  SearchIcon,
} from "./icons";
import { ActionMenu } from "./ActionMenu";
import { ConfigRenderer } from "./ConfigRenderer";
import { ConfirmDialog } from "./ConfirmDialog";
import { getExperimentColor } from "../utils/experimentColors";
import { useExperimentVisibility } from "../contexts/ExperimentVisibilityContext";
import { apiFetch } from "../config/api";
import { Spinner, EmptyState } from "./ui";
import { usePolling } from "../hooks/usePolling";

type SessionStatus = "running" | "completed" | "failed" | "crashed";

interface Session {
  id: string;
  project_id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  color: string | null;
  status: SessionStatus;
  source_metadata?: {
    workflow_source?: string;
    workflow_class?: string;
    reward_fn_source?: string;
    reward_fn_name?: string;
    agent_source?: string;
    agent_class?: string;
  } | null;
  created_at: string;
  completed_at: string | null;
}

const StatusBadge: React.FC<{ status: SessionStatus }> = ({ status }) => {
  const config = {
    running: { label: "Running", bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", pulse: true },
    completed: { label: "Completed", bg: "bg-layer-2", text: "text-gray-600", dot: "bg-gray-400", pulse: false },
    failed: { label: "Failed", bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500", pulse: false },
    crashed: { label: "Crashed", bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", pulse: false },
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

interface Episode {
  id: string;
  session_id: string;
  step: number;
  task: Record<string, any>;
  is_correct: boolean;
  reward: number | null;
  termination_reason: string | null;
  trajectories: Trajectory[];
  metrics?: Record<string, any>;
  info?: Record<string, any>;
  created_at: string;
}

interface Trajectory {
  uid: string;
  reward: number;
  steps: TrajectoryStep[];
}

interface TrajectoryStep {
  observation: any;
  action: any;
  reward: number;
  done: boolean;
  chat_completions?: any;
  model_response?: any;
}

export const TrainingRunDetail: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { colorOverrides, updateColor } = useExperimentVisibility();

  const [session, setSession] = useState<Session | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [activeTab, setActiveTab] = useState<
    "charts" | "training" | "logs" | "metadata" | "workflow"
  >("charts");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [openMetricDropdown, setOpenMetricDropdown] = useState<number | null>(null);
  const [episodeViewMode, setEpisodeViewMode] = useState<"episodes" | "groups">("episodes");
  const [metaSearchQuery, setMetaSearchQuery] = useState("");

  // Chart expanded groups (lifted from MetricsDashboard to persist across tab switches)
  const [chartExpandedGroups, setChartExpandedGroups] = useState<Set<string>>(new Set());
  const [chartHasAutoExpanded, setChartHasAutoExpanded] = useState(false);

  // Code tab expanded sections (lifted from WorkflowDiagram to persist across tab switches)
  const [codeExpandedSections, setCodeExpandedSections] = useState<Set<string>>(new Set());

  // Rename/delete state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Chat session state
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);

  // Resizable panel state
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(384);
  const [isDragging, setIsDragging] = useState<'left' | 'right' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((divider: 'left' | 'right') => {
    setIsDragging(divider);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - containerRect.left;
    
    if (isDragging === 'left') {
      const newWidth = Math.max(200, Math.min(500, mouseX));
      setLeftPanelWidth(newWidth);
    } else if (isDragging === 'right') {
      const newWidth = Math.max(250, Math.min(600, containerRect.width - mouseX));
      setRightPanelWidth(newWidth);
    }
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(null);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const { metrics, isConnected } = useMetricsSSE({
    sessionId: sessionId || "",
    enabled: !!sessionId,
  });

  const { logs, isLoading: logsLoading } = useLogsSSE({
    sessionId: sessionId || "",
    enabled: !!sessionId,
  });

  const fetchSessionDetails = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/sessions/${sessionId}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setSession(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const fetchEpisodes = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/episodes?session_id=${sessionId}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setEpisodes(data);
    } catch (err: any) {
      console.error("Error fetching episodes:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) {
      fetchSessionDetails();
      fetchEpisodes();
      // Load most recent chat session
      apiFetch(`/api/agent/sessions?session_id=${sessionId}`)
        .then((r) => r.ok ? r.json() : [])
        .then((sessions: { id: string }[]) => {
          if (sessions.length > 0) {
            setActiveChatSessionId(sessions[0].id);
          } else {
            setActiveChatSessionId(null);
          }
        })
        .catch(() => setActiveChatSessionId(null));
    }
  }, [sessionId, fetchSessionDetails, fetchEpisodes]);

  const isRunning = session?.status === 'running';
  usePolling(fetchEpisodes, { interval: 5000, enabled: !!sessionId && isRunning });

  useEffect(() => {
    if (metrics.length > 0 && selectedMetrics.length === 0) {
      const available = getAvailableMetrics(metrics);
      if (available.length > 0) {
        const defaultMetric = available.includes("reward/mean")
          ? "reward/mean"
          : available[0];
        setSelectedMetrics([defaultMetric]);
      }
    }
  }, [metrics, selectedMetrics.length]);

  const addMetricChart = () => {
    const available = getAvailableMetrics(metrics);
    const unusedMetrics = available.filter(m => !selectedMetrics.includes(m));
    if (unusedMetrics.length > 0) {
      setSelectedMetrics([...selectedMetrics, unusedMetrics[0]]);
    }
  };

  const updateMetric = (index: number, metric: string) => {
    const newMetrics = [...selectedMetrics];
    newMetrics[index] = metric;
    setSelectedMetrics(newMetrics);
  };

  const removeMetricChart = (index: number) => {
    if (selectedMetrics.length > 1) {
      setSelectedMetrics(selectedMetrics.filter((_, i) => i !== index));
    }
  };

  const handleStepClick = (step: number | null) => {
    setSelectedStep(step);
  };

  const renamingRef = useRef(false);
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
    if (!sessionId || !session) return;
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        navigate(`/project/${session.project_id}`);
      }
    } catch { /* ignore */ }
  };

  const handleColorChange = (color: string) => {
    if (!sessionId) return;
    updateColor(sessionId, color);
  };

  const handleChartsChartClick = (step: number, metric: string) => {
    setSelectedStep(step);
    setSelectedMetrics([metric]);
    setActiveTab("training");
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-layer-1">
        <Spinner size="md" variant="blue" label="Loading..." />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 p-6 bg-layer-1">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
            <div className="flex items-start gap-3">
              <WarningIcon size={20} className="text-red-500" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">
                  Error Loading Session
                </h3>
                <p className="text-sm text-gray-600">
                  {error || "Session not found"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const experimentColor = sessionId ? (colorOverrides[sessionId] || session?.color || getExperimentColor(sessionId)) : undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                navigate(`/project/${session.project_id}`)
              }
              className="p-1 hover:bg-layer-2 text-gray-400 hover:text-gray-700 rounded-md transition-colors"
              title="Back to project overview"
            >
              <ArrowBackIcon size={20} />
            </button>
            {experimentColor && (
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: experimentColor }}
              />
            )}
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
              <h1 className="text-lg font-semibold text-gray-900">
                {session.experiment}
              </h1>
            )}
            <ActionMenu
              onRename={() => {
                setRenameValue(session.experiment);
                setIsRenaming(true);
              }}
              onDelete={() => setShowDeleteConfirm(true)}
              onChangeColor={handleColorChange}
              currentColor={experimentColor}
            />
            <div className="ml-auto">
              <StatusBadge status={session.status} />
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-4 flex items-center justify-between">
          <nav className="flex gap-1">
            {[
              { id: "charts", label: "Charts" },
              { id: "training", label: "Training" },
              { id: "logs", label: "Logs" },
              { id: "workflow", label: "Code" },
              { id: "metadata", label: "Config" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
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
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === "charts" ? (
          <MetricsDashboard
            metrics={metrics}
            isConnected={isConnected}
            onChartClick={handleChartsChartClick}
            color={experimentColor}
            expandedGroups={chartExpandedGroups}
            onExpandedGroupsChange={setChartExpandedGroups}
            hasAutoExpanded={chartHasAutoExpanded}
            onHasAutoExpandedChange={setChartHasAutoExpanded}
          />
        ) : activeTab === "training" ? (
          <div 
            ref={containerRef}
            style={{ height: '100%', display: 'flex' }}
          >
            {/* Left Panel - Charts */}
            <div 
              style={{ 
                width: `${leftPanelWidth}px`, 
                flexShrink: 0, 
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #e5e7eb'
              }}
              className="bg-white"
            >
              <div className="px-4 h-14 border-b border-gray-200 flex items-center justify-between" style={{ flexShrink: 0 }}>
                <span className="text-sm font-medium text-gray-900">Metrics</span>
                <span className="text-sm text-gray-500">
                  {selectedMetrics.length} chart{selectedMetrics.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }} className="p-2 space-y-2">
                {selectedMetrics.map((metric, index) => (
                  <div key={index} className="bg-layer-1 rounded-lg border border-gray-200 flex flex-col">
                    {/* Chart Header */}
                    <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between gap-2">
                      <div
                        className="relative flex-shrink-0"
                        onMouseEnter={() => setOpenMetricDropdown(index)}
                        onMouseLeave={() => setOpenMetricDropdown(null)}
                      >
                        <button
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-700 bg-white hover:bg-layer-2 rounded border border-gray-200 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                          </svg>
                          Select
                        </button>
                        <MetricSelectorModal
                          isOpen={openMetricDropdown === index}
                          onClose={() => setOpenMetricDropdown(null)}
                          availableMetrics={getAvailableMetrics(metrics)}
                          selectedMetric={metric}
                          onSelectionChange={(m) => m && updateMetric(index, m)}
                        />
                      </div>
                      <div className="flex items-center gap-1 min-w-0 flex-1 justify-end">
                        <span className="text-xs text-gray-500 font-mono truncate">
                          {metric}
                        </span>
                        {selectedMetrics.length > 1 && (
                          <button
                            onClick={() => removeMetricChart(index)}
                            className="p-0.5 text-gray-400 hover:text-red-500 transition-colors"
                            title="Remove chart"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Chart */}
                    <div className="h-40 p-2 bg-white">
                      <RewardChart
                        metrics={metrics}
                        selectedMetric={metric}
                        selectedStep={selectedStep}
                        onStepClick={handleStepClick}
                        color={experimentColor}
                      />
                    </div>
                  </div>
                ))}

                {/* Add Chart Button */}
                <button
                  onClick={addMetricChart}
                  disabled={getAvailableMetrics(metrics).length <= selectedMetrics.length}
                  className="w-full py-2 px-3 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Chart
                </button>
              </div>
            </div>

            {/* Left Resizer */}
            <div
              onMouseDown={() => handleMouseDown('left')}
              style={{
                width: '4px',
                cursor: 'col-resize',
                backgroundColor: isDragging === 'left' ? '#3f72af' : 'transparent',
                transition: 'background-color 0.15s',
              }}
              className="hover:bg-accent-500 flex-shrink-0"
            />

            {/* Middle Panel - Episodes */}
            <div 
              style={{ 
                flex: 1, 
                minWidth: 0, 
                display: 'flex', 
                flexDirection: 'column', 
                overflow: 'hidden',
                borderRight: '1px solid #e5e7eb'
              }} 
              className="bg-white"
            >
              <div className="px-4 h-14 border-b border-gray-200 flex items-center justify-between" style={{ flexShrink: 0 }}>
                <span className="text-sm font-medium text-gray-900">Episodes</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <span className={`text-xs ${episodeViewMode === "groups" ? "text-gray-900" : "text-gray-500"}`}>
                    Trajectory Groups
                  </span>
                  <button
                    role="switch"
                    aria-checked={episodeViewMode === "groups"}
                    onClick={() => setEpisodeViewMode(episodeViewMode === "groups" ? "episodes" : "groups")}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      episodeViewMode === "groups" ? "bg-accent-500" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        episodeViewMode === "groups" ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </label>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <EpisodePanel
                  episodes={episodes}
                  selectedStep={selectedStep}
                  sessionId={sessionId}
                  viewMode={episodeViewMode}
                  onViewModeChange={setEpisodeViewMode}
                />
              </div>
            </div>

            {/* Right Resizer */}
            <div
              onMouseDown={() => handleMouseDown('right')}
              style={{
                width: '4px',
                cursor: 'col-resize',
                backgroundColor: isDragging === 'right' ? '#3f72af' : 'transparent',
                transition: 'background-color 0.15s',
              }}
              className="hover:bg-accent-500 flex-shrink-0"
            />

            {/* Right Panel - Agent */}
            <div 
              style={{ 
                width: `${rightPanelWidth}px`, 
                flexShrink: 0, 
                display: 'flex', 
                flexDirection: 'column', 
                overflow: 'hidden' 
              }} 
              className="bg-white"
            >
              <div className="px-4 h-14 border-b border-gray-200 flex items-center justify-between" style={{ flexShrink: 0 }}>
                <span className="text-sm font-medium text-gray-900">Agent</span>
                {sessionId && (
                  <ChatSessionMenu
                    sessionId={sessionId}
                    activeChatSessionId={activeChatSessionId}
                    onSelect={(id) => setActiveChatSessionId(id)}
                    onNew={async () => {
                      try {
                        const res = await apiFetch("/api/agent/sessions", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ session_id: sessionId }),
                        });
                        if (res.ok) {
                          const cs = await res.json();
                          setActiveChatSessionId(cs.id);
                        }
                      } catch { /* ignore */ }
                    }}
                    onDelete={async (id) => {
                      try {
                        await apiFetch(`/api/agent/sessions/${id}`, { method: "DELETE" });
                        if (id === activeChatSessionId) {
                          // Switch to another session or clear
                          const res = await apiFetch(`/api/agent/sessions?session_id=${sessionId}`);
                          const sessions = res.ok ? await res.json() : [];
                          setActiveChatSessionId(sessions.length > 0 ? sessions[0].id : null);
                        }
                      } catch { /* ignore */ }
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <ChatPanel
                  sessionId={sessionId}
                  activeChatSessionId={activeChatSessionId}
                  onChatSessionIdChange={setActiveChatSessionId}
                />
              </div>
            </div>
          </div>
        ) : activeTab === "logs" ? (
          <LogsPanel logs={logs} isLoading={logsLoading} />
        ) : activeTab === "metadata" ? (
          <div className="h-full flex flex-col bg-white">
            {session.config ? (
              <>
                {/* Search bar */}
                <div className="px-4 h-14 border-b border-gray-200 flex-shrink-0 flex items-center">
                  <div className="relative w-full">
                    <input
                      type="text"
                      placeholder="Search config..."
                      value={metaSearchQuery}
                      onChange={(e) => setMetaSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-8 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
                    />
                    <SearchIcon
                      size={16}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    {metaSearchQuery && (
                      <button
                        onClick={() => setMetaSearchQuery("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {/* Config sections */}
                <div className="flex-1 overflow-auto">
                  <ConfigRenderer data={session.config} searchQuery={metaSearchQuery.trim()} />
                </div>
              </>
            ) : (
              <EmptyState
                icon={
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                }
                title="No configuration data"
                className="h-full"
              />
            )}
          </div>
        ) : activeTab === "workflow" ? (
          <div style={{ height: '100%' }}>
            <WorkflowDiagram
              session={session}
              expandedSections={codeExpandedSections}
              onExpandedSectionsChange={setCodeExpandedSections}
            />
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete experiment?"
        message={`This will permanently delete "${session.experiment}" and all its metrics, episodes, and logs.`}
        onConfirm={handleDeleteSession}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
};
