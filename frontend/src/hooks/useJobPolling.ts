"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../config/api";

export interface Job {
  id: string;
  job_type: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: Record<string, any>;
  result: Record<string, any> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface UseJobPollingOptions {
  onComplete?: (result: Record<string, any> | null) => void;
  onFailed?: (error: string) => void;
  interval?: number;
}

/**
 * Polls a background job until it reaches a terminal state.
 * Returns the current job state for progress rendering.
 */
export function useJobPolling(
  jobId: string | null,
  options: UseJobPollingOptions = {}
): { job: Job | null; loading: boolean } {
  const { onComplete, onFailed, interval = 2000 } = options;
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const callbacksRef = useRef({ onComplete, onFailed });
  callbacksRef.current = { onComplete, onFailed };
  const terminalRef = useRef(false);

  const fetchJob = useCallback(async (id: string) => {
    try {
      const resp = await apiFetch(`/api/jobs/${id}`);
      if (resp.ok) {
        const data: Job = await resp.json();
        setJob(data);
        if (data.status === "completed") {
          terminalRef.current = true;
          callbacksRef.current.onComplete?.(data.result);
        } else if (data.status === "failed") {
          terminalRef.current = true;
          callbacksRef.current.onFailed?.(data.error || "Job failed");
        }
      }
    } catch {
      // ignore transient errors
    }
  }, []);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setLoading(false);
      terminalRef.current = false;
      return;
    }

    terminalRef.current = false;
    setLoading(true);
    fetchJob(jobId);

    const timer = setInterval(() => {
      if (terminalRef.current) {
        setLoading(false);
        clearInterval(timer);
        return;
      }
      fetchJob(jobId);
    }, interval);

    return () => clearInterval(timer);
  }, [jobId, interval, fetchJob]);

  return { job, loading };
}
