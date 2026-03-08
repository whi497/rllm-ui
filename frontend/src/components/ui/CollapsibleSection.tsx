"use client";

import React from "react";
import { ChevronRightIcon, ChevronDownIcon } from "../icons";

interface CollapsibleSectionProps {
  isExpanded: boolean;
  onToggle: () => void;
  title: React.ReactNode;
  rightLabel?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  isExpanded,
  onToggle,
  title,
  rightLabel,
  children,
  className = "border-b border-gray-200 last:border-b-0 bg-layer-1",
  contentClassName,
  disabled = false,
}) => (
  <div className={className}>
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      className={`w-full px-4 py-2.5 bg-layer-1 flex items-center justify-between hover:bg-layer-2 transition-colors text-left ${disabled ? "cursor-default" : "cursor-pointer"}`}
    >
      <div className="flex items-center gap-2">
        {isExpanded ? (
          <ChevronDownIcon size={16} className="text-gray-400" />
        ) : (
          <ChevronRightIcon size={16} className="text-gray-400" />
        )}
        {title}
      </div>
      {rightLabel && <span className="text-xs text-gray-400">{rightLabel}</span>}
    </div>
    {isExpanded && (
      <div className={contentClassName}>{children}</div>
    )}
  </div>
);
