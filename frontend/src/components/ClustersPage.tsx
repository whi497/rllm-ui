"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LayersIcon, DeleteIcon, SparklesIcon } from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";
import { useJobPolling, Job } from "../hooks/useJobPolling";

interface Cluster {
  id: string;
  name: string;
  task_type: string;
  description: string;
  member_count: number;
  metadata: Record<string, any>;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

/* ─── Job Progress Banner ─────────────────────────────────────── */

const JobBanner: React.FC<{ job: Job }> = ({ job }) => {
  const progress = job.progress || {};
  const stage = progress.stage || job.status;
  const current = progress.current as number | undefined;
  const total = progress.total as number | undefined;
  const message = progress.message || "";

  const pct = current && total ? Math.round((current / total) * 100) : undefined;

  return (
    <div className="mb-4 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50">
      <div className="flex items-center gap-3">
        <Spinner />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-blue-800">
            {job.job_type === "clustering" ? "Clustering" : "Distilling"}: {stage}
          </div>
          {message && <div className="text-xs text-blue-600 mt-0.5">{message}</div>}
        </div>
        {pct !== undefined && (
          <span className="text-xs font-semibold text-blue-700 tabular-nums">{pct}%</span>
        )}
      </div>
      {pct !== undefined && (
        <div className="mt-2 w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
};

/* ─── Main Component ──────────────────────────────────────────── */

export const ClustersPage: React.FC = () => {
  const router = useRouter();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const initialLoadDone = useRef(false);

  const fetchClusters = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch("/api/clusters");
      if (resp.ok) setClusters(await resp.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  usePolling(fetchClusters, { interval: 30000 });

  // On mount, check for any running clustering job
  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch("/api/jobs?job_type=clustering&limit=1");
        if (resp.ok) {
          const jobs = await resp.json();
          const running = jobs.find((j: any) => j.status === "pending" || j.status === "running");
          if (running) {
            setActiveJobId(running.id);
            setGenerating(true);
          }
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const { job } = useJobPolling(activeJobId, {
    onComplete: () => {
      setGenerating(false);
      setActiveJobId(null);
      fetchClusters();
    },
    onFailed: (err) => {
      setGenerating(false);
      setActiveJobId(null);
      setError(err);
    },
  });

  const handleGenerate = async () => {
    setError(null);
    setGenerating(true);
    try {
      const resp = await apiFetch("/api/clusters/generate", { method: "POST" });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Failed" }));
        setError(data.detail || "Failed to start clustering");
        setGenerating(false);
        return;
      }
      const jobData = await resp.json();
      setActiveJobId(jobData.id);
    } catch {
      setError("Network error");
      setGenerating(false);
    }
  };

  const handleDeleteAll = async () => {
    setDeleting(true);
    try {
      // Delete clusters
      await apiFetch("/api/clusters", { method: "DELETE" });
      setClusters([]);
      // Clean up completed/failed clustering jobs
      const jobsResp = await apiFetch("/api/jobs?job_type=clustering&limit=50");
      if (jobsResp.ok) {
        const jobs = await jobsResp.json();
        for (const j of jobs) {
          if (j.status === "completed" || j.status === "failed") {
            await apiFetch(`/api/jobs/${j.id}`, { method: "DELETE" });
          }
        }
      }
      setActiveJobId(null);
      setGenerating(false);
      setDeleteConfirm(false);
    } catch {
      // ignore
    } finally {
      setDeleting(false);
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
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold text-black">Session Clusters</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDeleteConfirm(true)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Reset All
              </button>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              {generating && <Spinner />}
              {generating ? "Generating..." : "Generate Clusters"}
            </button>
          </div>
        </div>

        {/* Active job progress */}
        {job && (job.status === "pending" || job.status === "running") && <JobBanner job={job} />}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Content */}
        {clusters.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <EmptyState
              icon={<LayersIcon size={32} className="text-gray-400" />}
              title="No clusters yet"
              description="Generate clusters to group sessions by task type using LLM labeling."
              iconSize="lg"
            />
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-4">
              <span className="font-medium text-black">{clusters.length}</span> cluster{clusters.length !== 1 ? "s" : ""}
              {" / "}
              <span className="font-medium text-black">{clusters.reduce((sum, c) => sum + c.member_count, 0)}</span> sessions
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {clusters.map((cluster) => (
                <button
                  key={cluster.id}
                  onClick={() => router.push(`/clusters/${cluster.id}`)}
                  className="bg-white border border-gray-200 rounded-xl p-5 text-left hover:shadow-sm hover:border-gray-300 transition-all"
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-900 line-clamp-2">{cluster.name}</h3>
                    <span className="flex-shrink-0 ml-2 px-2 py-0.5 text-[11px] font-medium bg-violet-50 text-violet-700 rounded-full">
                      {cluster.member_count}
                    </span>
                  </div>

                  {cluster.metadata?.success_rate && (
                    <div className="text-xs text-gray-500 mb-2">
                      Success: {cluster.metadata.success_rate}
                    </div>
                  )}

                  {cluster.metadata?.common_tools && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {(cluster.metadata.common_tools as string[]).slice(0, 3).map((tool, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="text-[11px] text-gray-400 mt-2">
                    {formatDate(cluster.created_at)}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Reset all clusters?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This will remove all clusters, member assignments, and clean up finished clustering jobs. Sessions are not affected. You can re-generate clusters afterwards.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(false)}
                disabled={deleting}
                className="px-3 py-1.5 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={deleting}
                className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-1.5"
              >
                {deleting && <Spinner />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
