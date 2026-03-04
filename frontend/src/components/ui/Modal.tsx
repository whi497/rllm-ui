"use client";

import React, { useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  maxWidth?: string;
  className?: string;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  maxWidth = "max-w-sm",
  className = "",
  children,
}) => {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        className={`relative bg-white rounded-xl shadow-xl border border-gray-200 p-6 ${maxWidth} w-full mx-4 ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
