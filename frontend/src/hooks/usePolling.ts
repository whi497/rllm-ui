"use client";

import { useEffect, useRef } from 'react';

interface UsePollingOptions {
  /** Polling interval in milliseconds */
  interval: number;
  /** Whether polling is enabled (default: true) */
  enabled?: boolean;
  /** Pause polling when the tab is hidden (default: true) */
  pauseWhenHidden?: boolean;
}

/**
 * Fires `callback` immediately on mount / re-enable / tab-visible,
 * then repeats on `interval`. Clears when disabled or tab hidden.
 */
export function usePolling(
  callback: () => void,
  { interval, enabled = true, pauseWhenHidden = true }: UsePollingOptions
) {
  const savedCallback = useRef(callback);

  // Keep callback ref fresh without restarting the interval
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      savedCallback.current();
      timer = setInterval(() => savedCallback.current(), interval);
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    // Start immediately (unless tab is already hidden and we respect that)
    if (!pauseWhenHidden || !document.hidden) {
      start();
    }

    if (pauseWhenHidden) {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      stop();
      if (pauseWhenHidden) {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [interval, enabled, pauseWhenHidden]);
}
