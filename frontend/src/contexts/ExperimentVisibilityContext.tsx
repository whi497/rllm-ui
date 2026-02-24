import React, { createContext, useContext, useState, useCallback } from "react";
import { apiFetch } from "../config/api";

interface ExperimentVisibilityState {
  hiddenExperiments: Set<string>;
  toggleExperiment: (sessionId: string) => void;
  resetVisibility: () => void;
  hideAll: (sessionIds: string[]) => void;
  pinnedExperiments: string[];
  togglePin: (sessionId: string) => void;
  colorOverrides: Record<string, string>;
  updateColor: (sessionId: string, color: string) => void;
}

const ExperimentVisibilityContext = createContext<ExperimentVisibilityState>({
  hiddenExperiments: new Set(),
  toggleExperiment: () => {},
  resetVisibility: () => {},
  hideAll: () => {},
  pinnedExperiments: [],
  togglePin: () => {},
  colorOverrides: {},
  updateColor: () => {},
});

export const ExperimentVisibilityProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [hiddenExperiments, setHiddenExperiments] = useState<Set<string>>(
    new Set()
  );
  const [pinnedExperiments, setPinnedExperiments] = useState<string[]>([]);
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({});

  const togglePin = useCallback((sessionId: string) => {
    setPinnedExperiments((prev) => {
      if (prev.includes(sessionId)) {
        return prev.filter((id) => id !== sessionId);
      }
      return [...prev, sessionId];
    });
  }, []);

  const toggleExperiment = useCallback((sessionId: string) => {
    setHiddenExperiments((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const resetVisibility = useCallback(() => {
    setHiddenExperiments(new Set());
  }, []);

  const hideAll = useCallback((sessionIds: string[]) => {
    setHiddenExperiments(new Set(sessionIds));
  }, []);

  const updateColor = useCallback((sessionId: string, color: string) => {
    // Optimistic update — all consumers re-render immediately
    setColorOverrides((prev) => ({ ...prev, [sessionId]: color }));
    // Fire PATCH in background
    apiFetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    }).catch(() => { /* ignore */ });
  }, []);

  return (
    <ExperimentVisibilityContext.Provider
      value={{ hiddenExperiments, toggleExperiment, resetVisibility, hideAll, pinnedExperiments, togglePin, colorOverrides, updateColor }}
    >
      {children}
    </ExperimentVisibilityContext.Provider>
  );
};

export const useExperimentVisibility = () =>
  useContext(ExperimentVisibilityContext);
