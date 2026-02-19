import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Ansi from "ansi-to-react";
import type { LogEntry } from "../hooks/useSSE";

interface LogsPanelProps {
  logs: LogEntry[];
  isLoading: boolean;
}

export const LogsPanel: React.FC<LogsPanelProps> = ({ logs, isLoading }) => {

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [followMode, setFollowMode] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolling = useRef(false);
  const matchRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());

  // Indices of logs that contain the active query
  const matchIndices = useMemo(() => {
    if (!activeQuery) return [];
    const q = activeQuery.toLowerCase();
    const indices: number[] = [];
    logs.forEach((log, i) => {
      if (log.message.toLowerCase().includes(q)) {
        indices.push(i);
      }
    });
    return indices;
  }, [logs, activeQuery]);

  // Clamp currentMatchIndex when matches change
  useEffect(() => {
    if (matchIndices.length === 0) {
      setCurrentMatchIndex(0);
    } else if (currentMatchIndex >= matchIndices.length) {
      setCurrentMatchIndex(matchIndices.length - 1);
    }
  }, [matchIndices.length, currentMatchIndex]);

  // Scroll to current match
  useEffect(() => {
    if (matchIndices.length === 0) return;
    const logIndex = matchIndices[currentMatchIndex];
    const el = matchRefs.current.get(logIndex);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setFollowMode(false);
    }
  }, [currentMatchIndex, matchIndices]);

  const navigateToNext = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matchIndices.length);
  }, [matchIndices.length]);

  const navigateToPrev = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matchIndices.length) % matchIndices.length);
  }, [matchIndices.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (!activeQuery && searchInput) {
        // First Enter: activate search, jump to first match
        setActiveQuery(searchInput);
        setCurrentMatchIndex(0);
      } else if (activeQuery) {
        // Subsequent Enter: navigate matches
        if (e.shiftKey) {
          navigateToPrev();
        } else {
          navigateToNext();
        }
      }
    }
  };

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Auto-scroll when new logs arrive and follow mode is on
  useEffect(() => {
    if (followMode && !isUserScrolling.current) {
      scrollToBottom();
    }
  }, [logs.length, followMode, scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;

    if (isAtBottom) {
      isUserScrolling.current = false;
      setFollowMode(true);
    } else {
      isUserScrolling.current = true;
      setFollowMode(false);
    }
  }, []);

  const formatTime = (timestamp: string) => {
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString("en-US", { hour12: false });
    } catch {
      return timestamp;
    }
  };

  const currentMatchLogIndex = matchIndices.length > 0 ? matchIndices[currentMatchIndex] : -1;

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-200 flex-shrink-0 bg-white">
        {/* Search */}
        <div className="flex-1 max-w-xs relative">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              if (!e.target.value) {
                setActiveQuery("");
                setCurrentMatchIndex(0);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search logs..."
            className="w-full pl-8 pr-8 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
          />
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Match navigation — only show when there are matches */}
        {matchIndices.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={navigateToPrev}
              className="p-1.5 hover:bg-gray-100 rounded text-gray-500"
              title="Previous match (Shift+Enter)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              onClick={navigateToNext}
              className="p-1.5 hover:bg-gray-100 rounded text-gray-500"
              title="Next match (Enter)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <span className="text-xs text-gray-500 ml-1">
              {currentMatchIndex + 1} / {matchIndices.length}
            </span>
          </div>
        )}
        {activeQuery && matchIndices.length === 0 && (
          <span className="text-xs text-gray-400">No matches</span>
        )}

        {/* Follow mode toggle */}
        <button
          onClick={() => {
            setFollowMode(!followMode);
            if (!followMode) {
              isUserScrolling.current = false;
              scrollToBottom();
            }
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
            followMode
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-500 hover:text-gray-700"
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
          Follow
        </button>

      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-xs leading-5 p-2 pr-4"
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3">
              <div className="w-5 h-5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
              <p className="text-gray-400 text-sm">Loading logs...</p>
            </div>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-900">No logs yet</p>
          </div>
        ) : (
          logs.map((log, index) => (
            <LogLine
              key={log.id}
              log={log}
              formatTime={formatTime}
              activeQuery={activeQuery}
              isCurrentMatch={index === currentMatchLogIndex}
              ref={(el) => {
                if (activeQuery) {
                  matchRefs.current.set(index, el);
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LogLine = React.memo(
  React.forwardRef<
    HTMLDivElement,
    { log: LogEntry; formatTime: (t: string) => string; activeQuery: string; isCurrentMatch: boolean }
  >(({ log, formatTime, activeQuery, isCurrentMatch }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex gap-2 px-1 hover:bg-gray-50 text-gray-700 ${
          isCurrentMatch ? "bg-orange-50 border-l-2 border-orange-400" : ""
        }`}
      >
        <span className="text-gray-400 select-none flex-shrink-0">
          [{formatTime(log.timestamp)}]
        </span>
        <span className="whitespace-pre-wrap break-all">
          {activeQuery ? (
            <HighlightAnsi message={log.message} query={activeQuery} isCurrentMatch={isCurrentMatch} />
          ) : (
            <Ansi>{log.message}</Ansi>
          )}
        </span>
      </div>
    );
  })
);

/**
 * Renders ANSI-colored text with search highlights overlaid.
 * Splits the raw message on query matches, renders each segment through <Ansi>,
 * and wraps matched segments in a highlight <mark>.
 */
const HighlightAnsi: React.FC<{ message: string; query: string; isCurrentMatch: boolean }> = ({ message, query, isCurrentMatch }) => {
  const regex = new RegExp(`(${escapeRegExp(query)})`, "gi");
  const parts = message.split(regex);

  return (
    <>
      {parts.map((part, i) => {
        const isMatch = part.toLowerCase() === query.toLowerCase();
        if (isMatch) {
          return (
            <mark
              key={i}
              className={`px-0.5 rounded ${
                isCurrentMatch ? "bg-orange-400 text-white" : "bg-yellow-200 text-inherit"
              }`}
            >
              <Ansi>{part}</Ansi>
            </mark>
          );
        }
        return <Ansi key={i}>{part}</Ansi>;
      })}
    </>
  );
};
