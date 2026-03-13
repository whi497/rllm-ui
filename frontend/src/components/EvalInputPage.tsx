"use client";

import React, { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  UploadIcon,
  DeleteIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CloseIcon,
  ListIcon,
  SearchIcon,
} from "./icons";
import { Spinner, EmptyState } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";

interface EvalUpload {
  upload_id: string;
  filename: string;
  row_count: number;
  created_at: string;
}

interface EvalUploadRow {
  id: number;
  upload_id: string;
  session_id: string;
  ground_truth: string;
  tags: string;
  created_at: string;
}

interface ExplorerSessionInfo {
  name: string;
  status: string;
  agent_name: string | null;
  span_count: number;
  llm_calls: number;
  tool_calls: number;
  created_at: string | null;
}

interface ExplorerRow {
  id: number;
  upload_id: string;
  session_id: string;
  ground_truth: string;
  tags: string;
  created_at: string;
  session: ExplorerSessionInfo | null;
}

type ViewMode = "upload" | "explorer";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

/* ─── Expandable text cell ──────────────────────────────────────── */

const TRUNCATE_LEN = 120;

const ExpandableText: React.FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > TRUNCATE_LEN;

  if (!needsTruncation) {
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }

  return (
    <span className="whitespace-pre-wrap break-words">
      {expanded ? text : text.slice(0, TRUNCATE_LEN) + "..."}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="ml-1 text-accent-600 hover:text-accent-700 text-xs font-medium"
      >
        {expanded ? "show less" : "show all"}
      </button>
    </span>
  );
};

/* ─── Main page component ──────────────────────────────────────── */

export const EvalInputPage: React.FC = () => {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("upload");
  const [uploads, setUploads] = useState<EvalUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  // Inspect state
  const [inspectUploadId, setInspectUploadId] = useState<string | null>(null);
  const [inspectRows, setInspectRows] = useState<EvalUploadRow[]>([]);
  const [inspectLoading, setInspectLoading] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Explorer state
  const [explorerRows, setExplorerRows] = useState<ExplorerRow[]>([]);
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [explorerLoaded, setExplorerLoaded] = useState(false);
  const [explorerSearch, setExplorerSearch] = useState("");
  const [explorerUploadFilter, setExplorerUploadFilter] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  const fetchUploads = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch("/api/eval-uploads");
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

  const fetchExplorer = useCallback(async () => {
    setExplorerLoading(true);
    try {
      const params = explorerUploadFilter
        ? `?upload_id=${encodeURIComponent(explorerUploadFilter)}`
        : "";
      const resp = await apiFetch(`/api/eval-uploads/explorer${params}`);
      if (resp.ok) {
        setExplorerRows(await resp.json());
      }
    } catch {
      // ignore
    } finally {
      setExplorerLoading(false);
      setExplorerLoaded(true);
    }
  }, [explorerUploadFilter]);

  // Load explorer data when switching to explorer view
  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === "explorer" && !explorerLoaded) {
      fetchExplorer();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setUploadSuccess(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await apiFetch("/api/eval-uploads", {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Upload failed" }));
        setUploadError(data.detail || "Upload failed");
      } else {
        const result: EvalUpload = await resp.json();
        setUploadSuccess(`Uploaded "${result.filename}" with ${result.row_count} rows`);
        fetchUploads();
        // Invalidate explorer cache
        setExplorerLoaded(false);
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
      const resp = await apiFetch(`/api/eval-uploads/${encodeURIComponent(uploadId)}/rows`);
      if (resp.ok) {
        setInspectRows(await resp.json());
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
      const resp = await apiFetch(`/api/eval-uploads/${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
      });
      if (resp.ok) {
        setDeleteConfirm(null);
        if (inspectUploadId === uploadId) setInspectUploadId(null);
        fetchUploads();
        setExplorerLoaded(false);
      }
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  };

  // Filter explorer rows
  const filteredExplorerRows = explorerSearch
    ? explorerRows.filter((r) => {
        const q = explorerSearch.toLowerCase();
        return (
          r.session_id.toLowerCase().includes(q) ||
          r.ground_truth.toLowerCase().includes(q) ||
          (r.tags || "").toLowerCase().includes(q) ||
          (r.session?.agent_name || "").toLowerCase().includes(q) ||
          (r.session?.name || "").toLowerCase().includes(q)
        );
      })
    : explorerRows;

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
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-black">Eval Import</h1>
            <span className="px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-100 text-amber-700">
              BETA
            </span>
          </div>
          {/* View toggle */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => handleViewChange("upload")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === "upload"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <UploadIcon size={13} />
              Upload
            </button>
            <button
              onClick={() => handleViewChange("explorer")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === "explorer"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <ListIcon size={13} />
              Explorer
            </button>
          </div>
        </div>

        {viewMode === "upload" ? (
          <UploadView
            uploads={uploads}
            uploading={uploading}
            uploadError={uploadError}
            uploadSuccess={uploadSuccess}
            inspectUploadId={inspectUploadId}
            inspectRows={inspectRows}
            inspectLoading={inspectLoading}
            deleting={deleting}
            deleteConfirm={deleteConfirm}
            fileInputRef={fileInputRef}
            onFileUpload={handleFileUpload}
            onInspect={handleInspect}
            onDeleteRequest={setDeleteConfirm}
            onDeleteConfirm={handleDelete}
            onDeleteCancel={() => setDeleteConfirm(null)}
          />
        ) : (
          <ExplorerView
            rows={filteredExplorerRows}
            loading={explorerLoading}
            search={explorerSearch}
            onSearchChange={setExplorerSearch}
            uploads={uploads}
            uploadFilter={explorerUploadFilter}
            onUploadFilterChange={(v) => {
              setExplorerUploadFilter(v);
              setExplorerLoaded(false);
              // Trigger fetch after state update
              setTimeout(() => fetchExplorer(), 0);
            }}
            onRefresh={fetchExplorer}
            onRowClick={(sessionId) => router.push(`/eval-input/${sessionId}`)}
          />
        )}
      </div>
    </div>
  );
};

/* ─── Upload view ──────────────────────────────────────────────── */

const UploadView: React.FC<{
  uploads: EvalUpload[];
  uploading: boolean;
  uploadError: string | null;
  uploadSuccess: string | null;
  inspectUploadId: string | null;
  inspectRows: EvalUploadRow[];
  inspectLoading: boolean;
  deleting: boolean;
  deleteConfirm: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInspect: (uploadId: string) => void;
  onDeleteRequest: (uploadId: string) => void;
  onDeleteConfirm: (uploadId: string) => void;
  onDeleteCancel: () => void;
}> = ({
  uploads, uploading, uploadError, uploadSuccess,
  inspectUploadId, inspectRows, inspectLoading,
  deleting, deleteConfirm, fileInputRef,
  onFileUpload, onInspect, onDeleteRequest, onDeleteConfirm, onDeleteCancel,
}) => (
  <div className="max-w-5xl">
    <p className="text-sm text-gray-500 mb-6">
      Import evaluation results from CSV files. Required columns: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">session_id</code>, <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">ground_truth</code>. Optional: <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">tags</code>. Session IDs are validated against available data sources.
    </p>

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
          onChange={onFileUpload}
          disabled={uploading}
        />
        {uploading ? (
          <div className="flex items-center gap-2 text-gray-500">
            <Spinner />
            <span className="text-sm">Uploading...</span>
          </div>
        ) : (
          <>
            <UploadIcon size={24} className="text-gray-400 mb-2" />
            <span className="text-sm text-gray-600">Click to upload a CSV file</span>
            <span className="text-xs text-gray-400 mt-1">or drag and drop</span>
          </>
        )}
      </label>

      {uploadError && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm">
          <CloseIcon size={16} className="flex-shrink-0" />
          {uploadError}
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
            icon={<UploadIcon size={32} className="text-gray-400" />}
            title="No uploads yet"
            description="Upload a CSV file to get started."
            iconSize="lg"
          />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
          {uploads.map((upload) => (
            <div key={upload.upload_id}>
              <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                <button
                  onClick={() => onInspect(upload.upload_id)}
                  className="flex-shrink-0 p-0.5 text-gray-400 hover:text-gray-600"
                >
                  {inspectUploadId === upload.upload_id ? (
                    <ChevronDownIcon size={16} />
                  ) : (
                    <ChevronRightIcon size={16} />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{upload.filename}</div>
                  <div className="text-xs text-gray-400">ID: {upload.upload_id}</div>
                </div>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {upload.row_count} row{upload.row_count !== 1 ? "s" : ""}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 w-36 text-right">
                  {formatDate(upload.created_at)}
                </span>
                <button
                  onClick={() => onDeleteRequest(upload.upload_id)}
                  className="flex-shrink-0 p-1 text-gray-400 hover:text-red-600 transition-colors rounded"
                  title="Delete upload"
                >
                  <DeleteIcon size={16} />
                </button>
              </div>

              {inspectUploadId === upload.upload_id && (
                <div className="bg-gray-50 border-t border-gray-100 px-4 py-3">
                  {inspectLoading ? (
                    <div className="flex justify-center py-4"><Spinner /></div>
                  ) : inspectRows.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-2">No rows</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                            <th className="pb-2 pr-3 font-medium">#</th>
                            <th className="pb-2 pr-3 font-medium">session_id</th>
                            <th className="pb-2 pr-3 font-medium">ground_truth</th>
                            <th className="pb-2 font-medium">tags</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {inspectRows.map((row, idx) => (
                            <tr key={row.id} className="text-gray-700">
                              <td className="py-1.5 pr-3 text-gray-400 tabular-nums">{idx + 1}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs max-w-[200px] truncate">{row.session_id}</td>
                              <td className="py-1.5 pr-3 max-w-[300px] truncate">{row.ground_truth}</td>
                              <td className="py-1.5 max-w-[150px] truncate">{row.tags}</td>
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

    {/* Delete confirmation dialog */}
    {deleteConfirm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
          <h3 className="text-base font-semibold text-gray-900 mb-2">Delete upload?</h3>
          <p className="text-sm text-gray-600 mb-4">
            This will permanently delete this upload and all its rows. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={onDeleteCancel}
              disabled={deleting}
              className="px-3 py-1.5 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onDeleteConfirm(deleteConfirm)}
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

/* ─── Explorer view ────────────────────────────────────────────── */

const ExplorerView: React.FC<{
  rows: ExplorerRow[];
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  uploads: EvalUpload[];
  uploadFilter: string;
  onUploadFilterChange: (v: string) => void;
  onRefresh: () => void;
  onRowClick: (sessionId: string) => void;
}> = ({ rows, loading, search, onSearchChange, uploads, uploadFilter, onUploadFilterChange, onRefresh, onRowClick }) => {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {/* Filters row */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <SearchIcon size={16} className="text-gray-400" />
          </div>
          <input
            type="text"
            placeholder="Search session, ground truth, tags..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400"
          />
        </div>
        <select
          value={uploadFilter}
          onChange={(e) => onUploadFilterChange(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400 bg-white"
        >
          <option value="">All uploads</option>
          {uploads.map((u) => (
            <option key={u.upload_id} value={u.upload_id}>
              {u.filename} ({u.row_count} rows)
            </option>
          ))}
        </select>
        <button
          onClick={onRefresh}
          className="text-sm text-gray-500 hover:text-gray-700 px-2 py-2"
          title="Refresh"
        >
          Refresh
        </button>
      </div>

      {/* Summary */}
      <p className="text-sm text-gray-600 mb-3">
        <span className="font-medium text-black">{rows.length}</span> eval result{rows.length !== 1 ? "s" : ""}
      </p>

      {rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <EmptyState
            icon={<ListIcon size={32} className="text-gray-400" />}
            title="No eval results"
            description="Upload eval results in the Upload tab to explore them here."
            iconSize="lg"
          />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium w-[160px]">Session</th>
                  <th className="px-4 py-3 font-medium w-[100px]">Agent</th>
                  <th className="px-4 py-3 font-medium w-[80px]">Spans</th>
                  <th className="px-4 py-3 font-medium">Ground Truth</th>
                  <th className="px-4 py-3 font-medium w-[120px]">Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <ExplorerTableRow key={row.id} row={row} onClick={() => onRowClick(row.session_id)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

/* ─── Explorer table row ───────────────────────────────────────── */

const ExplorerTableRow: React.FC<{ row: ExplorerRow; onClick: () => void }> = ({ row, onClick }) => {
  const sess = row.session;

  return (
    <tr className="align-top hover:bg-gray-50 transition-colors cursor-pointer" onClick={onClick}>
      {/* Session ID */}
      <td className="px-4 py-3">
        <div className="font-mono text-xs text-gray-800 break-all">{row.session_id}</div>
        {sess && (
          <div className="text-[11px] text-gray-400 mt-0.5">{sess.name}</div>
        )}
      </td>

      {/* Agent */}
      <td className="px-4 py-3">
        {sess?.agent_name ? (
          <span className="text-xs text-gray-700">{sess.agent_name}</span>
        ) : (
          <span className="text-xs text-gray-300">-</span>
        )}
      </td>

      {/* Span stats */}
      <td className="px-4 py-3">
        {sess ? (
          <div className="text-xs space-y-0.5">
            <div className="text-gray-700 tabular-nums">{sess.span_count} total</div>
            <div className="text-gray-400 tabular-nums">
              {sess.llm_calls} LLM / {sess.tool_calls} tool
            </div>
          </div>
        ) : (
          <span className="text-xs text-gray-300">-</span>
        )}
      </td>

      {/* Ground truth */}
      <td className="px-4 py-3 text-sm text-gray-800 min-w-[200px]">
        <ExpandableText text={row.ground_truth} />
      </td>

      {/* Tags */}
      <td className="px-4 py-3">
        {row.tags ? (
          <div className="flex flex-wrap gap-1">
            {row.tags.split(";").map((tag, i) => (
              <span
                key={i}
                className="inline-block px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-600 rounded"
              >
                {tag.trim()}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-gray-300">-</span>
        )}
      </td>
    </tr>
  );
};
