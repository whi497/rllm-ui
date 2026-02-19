import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRESET_COLORS } from "../utils/experimentColors";

interface ColorPickerProps {
  open: boolean;
  currentColor: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (color: string) => void;
  onClose: () => void;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  open,
  currentColor,
  anchorRef,
  onSelect,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 4,
      left: rect.left,
    });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-lg p-2"
      style={{ top: position.top, left: position.left }}
    >
      <div className="grid grid-cols-5 gap-1">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => {
              onSelect(color);
              onClose();
            }}
            className="w-6 h-6 rounded-md border-2 transition-transform hover:scale-110"
            style={{
              backgroundColor: color,
              borderColor: color === currentColor ? "#111827" : "transparent",
            }}
            title={color}
          />
        ))}
      </div>
    </div>,
    document.body
  );
};
