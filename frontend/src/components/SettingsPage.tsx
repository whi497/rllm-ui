"use client";

import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../config/api";
import { useAuth } from "../contexts/AuthContext";
import { WelcomeModal } from "./auth/WelcomeModal";
import { ConfirmDialog } from "./ConfirmDialog";
type Section = "account" | "api-key" | "agent" | "bigquery";

const NAV_ITEMS: { id: Section; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "api-key", label: "API Key" },
  { id: "agent", label: "Agent" },
  { id: "bigquery", label: "BigQuery" },
];

export const SettingsPage: React.FC = () => {
  const { config, user } = useAuth();
  const [activeSection, setActiveSection] = useState<Section>("account");

  if (!config?.auth_required || !user) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Settings are only available in cloud mode.
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left nav */}
      <div className="w-[200px] flex-shrink-0 bg-white border-r border-gray-200 py-4 px-2">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`
                w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg
                transition-colors duration-150
                ${
                  activeSection === item.id
                    ? "bg-accent-50 text-accent-700"
                    : "text-gray-600 hover:bg-layer-1 hover:text-gray-900"
                }
              `}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8">
          {activeSection === "account" && <AccountSection />}
          {activeSection === "api-key" && <ApiKeySection />}
          {activeSection === "agent" && <AnthropicKeySection />}
          {activeSection === "bigquery" && <BigQuerySection />}
        </div>
      </div>
    </div>
  );
};

/* ─── Account Section ────────────────────────────────────────────── */

const AccountSection: React.FC = () => {
  const { user, logout } = useAuth();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  if (!user) return null;

  const handleDeleteAccount = async () => {
    try {
      const res = await apiFetch("/api/auth/delete-account", {
        method: "POST",
      });
      if (res.ok) {
        setDeleteConfirmOpen(false);
        logout();
      }
    } catch {
      // silently ignore
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Account</h2>

      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-accent-100 text-accent-700 flex items-center justify-center text-sm font-medium flex-shrink-0">
            {(user.name || user.email)[0].toUpperCase()}
          </span>
          <div>
            {user.name && (
              <p className="text-sm font-medium text-gray-900">{user.name}</p>
            )}
            <p className="text-sm text-gray-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => logout()}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign out
        </button>
        <button
          onClick={() => setDeleteConfirmOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete account
        </button>
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete account?"
        message="This will permanently delete your account and all your projects, experiments, and data. This cannot be undone."
        confirmLabel="Delete account"
        onConfirm={handleDeleteAccount}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </section>
  );
};

/* ─── rllm API Key Section ────────────────────────────────────────── */

const ApiKeySection: React.FC = () => {
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRegenerate = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/api-key/regenerate", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setNewApiKey(data.api_key);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">rllm API Key</h2>
      <p className="text-sm text-gray-500 mb-4">
        Use this key to send training data from your rLLM training run to the UI.
      </p>
      <button
        onClick={handleRegenerate}
        disabled={loading}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        {loading ? "Regenerating..." : "Regenerate API key"}
      </button>

      {newApiKey && (
        <WelcomeModal
          open={true}
          onClose={() => setNewApiKey(null)}
          apiKey={newApiKey}
          title="New API Key"
          subtitle="Your previous key has been revoked."
          buttonLabel="Done"
        />
      )}
    </section>
  );
};

/* ─── Anthropic API Key Section ───────────────────────────────────── */

const AnthropicKeySection: React.FC = () => {
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "removed" | "error">("idle");
  const [fetching, setFetching] = useState(true);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await apiFetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setMaskedKey(data.anthropic_api_key || null);
      }
    } catch {
      // ignore
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async () => {
    if (!inputValue.trim()) return;
    setLoading(true);
    setStatus("idle");
    try {
      const res = await apiFetch("/api/settings/anthropic_api_key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: inputValue.trim() }),
      });
      if (res.ok) {
        setStatus("saved");
        setInputValue("");
        await fetchSettings();
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    setLoading(true);
    setStatus("idle");
    try {
      const res = await apiFetch("/api/settings/anthropic_api_key", {
        method: "DELETE",
      });
      if (res.ok) {
        setMaskedKey(null);
        setStatus("removed");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Anthropic API Key</h2>
      <p className="text-sm text-gray-500 mb-4">
        Required for the AI chat assistant. Your key is encrypted at rest and never shared.
      </p>

      {fetching ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : (
        <>
          {maskedKey && (
            <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex-1">
                <span className="text-sm font-mono text-gray-600">{maskedKey}</span>
              </div>
              <button
                onClick={handleRemove}
                disabled={loading}
                className="text-sm text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              type="password"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setStatus("idle");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              placeholder={maskedKey ? "Enter new key to replace..." : "sk-ant-..."}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent placeholder-gray-400"
            />
            <button
              onClick={handleSave}
              disabled={loading || !inputValue.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-accent-600 rounded-lg hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Saving..." : maskedKey ? "Update" : "Save"}
            </button>
          </div>

          {status === "saved" && (
            <p className="mt-2 text-sm text-green-600">API key saved successfully.</p>
          )}
          {status === "removed" && (
            <p className="mt-2 text-sm text-gray-500">API key removed.</p>
          )}
          {status === "error" && (
            <p className="mt-2 text-sm text-red-600">Something went wrong. Please try again.</p>
          )}
        </>
      )}
    </section>
  );
};

/* ─── BigQuery Configuration Section ─────────────────────────────── */

const BigQuerySection: React.FC = () => {
  const [project, setProject] = useState("");
  const [dataset, setDataset] = useState("");
  const [table, setTable] = useState("");
  const [savedProject, setSavedProject] = useState<string | null>(null);
  const [savedDataset, setSavedDataset] = useState<string | null>(null);
  const [savedTable, setSavedTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "removed" | "error">("idle");
  const [fetching, setFetching] = useState(true);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await apiFetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setSavedProject(data.bq_project || null);
        setSavedDataset(data.bq_dataset || null);
        setSavedTable(data.bq_table || null);
      }
    } catch {
      // ignore
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async () => {
    if (!project.trim()) return;
    setLoading(true);
    setStatus("idle");
    try {
      const projectRes = await apiFetch("/api/settings/bq_project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: project.trim() }),
      });
      if (!projectRes.ok) {
        setStatus("error");
        return;
      }
      if (dataset.trim()) {
        const datasetRes = await apiFetch("/api/settings/bq_dataset", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: dataset.trim() }),
        });
        if (!datasetRes.ok) {
          setStatus("error");
          return;
        }
      }
      if (table.trim()) {
        const tableRes = await apiFetch("/api/settings/bq_table", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: table.trim() }),
        });
        if (!tableRes.ok) {
          setStatus("error");
          return;
        }
      }
      setStatus("saved");
      setProject("");
      setDataset("");
      setTable("");
      await fetchSettings();
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    setLoading(true);
    setStatus("idle");
    try {
      await apiFetch("/api/settings/bq_project", { method: "DELETE" });
      await apiFetch("/api/settings/bq_dataset", { method: "DELETE" });
      await apiFetch("/api/settings/bq_table", { method: "DELETE" });
      setSavedProject(null);
      setSavedDataset(null);
      setSavedTable(null);
      setStatus("removed");
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">BigQuery</h2>
      <p className="text-sm text-gray-500 mb-4">
        Configure your GCP project and dataset to read agent traces from BigQuery.
      </p>

      {fetching ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : (
        <>
          {savedProject && (
            <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex-1">
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Project:</span>{" "}
                  <span className="font-mono">{savedProject}</span>
                </p>
                {savedDataset && (
                  <p className="text-sm text-gray-600 mt-1">
                    <span className="font-medium">Dataset:</span>{" "}
                    <span className="font-mono">{savedDataset}</span>
                  </p>
                )}
                {savedTable && (
                  <p className="text-sm text-gray-600 mt-1">
                    <span className="font-medium">Table:</span>{" "}
                    <span className="font-mono">{savedTable}</span>
                  </p>
                )}
              </div>
              <button
                onClick={handleRemove}
                disabled={loading}
                className="text-sm text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                GCP Project
              </label>
              <input
                type="text"
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setStatus("idle");
                }}
                placeholder={savedProject ? "Enter new project to replace..." : "my-gcp-project"}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent placeholder-gray-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Dataset
              </label>
              <input
                type="text"
                value={dataset}
                onChange={(e) => {
                  setDataset(e.target.value);
                  setStatus("idle");
                }}
                placeholder={savedDataset || "agent_traces"}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent placeholder-gray-400"
              />
              <p className="mt-1 text-xs text-gray-400">
                Defaults to &quot;agent_traces&quot; if left blank.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Table
              </label>
              <input
                type="text"
                value={table}
                onChange={(e) => {
                  setTable(e.target.value);
                  setStatus("idle");
                }}
                placeholder={savedTable || "rllm_traces"}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent placeholder-gray-400"
              />
              <p className="mt-1 text-xs text-gray-400">
                Defaults to &quot;rllm_traces&quot; if left blank.
              </p>
            </div>
            <button
              onClick={handleSave}
              disabled={loading || !project.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-accent-600 rounded-lg hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Saving..." : savedProject ? "Update" : "Save"}
            </button>
          </div>

          {status === "saved" && (
            <p className="mt-2 text-sm text-green-600">
              BigQuery configuration saved. Select &quot;BigQuery&quot; as your data source in the Observability page.
            </p>
          )}
          {status === "removed" && (
            <p className="mt-2 text-sm text-gray-500">BigQuery configuration removed.</p>
          )}
          {status === "error" && (
            <p className="mt-2 text-sm text-red-600">Something went wrong. Please try again.</p>
          )}
        </>
      )}
    </section>
  );
};
