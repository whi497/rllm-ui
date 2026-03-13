"use client";

import React, { useState, useCallback, useRef } from "react";
import {
  UploadIcon,
  DeleteIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CloseIcon,
  ActivityIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

interface SpanUpload {
  upload_id: string;
  filename: string;
  row_count: number;
  session_count: number;
  created_at: string;
}

interface SpanUploadSession {
  id: string;
  name: string;
  status: string;
  span_count: number;
  created_at: string;
  completed_at: string | null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export const SpanImportPage: React.FC = () => {
  const [uploads, setUploads] = useState<SpanUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  // Inspect state
  const [inspectUploadId, setInspectUploadId] = useState<string | null>(null);
  const [inspectSessions, setInspectSessions] = useState<SpanUploadSession[]>([]);
  const [inspectLoading, setInspectLoading] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  const fetchUploads = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch("/api/span-uploads");
      if (resp.ok) {
        setUploads(await resp.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  usePolling(fetchUploads, { interval: 60000 });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setUploadSuccess(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await apiFetch("/api/span-uploads", {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Upload failed" }));
        setUploadError(data.detail || "Upload failed");
      } else {
        const result: SpanUpload = await resp.json();
        setUploadSuccess(
          `Uploaded "${result.filename}" — ${result.row_count} spans across ${result.session_count} session(s)`
        );
        fetchUploads();
      }
    } catch {
      setUploadError("Network error during upload");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleInspect = async (uploadId: string) => {
    if (inspectUploadId === uploadId) {
      setInspectUploadId(null);
      return;
    }
    setInspectUploadId(uploadId);
    setInspectLoading(true);
    try {
      const resp = await apiFetch(`/api/span-uploads/${encodeURIComponent(uploadId)}/sessions`);
      if (resp.ok) {
        setInspectSessions(await resp.json());
      }
    } catch {
      // ignore
    } finally {
      setInspectLoading(false);
    }
  };

  const handleDelete = async (uploadId: string) => {
    setDeleting(true);
    try {
      const resp = await apiFetch(`/api/span-uploads/${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
      });
      if (resp.ok) {
        setDeleteConfirm(null);
        if (inspectUploadId === uploadId) setInspectUploadId(null);
        fetchUploads();
      }
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
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-semibold text-black">Span Import</h1>
            <span className="px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-100 text-amber-700">
              BETA
            </span>
          </div>
          <p className="text-sm text-gray-500">
            Import agent spans from CSV files. Required columns: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">session_id</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">span_type</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">data</code> (JSON).
            Optional: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">span_id</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">invocation_id</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">agent_name</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">model</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">tool_name</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">duration_ms</code>, etc.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Imported sessions appear as the "imported" data source in Observability and can be used for skill distillation.
          </p>
        </div>

        {/* Upload area */}
        <div className="mb-8">
          <label
            className={`
              flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer
              transition-colors duration-150
              ${uploading ? "border-gray-300 bg-gray-50" : "border-gray-300 hover:border-accent-400 hover:bg-accent-50/30"}
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileUpload}
              disabled={uploading}
            />
            {uploading ? (
              <div className="flex items-center gap-2 text-gray-500">
                <Spinner />
                <span className="text-sm">Uploading & validating...</span>
              </div>
            ) : (
              <>
                <UploadIcon size={24} className="text-gray-400 mb-2" />
                <span className="text-sm text-gray-600">Click to upload a span CSV file</span>
                <span className="text-xs text-gray-400 mt-1">or drag and drop</span>
              </>
            )}
          </label>

          {/* Upload feedback */}
          {uploadError && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm whitespace-pre-wrap">
              <div className="flex items-start gap-2">
                <CloseIcon size={16} className="flex-shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            </div>
          )}
          {uploadSuccess && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-green-50 text-green-700 text-sm">
              {uploadSuccess}
            </div>
          )}
        </div>

        {/* Past uploads */}
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-3">
            Past Uploads
            <span className="ml-2 text-gray-400 font-normal">{uploads.length}</span>
          </h2>

          {uploads.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <EmptyState
                icon={<ActivityIcon size={32} className="text-gray-400" />}
                title="No span uploads yet"
                description="Upload a CSV file with agent spans to get started."
                iconSize="lg"
              />
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
              {uploads.map((upload) => (
                <div key={upload.upload_id}>
                  {/* Upload row */}
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                    <button
                      onClick={() => handleInspect(upload.upload_id)}
                      className="flex-shrink-0 p-0.5 text-gray-400 hover:text-gray-600"
                    >
                      {inspectUploadId === upload.upload_id ? (
                        <ChevronDownIcon size={16} />
                      ) : (
                        <ChevronRightIcon size={16} />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {upload.filename}
                      </div>
                      <div className="text-xs text-gray-400">
                        ID: {upload.upload_id}
                      </div>
                    </div>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {upload.row_count} span{upload.row_count !== 1 ? "s" : ""}
                      {" / "}
                      {upload.session_count} session{upload.session_count !== 1 ? "s" : ""}
                    </span>
                    <span className="text-xs text-gray-400 flex-shrink-0 w-36 text-right">
                      {formatDate(upload.created_at)}
                    </span>
                    <button
                      onClick={() => setDeleteConfirm(upload.upload_id)}
                      className="flex-shrink-0 p-1 text-gray-400 hover:text-red-600 transition-colors rounded"
                      title="Delete upload"
                    >
                      <DeleteIcon size={16} />
                    </button>
                  </div>

                  {/* Inspect panel (expandable) */}
                  {inspectUploadId === upload.upload_id && (
                    <div className="bg-gray-50 border-t border-gray-100 px-4 py-3">
                      {inspectLoading ? (
                        <div className="flex justify-center py-4">
                          <Spinner />
                        </div>
                      ) : inspectSessions.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-2">No sessions</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                                <th className="pb-2 pr-3 font-medium">Session ID</th>
                                <th className="pb-2 pr-3 font-medium">Name</th>
                                <th className="pb-2 pr-3 font-medium">Spans</th>
                                <th className="pb-2 pr-3 font-medium">Status</th>
                                <th className="pb-2 font-medium">Created</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {inspectSessions.map((session) => (
                                <tr key={session.id} className="text-gray-700">
                                  <td className="py-1.5 pr-3 font-mono text-xs max-w-[200px] truncate">
                                    {session.id}
                                  </td>
                                  <td className="py-1.5 pr-3 max-w-[150px] truncate">{session.name}</td>
                                  <td className="py-1.5 pr-3 tabular-nums">{session.span_count}</td>
                                  <td className="py-1.5 pr-3">
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">
                                      {session.status}
                                    </span>
                                  </td>
                                  <td className="py-1.5 text-xs text-gray-400">
                                    {formatDate(session.created_at)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Delete upload?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This will permanently delete this upload, all its sessions, and all span data. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
                className="px-3 py-1.5 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                disabled={deleting}
                className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex items-center gap-1.5"
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
