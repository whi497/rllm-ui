"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { apiFetch } from "../config/api";

interface AuthConfig {
  auth_required: boolean;
  deployment_mode: string;
  oauth_providers: string[];
  local_dev_login: boolean;
}

interface User {
  id: string;
  email: string;
  name: string | null;
  team: string | null;
  is_superuser: boolean;
  impersonating: boolean;
}

interface AuthState {
  config: AuthConfig | null;
  user: User | null;
  isLoading: boolean;
  justRegistered: boolean;
  oneTimeApiKey: string | null;
  clearJustRegistered: () => void;
  login: (email: string, password: string) => Promise<string | null>;
  register: (email: string, password: string, name?: string) => Promise<string | null>;
  localDevLogin: () => Promise<string | null>;
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
  oneTimeApiKey: null,
  clearJustRegistered: () => {},
  login: async () => null,
  register: async () => null,
  localDevLogin: async () => null,
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
  const [oneTimeApiKey, setOneTimeApiKey] = useState<string | null>(null);

  const clearJustRegistered = useCallback(() => {
    setJustRegistered(false);
    setOneTimeApiKey(null);
  }, []);

  const fetchMe = useCallback(async () => {
    const meRes = await apiFetch("/api/auth/me");
    if (meRes.ok) {
      setUser(await meRes.json());
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      let cfg: AuthConfig = { auth_required: true, deployment_mode: "local", oauth_providers: [], local_dev_login: false };
      let userData: User | null = null;
      let welcome = false;

      try {
        const configRes = await apiFetch("/api/auth/config");
        if (configRes.ok) {
          cfg = await configRes.json();

          if (cfg.auth_required) {
            const meRes = await apiFetch("/api/auth/me");
            if (meRes.ok) {
              userData = await meRes.json();

              // Check for OAuth welcome redirect (new user)
              const params = new URLSearchParams(window.location.search);
              if (params.get("welcome") === "1") {
                // Read the one-time API key from the cookie set by the OAuth flow
                const cookieMatch = document.cookie.match(/(?:^|;\s*)rllm_new_api_key=([^;]*)/);
                if (cookieMatch) {
                  setOneTimeApiKey(decodeURIComponent(cookieMatch[1]));
                  document.cookie = "rllm_new_api_key=; max-age=0; path=/";
                }
                welcome = true;
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
        // Config fetch failed — default to requiring auth
      }

      // Batch all state updates together to avoid intermediate renders
      setConfig(cfg);
      setUser(userData);
      if (welcome) setJustRegistered(true);
      setIsLoading(false);
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
        const { api_key, ...userData } = data;
        setUser(userData);
        setOneTimeApiKey(api_key);
        setJustRegistered(true);
        return null;
      }
      const err = await res.json().catch(() => ({}));
      return err.detail || `Registration failed (${res.status})`;
    } catch {
      return "Network error";
    }
  }, []);

  const localDevLogin = useCallback(async (): Promise<string | null> => {
    try {
      const res = await apiFetch("/api/auth/local-dev-login", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
        return null;
      }
      const err = await res.json().catch(() => ({}));
      return err.detail || `Local dev login failed (${res.status})`;
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
        oneTimeApiKey,
        clearJustRegistered,
        login,
        register,
        localDevLogin,
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
