"use client";

import React from "react";
import { AuthProvider } from "../contexts/AuthContext";
import { AuthGuard } from "./auth/AuthGuard";
import { ExperimentVisibilityProvider } from "../contexts/ExperimentVisibilityContext";
import { Sidebar } from "./Sidebar";

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
              {children}
            </main>
          </div>
        </ExperimentVisibilityProvider>
      </AuthGuard>
    </AuthProvider>
  );
};
