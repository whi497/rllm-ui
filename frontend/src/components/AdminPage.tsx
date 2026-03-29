"use client";

import React, { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "./icons";
import { Spinner } from "./ui";
import { apiFetch } from "../config/api";
import { usePolling } from "../hooks/usePolling";
import { useAuth } from "../contexts/AuthContext";

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  team: string | null;
  is_superuser: boolean;
  oauth_provider: string | null;
  created_at: string;
}

// Team badge color mapping
const TEAM_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  DoorDash: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
};

const defaultTeamColor = { bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400" };

const TeamBadge: React.FC<{ team: string }> = ({ team }) => {
  const c = TEAM_COLORS[team] ?? defaultTeamColor;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {team}
    </span>
  );
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const AdminPage: React.FC = () => {
  const router = useRouter();
  const { user: currentUser, impersonate } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  const fetchUsers = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const resp = await apiFetch("/api/admin/users");
      if (!resp.ok) {
        if (resp.status === 403 || resp.status === 401) {
          router.push("/");
          return;
        }
        throw new Error("Failed to fetch users");
      }
      const data: AdminUser[] = await resp.json();
      setUsers(data);
    } catch {
      if (!initialLoadDone.current) setUsers([]);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [router]);

  usePolling(fetchUsers, { interval: 60000 });

  const handleImpersonate = async (userId: string) => {
    setImpersonating(userId);
    const err = await impersonate(userId);
    if (err) {
      setImpersonating(null);
      alert(err);
    } else {
      router.push("/");
    }
  };

  // Guard: only superusers can see this page
  if (!currentUser?.is_superuser) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400">
        Access denied
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  const filtered = searchQuery
    ? users.filter((u) => {
        const q = searchQuery.toLowerCase();
        return (
          u.email.toLowerCase().includes(q) ||
          (u.name?.toLowerCase().includes(q) ?? false) ||
          (u.team?.toLowerCase().includes(q) ?? false)
        );
      })
    : users;

  const teamCounts = users.reduce<Record<string, number>>((acc, u) => {
    const t = u.team || "No team";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="w-full">
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-black">Admin</h1>
          <p className="text-sm text-gray-500 mt-1">Manage users and impersonate accounts</p>
        </div>

        {/* Team summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Users</div>
            <div className="text-2xl font-semibold text-gray-900 mt-1">{users.length}</div>
          </div>
          {Object.entries(teamCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([team, count]) => (
              <div key={team} className="bg-white border border-gray-200 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">{team}</div>
                <div className="text-2xl font-semibold text-gray-900 mt-1">{count}</div>
              </div>
            ))}
        </div>

        {/* Search */}
        <div className="mb-4">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <SearchIcon size={18} className="text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 transition-all duration-200"
            />
          </div>
        </div>

        {/* Users table */}
        <div className="bg-white border border-gray-200 overflow-hidden rounded-lg">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Team</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Auth</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Joined</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full bg-accent-100 text-accent-700 flex items-center justify-center text-xs font-medium flex-shrink-0">
                        {(u.name || u.email)[0].toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {u.name || u.email.split("@")[0]}
                          {u.is_superuser && (
                            <span className="ml-1.5 text-[10px] font-medium text-violet-600 bg-violet-50 px-1 py-0.5 rounded">
                              Admin
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 truncate">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.team ? <TeamBadge team={u.team} /> : <span className="text-xs text-gray-300">-</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-500 capitalize">{u.oauth_provider || "email"}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">{formatDate(u.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {u.id !== currentUser?.id && (
                      <button
                        onClick={() => handleImpersonate(u.id)}
                        disabled={impersonating === u.id}
                        className="text-xs font-medium text-accent-600 hover:text-accent-800 disabled:opacity-50 transition-colors"
                      >
                        {impersonating === u.id ? "Switching..." : "Login as"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
