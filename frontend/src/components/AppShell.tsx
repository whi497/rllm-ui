"use client";

import React from "react";
import { AuthProvider, useAuth } from "../contexts/AuthContext";
import { AuthGuard } from "./auth/AuthGuard";
import { ExperimentVisibilityProvider } from "../contexts/ExperimentVisibilityContext";
import { Sidebar } from "./Sidebar";

const ImpersonationBanner: React.FC = () => {
  const { user, stopImpersonating } = useAuth();

  if (!user?.impersonating) return null;

  return (
    <div className="bg-amber-500 text-white px-4 py-1.5 text-xs font-medium flex items-center justify-between flex-shrink-0">
      <span>
        Viewing as <strong>{user.email}</strong>
        {user.team && <span className="ml-1 opacity-80">({user.team})</span>}
      </span>
      <button
        onClick={stopImpersonating}
        className="px-2 py-0.5 bg-white/20 hover:bg-white/30 rounded text-xs font-medium transition-colors"
      >
        Stop impersonating
      </button>
    </div>
  );
};

export const AppShell: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  return (
    <AuthProvider>
      <AuthGuard>
        <ExperimentVisibilityProvider>
          <div className="flex w-full h-screen overflow-hidden bg-layer-1">
            <Sidebar />
            <main className="flex-1 flex flex-col overflow-hidden bg-layer-1">
              <ImpersonationBanner />
              {children}
            </main>
          </div>
        </ExperimentVisibilityProvider>
      </AuthGuard>
    </AuthProvider>
  );
};
