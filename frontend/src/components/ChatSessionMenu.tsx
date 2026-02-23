import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { MoreVertIcon, DeleteIcon } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { API_BASE_URL } from "../config/api";

interface ChatSession {
  id: string;
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface ChatSessionMenuProps {
  sessionId: string;
  activeChatSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const ChatSessionMenu: React.FC<ChatSessionMenuProps> = ({
  sessionId,
  activeChatSessionId,
  onSelect,
  onNew,
  onDelete,
}) => {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/agent/sessions?session_id=${sessionId}`
      );
      if (res.ok) {
        setSessions(await res.json());
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

  // Fetch sessions when menu opens
  useEffect(() => {
    if (open) {
      fetchSessions();
    }
  }, [open, fetchSessions]);

  // Position the dropdown
  useEffect(() => {
    if (open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
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

  const handleNew = () => {
    setOpen(false);
    onNew();
  };

  const handleSelect = (id: string) => {
    setOpen(false);
    onSelect(id);
  };

  const handleDeleteConfirm = () => {
    if (confirmDeleteId) {
      onDelete(confirmDeleteId);
      setSessions((prev) => prev.filter((s) => s.id !== confirmDeleteId));
      setConfirmDeleteId(null);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-layer-2 transition-colors"
        title="Chat sessions"
      >
        <MoreVertIcon sx={{ fontSize: 18 }} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg z-[9999] w-64 overflow-hidden"
          style={{ top: menuPos.top, right: menuPos.right }}
        >
          {/* New chat button */}
          <button
            onClick={handleNew}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent-700 hover:bg-accent-50 border-b border-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New chat
          </button>

          {/* Session list */}
          <div className="max-h-64 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                No chat sessions yet
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors group ${
                    s.id === activeChatSessionId
                      ? "bg-accent-50 border-l-2 border-accent-500"
                      : "hover:bg-layer-1 border-l-2 border-transparent"
                  }`}
                  onClick={() => handleSelect(s.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm truncate ${
                      s.id === activeChatSessionId ? "text-accent-700 font-medium" : "text-gray-700"
                    }`}>
                      {s.title}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {s.message_count} messages · {timeAgo(s.updated_at)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(s.id);
                    }}
                    className="p-1 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete chat"
                  >
                    <DeleteIcon sx={{ fontSize: 14 }} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete chat session"
        message="This will permanently delete this chat session and all its messages."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </>
  );
};
