import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchIcon, WarningIcon, BarChartIcon } from './icons';
import { Spinner, EmptyState } from './ui';
import { ActionMenu } from './ActionMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { API_BASE_URL } from '../config/api';

type SessionStatus = "running" | "completed" | "failed" | "crashed";

interface Session {
  id: string;
  project_id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  status: SessionStatus;
  created_at: string;
  completed_at: string | null;
}


interface ProjectData {
  id: string;
  project: string;
  sessions: Session[];
}

export const ProjectList: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const navigate = useNavigate();

  const initialLoadDone = useRef(false);

  const fetchSessions = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setSessions(data);
    } catch (err: any) {
      if (!initialLoadDone.current) setError(err.message);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // Group sessions into projects
  const projects = useMemo((): ProjectData[] => {
    const map = new Map<string, ProjectData>();
    for (const s of sessions) {
      const projectId = s.project_id;
      const projectName = s.project || 'default';
      if (!map.has(projectId)) {
        map.set(projectId, { id: projectId, project: projectName, sessions: [] });
      }
      map.get(projectId)!.sessions.push(s);
    }
    return Array.from(map.values());
  }, [sessions]);

  const getBaseModel = (session: Session): string => {
    if (!session.config) return 'N/A';
    const model = session.config.model || session.config.base_model || session.config.model_name;
    if (typeof model === 'string') return model;
    if (typeof model === 'object' && model !== null) {
      if ('name' in model && typeof model.name === 'string') return model.name;
      return 'Custom Model';
    }
    // verl-style configs: actor_rollout_ref.model.path
    const actorModel = session.config?.actor_rollout_ref?.model?.path;
    if (typeof actorModel === 'string') return actorModel;
    return 'N/A';
  };

  const getLastRequestTime = (session: Session): string => {
    const timestamp = session.completed_at || session.created_at;
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  // Filter projects and sessions by search query
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects
      .map((project) => {
        const projectMatches = project.project.toLowerCase().includes(q);
        const matchingSessions = project.sessions.filter(
          (s) =>
            s.experiment.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            getBaseModel(s).toLowerCase().includes(q)
        );
        if (projectMatches) return project;
        if (matchingSessions.length > 0) return { ...project, sessions: matchingSessions };
        return null;
      })
      .filter((p): p is ProjectData => p !== null);
  }, [projects, searchQuery]);

  const handleRenameProject = async (projectId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: trimmed }),
      });
      if (res.ok) {
        setRenamingProjectId(null);
        fetchSessions();
      }
    } catch {
      // ignore
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions/projects/${projectId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDeleteConfirm(null);
        fetchSessions();
      }
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" variant="black" label="Loading training runs..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-8">
        <div className="max-w-2xl mx-auto">
          <div className="bg-layer-1 border border-gray-300 rounded-xl p-6 mb-4">
            <div className="flex items-start gap-3">
              <WarningIcon sx={{ fontSize: 28 }} className="text-black" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-black mb-1">Error loading sessions</h3>
                <p className="text-sm text-gray-700">{error}</p>
              </div>
            </div>
          </div>
          <button
            onClick={fetchSessions}
            className="px-4 py-2 bg-black hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors duration-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const totalRuns = filteredProjects.reduce((sum, p) => sum + p.sessions.length, 0);

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-black mb-2">Projects</h1>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <SearchIcon sx={{ fontSize: 20 }} className="text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search projects and runs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-base border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 transition-all duration-200"
            />
          </div>
        </div>

        {/* Summary */}
        <div className="mb-4">
          <p className="text-base text-gray-600">
            <span className="font-medium text-black">{filteredProjects.length}</span> project{filteredProjects.length !== 1 ? 's' : ''}{' '}
            &middot; <span className="font-medium text-black">{totalRuns}</span> run{totalRuns !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Empty state */}
        {filteredProjects.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <EmptyState
              icon={<BarChartIcon sx={{ fontSize: 32 }} className="text-gray-400" />}
              title={searchQuery ? 'No matching training runs' : 'No training runs yet'}
              iconSize="lg"
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredProjects.map((project) => {
              const latestSession = project.sessions[0];
              const isRenaming = renamingProjectId === project.id;

              return (
                <div
                  key={project.id}
                  onClick={() => {
                    if (!isRenaming) navigate(`/project/${project.id}`);
                  }}
                  className="bg-white border border-gray-200 rounded-xl p-5 text-left hover:border-gray-300 hover:shadow-sm transition-all group relative cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameProject(project.id);
                          if (e.key === 'Escape') setRenamingProjectId(null);
                        }}
                        onBlur={() => handleRenameProject(project.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="text-base font-semibold text-black mb-1 truncate flex-1 min-w-0 border border-gray-300 rounded px-1.5 py-0.5 outline-none ring-0 focus:border-gray-300 focus:ring-0 focus:outline-none"
                      />
                    ) : (
                      <div className="text-base font-semibold text-black mb-1 truncate group-hover:text-accent-700 flex-1 min-w-0">
                        {project.project}
                      </div>
                    )}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <ActionMenu
                        onRename={() => {
                          setRenameValue(project.project);
                          setRenamingProjectId(project.id);
                        }}
                        onDelete={() => setDeleteConfirm({ id: project.id, name: project.project })}
                      />
                    </div>
                  </div>
                  <div className="text-sm text-gray-500">
                    {project.sessions.length} run{project.sessions.length !== 1 ? 's' : ''}
                    {latestSession && (
                      <span className="text-gray-400"> &middot; {getLastRequestTime(latestSession)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete project?"
        message={`This will permanently delete "${deleteConfirm?.name}" and all its experiments, metrics, episodes, and logs. This action cannot be undone.`}
        onConfirm={() => deleteConfirm && handleDeleteProject(deleteConfirm.id)}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
};
