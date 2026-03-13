"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { apiFetch } from "../config/api";

interface AuthConfig {
  auth_required: boolean;
  oauth_providers: string[];
}

interface User {
  id: string;
  email: string;
  name: string | null;
  api_key: string | null;
  team: string | null;
  is_superuser: boolean;
  impersonating: boolean;
}

interface AuthState {
  config: AuthConfig | null;
  user: User | null;
  isLoading: boolean;
  justRegistered: boolean;
  clearJustRegistered: () => void;
  login: (email: string, password: string) => Promise<string | null>;
  register: (email: string, password: string, name?: string) => Promise<string | null>;
  logout: () => Promise<void>;
  impersonate: (userId: string) => Promise<string | null>;
  stopImpersonating: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  config: null,
  user: null,
  isLoading: true,
  justRegistered: false,
  clearJustRegistered: () => {},
  login: async () => null,
  register: async () => null,
  logout: async () => {},
  impersonate: async () => null,
  stopImpersonating: async () => {},
  refreshUser: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [justRegistered, setJustRegistered] = useState(false);

  const clearJustRegistered = useCallback(() => setJustRegistered(false), []);

  const fetchMe = useCallback(async () => {
    const meRes = await apiFetch("/api/auth/me");
    if (meRes.ok) {
      setUser(await meRes.json());
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const configRes = await apiFetch("/api/auth/config");
        if (configRes.ok) {
          const cfg: AuthConfig = await configRes.json();
          setConfig(cfg);

          if (cfg.auth_required) {
            const meRes = await apiFetch("/api/auth/me");
            if (meRes.ok) {
              setUser(await meRes.json());

              // Check for OAuth welcome redirect (new user)
              const params = new URLSearchParams(window.location.search);
              if (params.get("welcome") === "1") {
                setJustRegistered(true);
                // Clean up the URL
                params.delete("welcome");
                const cleanUrl = params.toString()
                  ? `${window.location.pathname}?${params.toString()}`
                  : window.location.pathname;
                window.history.replaceState({}, "", cleanUrl);
              }
            }
          }
        }
      } catch {
        // If config endpoint doesn't exist, assume local mode
        setConfig({ auth_required: false, oauth_providers: [] });
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
        return null;
      }
      const err = await res.json().catch(() => ({}));
      return err.detail || `Login failed (${res.status})`;
    } catch {
      return "Network error";
    }
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string): Promise<string | null> => {
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: name || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
        setJustRegistered(true);
        return null;
      }
      const err = await res.json().catch(() => ({}));
      return err.detail || `Registration failed (${res.status})`;
    } catch {
      return "Network error";
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const impersonate = useCallback(async (userId: string): Promise<string | null> => {
    try {
      const res = await apiFetch(`/api/admin/impersonate/${userId}`, { method: "POST" });
      if (res.ok) {
        await fetchMe();
        return null;
      }
      const err = await res.json().catch(() => ({}));
      return err.detail || "Impersonation failed";
    } catch {
      return "Network error";
    }
  }, [fetchMe]);

  const stopImpersonating = useCallback(async () => {
    try {
      await apiFetch("/api/admin/stop-impersonate", { method: "POST" });
      await fetchMe();
    } catch {
      // ignore
    }
  }, [fetchMe]);

  return (
    <AuthContext.Provider
      value={{
        config,
        user,
        isLoading,
        justRegistered,
        clearJustRegistered,
        login,
        register,
        logout,
        impersonate,
        stopImpersonating,
        refreshUser: fetchMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
