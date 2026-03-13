"use client";

import React, { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowBackIcon,
  SparklesIcon,
  DownloadIcon,
  DeleteIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  ActivityIcon,
} from "./icons";
import { Spinner } from "./ui";
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

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  "tool-strategy": { bg: "bg-blue-100", text: "text-blue-700" },
  "error-recovery": { bg: "bg-red-100", text: "text-red-700" },
  "prompt-technique": { bg: "bg-purple-100", text: "text-purple-700" },
  "task-decomposition": { bg: "bg-green-100", text: "text-green-700" },
  "verification-pattern": { bg: "bg-yellow-100", text: "text-yellow-800" },
  "resource-optimization": { bg: "bg-orange-100", text: "text-orange-700" },
  general: { bg: "bg-gray-100", text: "text-gray-600" },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export const SkillDetail: React.FC<{ skillId: string }> = ({ skillId }) => {
  const router = useRouter();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDelete, setShowDelete] = useState(false);
  const initialLoadDone = useRef(false);

  const fetchSkill = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch(`/api/skills/${skillId}`);
      if (!resp.ok) throw new Error("Failed to fetch skill");
      const data: Skill = await resp.json();
      setSkill(data);
    } catch {
      if (!initialLoadDone.current) setSkill(null);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [skillId]);

  usePolling(fetchSkill, { interval: 60000 });

  const handleToggleActive = async () => {
    if (!skill) return;
    const resp = await apiFetch(`/api/skills/${skill.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !skill.is_active }),
    });
    if (resp.ok) fetchSkill();
  };

  const handleExport = () => {
    window.open(`/api/skills/${skillId}/export`, "_blank");
  };

  const handleDelete = async () => {
    const resp = await apiFetch(`/api/skills/${skillId}`, {
      method: "DELETE",
    });
    if (resp.ok) {
      router.push("/skills");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Skill not found</p>
      </div>
    );
  }

  const catColor =
    CATEGORY_COLORS[skill.category] || CATEGORY_COLORS.general;
  const confidencePct = Math.round(skill.confidence * 100);
  const rewardDeltaPct = Math.round(skill.reward_delta * 100);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-gray-200 bg-white px-8 py-4">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.push("/skills")}
            className="p-1 rounded-md hover:bg-gray-100 transition-colors"
          >
            <ArrowBackIcon size={20} className="text-gray-500" />
          </button>
          <SparklesIcon size={20} className="text-accent-600" />
          <h1 className="text-lg font-semibold text-gray-900 truncate flex-1">
            {skill.title}
          </h1>

          {/* Actions */}
          <button
            onClick={handleToggleActive}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              skill.is_active
                ? "bg-green-100 text-green-700 hover:bg-green-200"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {skill.is_active ? (
              <ToggleRightIcon size={16} />
            ) : (
              <ToggleLeftIcon size={16} />
            )}
            {skill.is_active ? "Active" : "Inactive"}
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors"
          >
            <DownloadIcon size={16} />
            Export .md
          </button>
          <button
            onClick={() => setShowDelete(true)}
            className="p-1.5 rounded-md hover:bg-red-50 transition-colors"
            title="Delete"
          >
            <DeleteIcon size={18} className="text-gray-400 hover:text-red-500" />
          </button>
        </div>

        {/* Metadata row */}
        <div className="flex items-center gap-4 text-sm">
          <span
            className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${catColor.bg} ${catColor.text}`}
          >
            {skill.category}
          </span>
          <span className="text-gray-500">
            Reward delta: <span className="font-semibold text-green-700">+{rewardDeltaPct}%</span>
          </span>
          <span className="text-gray-500">
            Confidence: <span className="font-medium text-gray-700">{confidencePct}%</span>
          </span>
          {skill.success_rate && (
            <span className="text-gray-500">
              Success: <span className="font-medium text-gray-700">{skill.success_rate}</span>
            </span>
          )}
          <span className="text-gray-500">
            Evidence: <span className="font-medium text-gray-700">{skill.evidence_count} trajectories</span>
          </span>
          <span className="text-gray-400">
            Created {formatDate(skill.created_at)}
          </span>
        </div>

        {/* Tags */}
        {skill.tags.length > 0 && (
          <div className="flex gap-1.5 mt-2">
            {skill.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6">
          {/* Skill description (markdown) */}
          <div className="prose prose-sm max-w-none prose-headings:text-gray-900 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-900 prose-code:text-gray-800 prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {skill.description}
            </ReactMarkdown>
          </div>

          {/* Source sessions */}
          {skill.source_session_ids.length > 0 && (
            <div className="mt-8 border-t border-gray-200 pt-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <ActivityIcon size={16} />
                Source Agent Sessions
              </h3>
              <div className="flex flex-wrap gap-2">
                {skill.source_session_ids.map((sid) => (
                  <button
                    key={sid}
                    onClick={() =>
                      router.push(`/observability/${sid}`)
                    }
                    className="inline-flex items-center px-3 py-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-xs font-mono text-gray-600 hover:text-accent-700 transition-colors"
                  >
                    {sid.slice(0, 12)}...
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={showDelete}
        title="Delete skill?"
        message={`This will permanently delete "${skill.title}".`}
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />
    </div>
  );
};
