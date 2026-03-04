"use client";

import { useEffect } from "react";

export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        handler();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [ref, handler, enabled]);
}
