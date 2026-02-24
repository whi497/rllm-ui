import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  FolderOpenIcon,
  SettingsIcon,
  MenuBookIcon,
  NorthEastIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  VisibilityIcon,
  VisibilityOffIcon,
  SearchIcon,
  PushPinIcon,
} from "./icons";
import { ActionMenu } from "./ActionMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { getExperimentColor } from "../utils/experimentColors";
import { useExperimentVisibility } from "../contexts/ExperimentVisibilityContext";
import { apiFetch } from "../config/api";
import { useClickOutside } from "./ui";
import { useAuth } from "../contexts/AuthContext";

interface Session {
  id: string;
  project_id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  color: string | null;
  status: "running" | "completed" | "failed" | "crashed";
  created_at: string;
  completed_at: string | null;
}

interface ProjectData {
  id: string;
  project: string;
  sessions: Session[];
}

export const Sidebar: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [panelWidth, setPanelWidth] = useState(220);
  const isDragging = useRef(false);

  const isProjectsActive =
    location.pathname === "/" ||
    location.pathname.startsWith("/runs") ||
    location.pathname.startsWith("/project");

  const isSettingsActive = location.pathname === "/settings";

  // Are we on a project overview page?
  const projectOverviewMatch = useMemo(() => {
    const match = location.pathname.match(/^\/project\/(.+)$/);
    return match ? match[1] : null; // This is now the project ID
  }, [location.pathname]);

  // Are we on a single run page?
  const activeSessionId = useMemo(() => {
    const match = location.pathname.match(/^\/runs\/(.+)$/);
    return match ? match[1] : null;
  }, [location.pathname]);

  // The project to show in experiments panel (from overview or run)
  const activeProject = useMemo(() => {
    if (projectOverviewMatch) {
      return (
        projects.find((p) => p.id === projectOverviewMatch) ?? null
      );
    }
    if (activeSessionId) {
      return (
        projects.find((p) =>
          p.sessions.some((s) => s.id === activeSessionId)
        ) ?? null
      );
    }
    return null;
  }, [projectOverviewMatch, activeSessionId, projects]);

  // Fetch projects
  const fetchProjects = useCallback(async () => {
    try {
      const response = await apiFetch("/api/sessions");
      if (!response.ok) return;
      const data: Session[] = await response.json();

      const map = new Map<string, ProjectData>();
      for (const s of data) {
        const projectId = s.project_id;
        const projectName = s.project || "default";
        if (!map.has(projectId)) {
          map.set(projectId, { id: projectId, project: projectName, sessions: [] });
        }
        map.get(projectId)!.sessions.push(s);
      }
      setProjects(Array.from(map.values()));
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 10000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  // Auto-collapse main sidebar when navigating away from home (project overview, run, or settings)
  useEffect(() => {
    if (projectOverviewMatch || activeSessionId || isSettingsActive) {
      setIsCollapsed(true);
    } else {
      setIsCollapsed(false);
    }
  }, [projectOverviewMatch, activeSessionId, isSettingsActive]);

  // Drag resize for experiments panel
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const sidebarWidth = isCollapsed ? 44 : 160;
      const newWidth = Math.max(120, Math.min(400, e.clientX - sidebarWidth));
      setPanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isCollapsed]);

  const handleExperimentClick = (sessionId: string) => {
    navigate(`/runs/${sessionId}`);
  };

  // Show experiments panel only on project overview (not on single run)
  const showExperimentsPanel = !!projectOverviewMatch && !!activeProject;

  return (
    <aside className="flex h-screen flex-shrink-0">
      {/* Main sidebar */}
      <div
        style={{
          width: isCollapsed ? "44px" : "160px",
          minWidth: isCollapsed ? "44px" : "160px",
          transition: "width 0.2s, min-width 0.2s",
        }}
        className="bg-white border-r border-gray-200 flex flex-col flex-shrink-0"
      >
        {/* Logo/Header */}
        <div
          className={`h-14 flex items-center ${isCollapsed ? "justify-center px-1" : "justify-between pl-4 pr-2"}`}
        >
          {!isCollapsed && (
            <Link to="/">
              <img
                src="/rllm_logo_black.png"
                alt="rLLM"
                className="h-5 w-auto"
              />
            </Link>
          )}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1.5 hover:bg-layer-2 text-gray-400 hover:text-gray-600 rounded-md transition-colors"
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? (
              <SidebarExpandIcon size={18} />
            ) : (
              <SidebarCollapseIcon size={18} />
            )}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 px-2">
          <Link
            to="/"
            className={`
              flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg
              transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              ${
                isProjectsActive
                  ? "bg-accent-50 text-accent-700"
                  : "text-gray-600 hover:bg-layer-1 hover:text-gray-900"
              }
            `}
            title={isCollapsed ? "Projects" : undefined}
          >
            <FolderOpenIcon size={18} className="flex-shrink-0" />
            {!isCollapsed && <span>Projects</span>}
          </Link>
          <Link
            to="/settings"
            className={`
              flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg
              transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              ${
                isSettingsActive
                  ? "bg-accent-50 text-accent-700"
                  : "text-gray-600 hover:bg-layer-1 hover:text-gray-900"
              }
            `}
            title={isCollapsed ? "Settings" : undefined}
          >
            <SettingsIcon size={18} className="flex-shrink-0" />
            {!isCollapsed && <span>Settings</span>}
          </Link>
          <a
            href="https://rllm-project.readthedocs.io/"
            target="_blank"
            rel="noopener noreferrer"
            className={`
              flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg
              transition-colors duration-150
              text-gray-600 hover:bg-layer-1 hover:text-gray-900
              ${isCollapsed ? "justify-center" : ""}
            `}
            title={isCollapsed ? "Docs" : undefined}
          >
            <MenuBookIcon size={18} className="flex-shrink-0" />
            {!isCollapsed && (
              <>
                <span>Docs</span>
                <NorthEastIcon size={14} className="flex-shrink-0 text-gray-400" />
              </>
            )}
          </a>
        </nav>

        {/* User menu (cloud mode only) */}
        <UserMenu isCollapsed={isCollapsed} />
      </div>

      {/* Experiments panel — only on project overview */}
      {showExperimentsPanel && (
        <>
          <div
            style={{ width: `${panelWidth}px`, minWidth: `${panelWidth}px` }}
            className="bg-white border-r border-gray-200 flex flex-col overflow-hidden flex-shrink-0"
          >
            <ExperimentsPanel
              project={activeProject!}
              onExperimentClick={handleExperimentClick}
              onRefresh={fetchProjects}
            />
          </div>
          {/* Drag handle */}
          <div
            onMouseDown={handleDragStart}
            className="w-1 hover:bg-accent-400 cursor-col-resize flex-shrink-0 transition-colors"
            style={{ marginLeft: "-2px", marginRight: "-2px", zIndex: 10 }}
          />
        </>
      )}
    </aside>
  );
};

/* ─── User Menu (cloud mode only) ──────────────────────────────────── */

const UserMenu: React.FC<{ isCollapsed: boolean }> = ({ isCollapsed }) => {
  const { config, user } = useAuth();

  if (!config?.auth_required || !user) return null;

  const initials = (user.name || user.email)[0].toUpperCase();

  return (
    <div className="px-2 pb-2">
      <div
        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-gray-600 ${isCollapsed ? "justify-center" : ""}`}
        title={isCollapsed ? user.email : undefined}
      >
        <span className="w-6 h-6 rounded-full bg-accent-100 text-accent-700 flex items-center justify-center text-xs font-medium flex-shrink-0">
          {initials}
        </span>
        {!isCollapsed && (
          <span className="truncate text-xs">{user.email}</span>
        )}
      </div>
    </div>
  );
};

/* ─── Experiments Panel with Eye Toggles ───────────────────────────── */

const ExperimentsPanel: React.FC<{
  project: ProjectData;
  onExperimentClick: (sessionId: string) => void;
  onRefresh: () => void;
}> = ({ project, onExperimentClick, onRefresh }) => {
  const navigate = useNavigate();
  const { hiddenExperiments, toggleExperiment, resetVisibility, hideAll, pinnedExperiments, togglePin, colorOverrides, updateColor } = useExperimentVisibility();

  // Project rename state
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState("");

  // Session rename state
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionRenameValue, setSessionRenameValue] = useState("");

  // Search
  const [searchQuery, setSearchQuery] = useState("");

  // Eye menu
  const [eyeMenuOpen, setEyeMenuOpen] = useState(false);
  const eyeMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(eyeMenuRef, () => setEyeMenuOpen(false), eyeMenuOpen);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: "project" | "session";
    id: string;
    name: string;
  } | null>(null);

  const renamingProjectRef = useRef(false);
  const handleRenameProject = async () => {
    if (renamingProjectRef.current) return;
    renamingProjectRef.current = true;
    const trimmed = projectRenameValue.trim();
    if (!trimmed) { setIsRenamingProject(false); renamingProjectRef.current = false; return; }
    try {
      const res = await apiFetch(`/api/sessions/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: trimmed }),
      });
      if (res.ok) onRefresh();
    } catch { /* ignore */ }
    setIsRenamingProject(false);
    renamingProjectRef.current = false;
  };

  const handleDeleteProject = async () => {
    try {
      const res = await apiFetch(`/api/sessions/projects/${project.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteConfirm(null);
        onRefresh();
        navigate("/");
      }
    } catch { /* ignore */ }
  };

  const renamingSessionRef = useRef(false);
  const handleRenameSession = async (sessionId: string) => {
    if (renamingSessionRef.current) return;
    renamingSessionRef.current = true;
    const trimmed = sessionRenameValue.trim();
    if (!trimmed) { setRenamingSessionId(null); renamingSessionRef.current = false; return; }
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_experiment_name: trimmed }),
      });
      if (res.ok) onRefresh();
    } catch { /* ignore */ }
    setRenamingSessionId(null);
    renamingSessionRef.current = false;
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteConfirm(null);
        onRefresh();
        // If last session, go home
        if (project.sessions.length <= 1) {
          navigate("/");
        }
      }
    } catch { /* ignore */ }
  };

  const handleColorChange = (sessionId: string, color: string) => {
    updateColor(sessionId, color);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Project name header with actions */}
      <div className="h-14 flex items-center border-b border-gray-200 flex-shrink-0 pl-4 pr-1 gap-1">
        {isRenamingProject ? (
          <input
            autoFocus
            value={projectRenameValue}
            onChange={(e) => setProjectRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameProject();
              if (e.key === "Escape") setIsRenamingProject(false);
            }}
            onBlur={handleRenameProject}
            className="text-base font-semibold text-gray-700 truncate flex-1 min-w-0 border border-gray-300 rounded px-1.5 py-0.5 outline-none ring-0 focus:border-gray-300 focus:ring-0 focus:outline-none"
          />
        ) : (
          <span className="text-base font-semibold text-gray-700 truncate flex-1 min-w-0">
            {project.project}
          </span>
        )}
        <ActionMenu
          onRename={() => {
            setProjectRenameValue(project.project);
            setIsRenamingProject(true);
          }}
          onDelete={() =>
            setDeleteConfirm({ type: "project", id: project.id, name: project.project })
          }
        />
      </div>

      {/* Search + visibility controls */}
      <div className="px-2 pt-2 pb-1 flex-shrink-0 flex items-center gap-1">
        {/* Eye menu */}
        <div ref={eyeMenuRef} className="relative flex-shrink-0">
          <button
            onClick={() => setEyeMenuOpen(!eyeMenuOpen)}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-layer-2 transition-colors"
            title="Visibility options"
          >
            <VisibilityIcon size={16} />
          </button>
          {eyeMenuOpen && (
            <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 w-36">
              <button
                onClick={() => {
                  resetVisibility();
                  setEyeMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-layer-1 transition-colors"
              >
                <VisibilityIcon size={16} />
                Show all
              </button>
              <button
                onClick={() => {
                  hideAll(project.sessions.map((s) => s.id));
                  setEyeMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-layer-1 transition-colors"
              >
                <VisibilityOffIcon size={16} />
                Hide all
              </button>
            </div>
          )}
        </div>
        {/* Search */}
        <div className="flex-1 relative">
          <SearchIcon
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full pl-7 pr-2 py-1 text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:border-gray-400 placeholder-gray-400"
          />
        </div>
      </div>

      {/* Experiment list */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {project.sessions
          .filter((s) =>
            s.experiment.toLowerCase().includes(searchQuery.toLowerCase())
          )
          .sort((a, b) => {
            const aPinIdx = pinnedExperiments.indexOf(a.id);
            const bPinIdx = pinnedExperiments.indexOf(b.id);
            const aIsPinned = aPinIdx !== -1;
            const bIsPinned = bPinIdx !== -1;
            if (aIsPinned && !bIsPinned) return -1;
            if (!aIsPinned && bIsPinned) return 1;
            if (aIsPinned && bIsPinned) return aPinIdx - bPinIdx;
            return 0;
          })
          .map((session) => {
          const color = colorOverrides[session.id] || session.color || getExperimentColor(session.id);
          const isHidden = hiddenExperiments.has(session.id);
          const isRenaming = renamingSessionId === session.id;
          const isPinned = pinnedExperiments.includes(session.id);

          return (
            <div
              key={session.id}
              className="flex items-center gap-1.5 rounded-md transition-colors mb-0.5 px-2 py-2 hover:bg-layer-2 group"
            >
              {/* Eye toggle / Pin icon */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExperiment(session.id);
                }}
                className="flex-shrink-0 transition-opacity"
                title={isPinned ? "Pinned" : isHidden ? "Show on chart" : "Hide from chart"}
                style={{ color: isHidden ? "#d1d5db" : color }}
              >
                {isPinned ? (
                  <PushPinIcon size={18} />
                ) : isHidden ? (
                  <VisibilityOffIcon size={18} />
                ) : (
                  <VisibilityIcon size={18} />
                )}
              </button>

              {/* Experiment name */}
              {isRenaming ? (
                <input
                  autoFocus
                  value={sessionRenameValue}
                  onChange={(e) => setSessionRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSession(session.id);
                    if (e.key === "Escape") setRenamingSessionId(null);
                  }}
                  onBlur={() => handleRenameSession(session.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm font-medium text-gray-800 truncate flex-1 min-w-0 border border-gray-300 rounded px-1 py-0 outline-none ring-0 focus:border-gray-300 focus:ring-0 focus:outline-none"
                />
              ) : (
                <button
                  onClick={() => onExperimentClick(session.id)}
                  className="text-sm font-medium text-gray-800 hover:text-accent-700 truncate text-left flex-1 min-w-0"
                >
                  {session.experiment}
                </button>
              )}

              {/* Action menu */}
              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <ActionMenu
                  onRename={() => {
                    setSessionRenameValue(session.experiment);
                    setRenamingSessionId(session.id);
                  }}
                  onDelete={() =>
                    setDeleteConfirm({
                      type: "session",
                      id: session.id,
                      name: session.experiment,
                    })
                  }
                  onChangeColor={(c) => handleColorChange(session.id, c)}
                  currentColor={color}
                  onPin={() => togglePin(session.id)}
                  isPinned={isPinned}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title={
          deleteConfirm?.type === "project"
            ? "Delete project?"
            : "Delete experiment?"
        }
        message={
          deleteConfirm?.type === "project"
            ? `This will permanently delete "${deleteConfirm?.name}" and all its experiments.`
            : `This will permanently delete "${deleteConfirm?.name}" and all its data.`
        }
        onConfirm={() => {
          if (!deleteConfirm) return;
          if (deleteConfirm.type === "project") handleDeleteProject();
          else handleDeleteSession(deleteConfirm.id);
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
};
