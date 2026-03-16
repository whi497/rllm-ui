"use client";

import React, { useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  SparklesIcon,
  SearchIcon,
  DownloadIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  DeleteIcon,
  ActivityIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

interface Skill {
  id: string;
  title: string;
  description: string;
  category: string;
  confidence: number;
  reward_delta: number;
  success_rate: string;
  evidence_count: number;
  source_session_ids: string[];
  tags: string[];
  is_active: boolean;
  metadata: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

interface AgentSession {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  "tool-strategy": { bg: "bg-blue-100", text: "text-blue-700" },
  "error-recovery": { bg: "bg-red-100", text: "text-red-700" },
  "prompt-technique": { bg: "bg-purple-100", text: "text-purple-700" },
  "task-decomposition": { bg: "bg-green-100", text: "text-green-700" },
  "verification-pattern": { bg: "bg-yellow-100", text: "text-yellow-800" },
  "resource-optimization": { bg: "bg-orange-100", text: "text-orange-700" },
  general: { bg: "bg-gray-100", text: "text-gray-600" },
};

function CategoryBadge({ category }: { category: string }) {
  const c = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}
    >
      {category}
    </span>
  );
}

function RewardDeltaBar({
  value,
  maxValue,
}: {
  value: number;
  maxValue: number;
}) {
  const pct = Math.round(value * 100);
  const widthPct = maxValue > 0 ? Math.round((value / maxValue) * 100) : 0;
  const color =
    pct >= 40 ? "bg-green-500" : pct >= 20 ? "bg-yellow-500" : "bg-gray-400";
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-300`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-12 text-right tabular-nums">
        +{pct}%
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const SkillsPage: React.FC = () => {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const initialLoadDone = useRef(false);

  // Distillation modal state
  const [showDistillModal, setShowDistillModal] = useState(false);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    new Set()
  );
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState("");

  // Delete state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const fetchSkills = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch("/api/skills");
      if (!resp.ok) throw new Error("Failed to fetch skills");
      const data: Skill[] = await resp.json();
      setSkills(data);
    } catch {
      if (!initialLoadDone.current) setSkills([]);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  usePolling(fetchSkills, { interval: 30000 });

  const filtered = useMemo(() => {
    let result = skills;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    if (categoryFilter) {
      result = result.filter((s) => s.category === categoryFilter);
    }
    // Sort by reward_delta descending (highest impact first)
    return [...result].sort((a, b) => b.reward_delta - a.reward_delta);
  }, [skills, searchQuery, categoryFilter]);

  const maxRewardDelta = useMemo(
    () => Math.max(...filtered.map((s) => s.reward_delta), 0.01),
    [filtered]
  );

  const categories = useMemo(() => {
    const cats = new Set(skills.map((s) => s.category));
    return Array.from(cats).sort();
  }, [skills]);

  const handleToggleActive = async (skill: Skill) => {
    const resp = await apiFetch(`/api/skills/${skill.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !skill.is_active }),
    });
    if (resp.ok) fetchSkills();
  };

  const handleDelete = async (id: string) => {
    const resp = await apiFetch(`/api/skills/${id}`, { method: "DELETE" });
    if (resp.ok) {
      setDeleteConfirm(null);
      fetchSkills();
    }
  };

  const handleExport = (skillId: string) => {
    window.open(`/api/skills/${skillId}/export`, "_blank");
  };

  // Distillation
  const openDistillModal = async () => {
    setShowDistillModal(true);
    setDistillError("");
    setSelectedSessions(new Set());
    try {
      const resp = await apiFetch("/api/agent-sessions?source=postgres&limit=200");
      if (resp.ok) {
        const raw = await resp.json();
        const data: AgentSession[] = raw.items || raw;
        setAgentSessions(data);
      }
    } catch {
      setAgentSessions([]);
    }
  };

  const handleDistill = async () => {
    if (selectedSessions.size === 0) return;
    setDistilling(true);
    setDistillError("");
    try {
      const resp = await apiFetch("/api/skills/distill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: Array.from(selectedSessions), source: "postgres" }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setDistillError(err.detail || "Distillation failed");
        return;
      }
      setShowDistillModal(false);
      fetchSkills();
    } catch {
      setDistillError("Network error");
    } finally {
      setDistilling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold text-black">Skills</h1>
          <button
            onClick={openDistillModal}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-lg transition-colors"
          >
            <SparklesIcon size={16} />
            Distill from Sessions
          </button>
        </div>

        {/* Search + Filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <SearchIcon size={18} className="text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search skills..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400"
            />
          </div>
          {categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            >
              <option value="">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Summary */}
        <div className="mb-4">
          <p className="text-sm text-gray-600">
            <span className="font-medium text-black">{filtered.length}</span>{" "}
            skill{filtered.length !== 1 ? "s" : ""} ranked by reward delta
            {skills.filter((s) => s.is_active).length > 0 && (
              <span className="ml-2 text-green-600">
                ({skills.filter((s) => s.is_active).length} active)
              </span>
            )}
          </p>
        </div>

        {/* Content */}
        {skills.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <EmptyState
              icon={<SparklesIcon size={32} className="text-gray-400" />}
              title="No skills yet"
              description='Click "Distill from Sessions" to extract skills from your agent execution traces.'
              iconSize="lg"
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <EmptyState
              icon={<SearchIcon size={32} className="text-gray-400" />}
              title="No matching skills"
              description="Try adjusting your search or filter."
              iconSize="lg"
            />
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((skill, rank) => (
              <div
                key={skill.id}
                className="bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-gray-300 cursor-pointer transition-all group"
                onClick={() => router.push(`/skills/${skill.id}`)}
              >
                <div className="flex items-center gap-4">
                  {/* Rank number */}
                  <span className="text-lg font-bold text-gray-300 w-6 text-right flex-shrink-0 tabular-nums">
                    {rank + 1}
                  </span>

                  {/* Title + metadata */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-gray-900 truncate">
                        {skill.title}
                      </h3>
                      <CategoryBadge category={skill.category} />
                      {skill.is_active && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span>{skill.evidence_count} trajectories</span>
                      <span>confidence {Math.round(skill.confidence * 100)}%</span>
                      {skill.tags.length > 0 && (
                        <span className="truncate">
                          {skill.tags.slice(0, 3).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Impact bar */}
                  <div className="w-48 flex-shrink-0">
                    <RewardDeltaBar
                      value={skill.reward_delta}
                      maxValue={maxRewardDelta}
                    />
                  </div>

                  {/* Actions */}
                  <div
                    className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => handleToggleActive(skill)}
                      className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                      title={skill.is_active ? "Deactivate" : "Activate"}
                    >
                      {skill.is_active ? (
                        <ToggleRightIcon size={16} className="text-green-600" />
                      ) : (
                        <ToggleLeftIcon size={16} className="text-gray-400" />
                      )}
                    </button>
                    <button
                      onClick={() => handleExport(skill.id)}
                      className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                      title="Export as .md"
                    >
                      <DownloadIcon size={14} className="text-gray-400" />
                    </button>
                    <button
                      onClick={() =>
                        setDeleteConfirm({
                          id: skill.id,
                          title: skill.title,
                        })
                      }
                      className="p-1.5 rounded-md hover:bg-red-50 transition-colors"
                      title="Delete"
                    >
                      <DeleteIcon size={14} className="text-gray-400" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete skill?"
        message={`This will permanently delete "${deleteConfirm?.title}".`}
        onConfirm={() => deleteConfirm && handleDelete(deleteConfirm.id)}
        onCancel={() => setDeleteConfirm(null)}
      />

      {/* Distillation modal */}
      {showDistillModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                Distill Skills from Agent Sessions
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Select agent sessions to analyze. Skills will be extracted from
                their execution traces.
              </p>
            </div>
            <div className="p-6 max-h-80 overflow-y-auto">
              {agentSessions.length === 0 ? (
                <div className="text-center py-8">
                  <ActivityIcon
                    size={24}
                    className="mx-auto text-gray-400 mb-2"
                  />
                  <p className="text-sm text-gray-500">
                    No agent sessions found. Run an agent with telemetry first.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {agentSessions.map((session) => (
                    <label
                      key={session.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSessions.has(session.id)}
                        onChange={() => {
                          const next = new Set(selectedSessions);
                          if (next.has(session.id)) next.delete(session.id);
                          else next.add(session.id);
                          setSelectedSessions(next);
                        }}
                        className="rounded border-gray-300"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {session.name || session.id.slice(0, 12)}
                        </p>
                        <p className="text-xs text-gray-400">
                          {session.status} &middot;{" "}
                          {formatDate(session.created_at)}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {distillError && (
                <p className="mt-3 text-sm text-red-600">{distillError}</p>
              )}
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setShowDistillModal(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDistill}
                disabled={selectedSessions.size === 0 || distilling}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {distilling ? (
                  <>
                    <Spinner />
                    Distilling...
                  </>
                ) : (
                  <>
                    <SparklesIcon size={16} />
                    Distill ({selectedSessions.size} selected)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
