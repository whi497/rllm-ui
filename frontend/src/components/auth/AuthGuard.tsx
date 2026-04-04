"use client";

import React from "react";
import { useAuth } from "../../contexts/AuthContext";
import { LoginPage } from "./LoginPage";
import { WelcomeModal } from "./WelcomeModal";
import { Spinner } from "../ui";

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config, user, isLoading, justRegistered, oneTimeApiKey, clearJustRegistered } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-layer-1">
        <Spinner size="lg" variant="black" label="Loading..." />
      </div>
    );
  }

  if (config?.auth_required && !user) {
    return <LoginPage />;
  }

  return (
    <>
      {children}
      {oneTimeApiKey && (
        <WelcomeModal
          open={justRegistered}
          onClose={clearJustRegistered}
          apiKey={oneTimeApiKey}
        />
      )}
    </>
  );
};
