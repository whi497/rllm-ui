import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MoreVertIcon, EditIcon, DeleteIcon, PaletteIcon, PushPinIcon } from "./icons";
import { PRESET_COLORS } from "../utils/experimentColors";

interface ActionMenuProps {
  onRename: () => void;
  onDelete: () => void;
  onChangeColor?: (color: string) => void;
  currentColor?: string;
  onPin?: () => void;
  isPinned?: boolean;
  className?: string;
}

export const ActionMenu: React.FC<ActionMenuProps> = ({
  onRename,
  onDelete,
  onChangeColor,
  currentColor,
  onPin,
  isPinned,
  className = "",
}) => {
  const [open, setOpen] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Position the dropdown when opening
  useEffect(() => {
    if (open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    if (!open) setShowColors(false);
  }, [open]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(!open);
        }}
        className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-layer-2 transition-colors"
        title="Actions"
      >
        <MoreVertIcon sx={{ fontSize: 18 }} />
      </button>

      {/* Entire dropdown rendered as portal to escape overflow clipping */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg z-[9999] py-1 w-36 overflow-visible"
          style={{ top: menuPos.top, right: menuPos.right }}
        >
          {onPin && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
                onPin();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-layer-1 transition-colors"
            >
              <PushPinIcon sx={{ fontSize: 16 }} />
              {isPinned ? "Unpin" : "Pin"}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setOpen(false);
              onRename();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-layer-1 transition-colors"
          >
            <EditIcon sx={{ fontSize: 16 }} />
            Rename
          </button>
          {onChangeColor && (
            <div
              className="relative"
              onMouseEnter={() => setShowColors(true)}
              onMouseLeave={() => setShowColors(false)}
            >
              <button
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${showColors ? "text-accent-700 bg-accent-50" : "text-gray-700 hover:bg-layer-1"}`}
              >
                <PaletteIcon sx={{ fontSize: 16 }} />
                Change color
              </button>
              {showColors && (
                <div className="absolute left-full top-0 bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-max">
                  <div className="grid grid-cols-5 gap-1">
                    {PRESET_COLORS.map((color) => (
                      <button
                        key={color}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          onChangeColor(color);
                          setOpen(false);
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
                </div>
              )}
            </div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setOpen(false);
              onDelete();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
          >
            <DeleteIcon sx={{ fontSize: 16 }} />
            Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};
