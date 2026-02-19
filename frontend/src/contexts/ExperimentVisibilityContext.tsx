import React, { createContext, useContext, useState, useCallback } from "react";

interface ExperimentVisibilityState {
  hiddenExperiments: Set<string>;
  toggleExperiment: (sessionId: string) => void;
  resetVisibility: () => void;
  hideAll: (sessionIds: string[]) => void;
  pinnedExperiments: string[];
  togglePin: (sessionId: string) => void;
}

const ExperimentVisibilityContext = createContext<ExperimentVisibilityState>({
  hiddenExperiments: new Set(),
  toggleExperiment: () => {},
  resetVisibility: () => {},
  hideAll: () => {},
  pinnedExperiments: [],
  togglePin: () => {},
});

export const ExperimentVisibilityProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [hiddenExperiments, setHiddenExperiments] = useState<Set<string>>(
    new Set()
  );
  const [pinnedExperiments, setPinnedExperiments] = useState<string[]>([]);

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

  return (
    <ExperimentVisibilityContext.Provider
      value={{ hiddenExperiments, toggleExperiment, resetVisibility, hideAll, pinnedExperiments, togglePin }}
    >
      {children}
    </ExperimentVisibilityContext.Provider>
  );
};

export const useExperimentVisibility = () =>
  useContext(ExperimentVisibilityContext);
