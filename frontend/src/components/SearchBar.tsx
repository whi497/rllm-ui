import React from "react";
import { SearchIcon } from "./icons";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear: () => void;
  showClear: boolean;
  placeholder?: string;
  // Match navigation (optional)
  matchCount?: number;
  currentMatchIndex?: number;
  onNavigateNext?: () => void;
  onNavigatePrev?: () => void;
}

const SearchBar: React.FC<SearchBarProps> = ({
  query,
  onQueryChange,
  onKeyDown,
  onClear,
  showClear,
  placeholder = "Search",
  matchCount = 0,
  currentMatchIndex = 0,
  onNavigateNext,
  onNavigatePrev,
}) => {
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <div className="flex-1 relative min-w-0">
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full pl-7 pr-7 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
        />
        <SearchIcon
          sx={{ fontSize: 14 }}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
        />
        {showClear && (
          <button
            onClick={onClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            title="Clear search"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
      {matchCount > 0 && onNavigateNext && onNavigatePrev && (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={onNavigatePrev}
            className="p-0.5 hover:bg-layer-2 rounded text-gray-500"
            title="Previous match (Shift+Enter)"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 15l7-7 7 7"
              />
            </svg>
          </button>
          <button
            onClick={onNavigateNext}
            className="p-0.5 hover:bg-layer-2 rounded text-gray-500"
            title="Next match (Enter)"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          <span className="text-xs text-gray-500 tabular-nums">
            {currentMatchIndex + 1}/{matchCount}
          </span>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
