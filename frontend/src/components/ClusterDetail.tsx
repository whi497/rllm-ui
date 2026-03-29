"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowBackIcon, SparklesIcon, LayersIcon } from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";
import { useJobPolling, Job } from "../hooks/useJobPolling";

interface ClusterMember {
  id: string;
  cluster_id: string;
  session_id: string;
  labels: Record<string, string>;
  summary: string;
  created_at: string;
}

interface ClusterData {
  id: string;
  name: string;
  task_type: string;
  description: string;
  member_count: number;
  metadata: Record<string, any>;
  members: ClusterMember[];
  created_at: string;
}

interface ClusterSkill {
  id: string;
  title: string;
  category: string;
  reward_delta: number;
  confidence: number;
  evidence_count: number;
  success_rate: string;
}

/* ─── Job Progress Banner ─────────────────────────────────────── */

const JobBanner: React.FC<{ job: Job; label: string }> = ({ job, label }) => {
  const progress = job.progress || {};
  const stage = progress.stage || job.status;
  const message = progress.message || stage;
  const current = progress.current as number | undefined;
  const total = progress.total as number | undefined;
  const pct = current != null && total ? Math.round((current / total) * 100) : undefined;

  return (
    <div className="mb-4 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50">
      <div className="flex items-center gap-3">
        <Spinner />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-blue-800">{label}: {stage}</div>
          {message !== stage && <div className="text-xs text-blue-600 mt-0.5">{message}</div>}
        </div>
        {pct != null && (
          <span className="text-xs font-semibold text-blue-700 tabular-nums">{pct}%</span>
        )}
      </div>
      {pct != null && (
        <div className="mt-2 w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
};

/* ─── Main Component ──────────────────────────────────────────── */

export const ClusterDetail: React.FC<{ clusterId: string }> = ({ clusterId }) => {
  const router = useRouter();
  const [cluster, setCluster] = useState<ClusterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [distillJobId, setDistillJobId] = useState<string | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [deletingSkills, setDeletingSkills] = useState(false);
  const [clusterSkills, setClusterSkills] = useState<ClusterSkill[]>([]);
  const initialLoadDone = useRef(false);

  const fetchCluster = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const [clusterResp, skillsResp] = await Promise.all([
        apiFetch(`/api/clusters/${clusterId}`),
        apiFetch(`/api/clusters/${clusterId}/skills`),
      ]);
      if (clusterResp.ok) setCluster(await clusterResp.json());
      if (skillsResp.ok) setClusterSkills(await skillsResp.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [clusterId]);

  usePolling(fetchCluster, { interval: 60000 });

  // On mount, check for any running distillation job
  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch("/api/jobs?job_type=distillation&limit=5");
        if (resp.ok) {
          const jobs = await resp.json();
          const running = jobs.find((j: any) =>
            (j.status === "pending" || j.status === "running")
          );
          if (running) {
            setDistillJobId(running.id);
            setDistilling(true);
          }
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const { job: distillJob } = useJobPolling(distillJobId, {
    onComplete: () => {
      setDistilling(false);
      setDistillJobId(null);
      fetchCluster(); // Refresh skills list
    },
    onFailed: (err) => {
      setDistilling(false);
      setDistillJobId(null);
      setDistillError(err);
    },
  });

  const handleDistill = async () => {
    setDistillError(null);
    setDistilling(true);
    try {
      const resp = await apiFetch(`/api/clusters/${clusterId}/distill`, { method: "POST" });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Failed" }));
        setDistillError(data.detail || "Failed to start distillation");
        setDistilling(false);
        return;
      }
      const jobData = await resp.json();
      setDistillJobId(jobData.id);
    } catch {
      setDistillError("Network error");
      setDistilling(false);
    }
  };

  const handleDeleteSkills = async () => {
    setDeletingSkills(true);
    setDistillError(null);
    try {
      const resp = await apiFetch(`/api/clusters/${clusterId}/skills`, { method: "DELETE" });
      if (resp.ok) {
        const data = await resp.json();
        setDistillError(null);
        // Brief success feedback — reuse the error slot with a non-error style
        setClusterSkills([]);
      }
    } catch {
      // ignore
    } finally {
      setDeletingSkills(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (!cluster) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={<LayersIcon size={32} className="text-gray-400" />}
          title="Cluster not found"
          description="This cluster does not exist."
          iconSize="lg"
        />
      </div>
    );
  }

  const meta = cluster.metadata || {};

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/clusters")}
            className="p-1 hover:bg-gray-100 rounded-md"
          >
            <ArrowBackIcon size={18} className="text-gray-500" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-black">{cluster.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs px-2 py-0.5 bg-violet-50 text-violet-700 rounded-full font-medium">
                {cluster.task_type}
              </span>
              <span className="text-xs text-gray-400">
                {cluster.member_count} session{cluster.member_count !== 1 ? "s" : ""}
              </span>
              {meta.success_rate && (
                <span className="text-xs text-gray-400">/ Success: {meta.success_rate}</span>
              )}
            </div>
          </div>
          <button
            onClick={handleDeleteSkills}
            disabled={deletingSkills || distilling}
            className="px-3 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {deletingSkills ? "Deleting..." : "Delete Skills"}
          </button>
          <button
            onClick={handleDistill}
            disabled={distilling}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-lg disabled:opacity-50 flex items-center gap-2"
          >
            {distilling ? <Spinner /> : <SparklesIcon size={14} />}
            {distilling ? "Distilling..." : "Distill Skills"}
          </button>
        </div>

        {/* Distillation progress */}
        {distillJob && (distillJob.status === "pending" || distillJob.status === "running") && (
          <JobBanner job={distillJob} label="Distilling" />
        )}
        {distillJob?.status === "completed" && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700">
            Distillation complete: {distillJob.result?.skills_created || 0} skills created from {distillJob.result?.sessions_used || 0} sessions.
            <button onClick={() => router.push("/skills")} className="ml-2 font-medium text-green-800 underline">
              View skills
            </button>
          </div>
        )}
        {distillError && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">{distillError}</div>
        )}

        {/* Metadata */}
        {meta.common_tools && (
          <div className="mb-4">
            <span className="text-xs text-gray-500 font-medium">Common tools: </span>
            {(meta.common_tools as string[]).map((tool, i) => (
              <span key={i} className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded mr-1">
                {tool}
              </span>
            ))}
          </div>
        )}

        {/* Distilled skills */}
        {clusterSkills.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Distilled Skills
              <span className="ml-2 text-gray-400 font-normal">{clusterSkills.length}</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {clusterSkills.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => router.push(`/skills/${skill.id}`)}
                  className="text-left bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-300 hover:shadow-sm transition-all"
                >
                  <div className="text-sm font-medium text-gray-900 mb-1.5">{skill.title}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-700 rounded font-medium">
                      {skill.category}
                    </span>
                    <span className={`text-[11px] font-semibold ${skill.reward_delta >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {skill.reward_delta >= 0 ? "+" : ""}{(skill.reward_delta * 100).toFixed(0)}%
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {skill.evidence_count} sessions
                    </span>
                    {skill.success_rate && (
                      <span className="text-[10px] text-gray-400">{skill.success_rate}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Members table */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">Session</th>
                  <th className="px-4 py-3 font-medium">Summary</th>
                  <th className="px-4 py-3 font-medium w-[100px]">Complexity</th>
                  <th className="px-4 py-3 font-medium w-[140px]">Tools Strategy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cluster.members.map((m) => (
                  <tr
                    key={m.id}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => router.push(`/observability/${m.session_id}?source=postgres`)}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{m.session_id}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 max-w-[400px]">
                      <div className="line-clamp-2">{m.summary || "-"}</div>
                    </td>
                    <td className="px-4 py-3">
                      {m.labels.complexity ? (
                        <span className={`text-xs font-medium ${
                          m.labels.complexity === "high" ? "text-red-600" :
                          m.labels.complexity === "medium" ? "text-amber-600" : "text-green-600"
                        }`}>
                          {m.labels.complexity}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{m.labels.tools_strategy || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
