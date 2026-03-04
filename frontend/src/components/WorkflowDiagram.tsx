"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-python';
import 'prismjs/themes/prism.css';
import { EmptyState, CollapsibleSection } from './ui';
import { HighlightedText, countMatches } from './HighlightedText';
import { SearchIcon } from './icons';

interface SourceMetadata {
  workflow_source?: string;
  workflow_class?: string;
  reward_fn_source?: string;
  reward_fn_name?: string;
  agent_source?: string;
  agent_class?: string;
}

interface Session {
  id: string;
  project: string;
  experiment: string;
  config: Record<string, any> | null;
  source_metadata?: SourceMetadata | null;
  created_at: string;
  completed_at: string | null;
}

interface WorkflowDiagramProps {
  session: Session | null;
  expandedSections: Set<string>;
  onExpandedSectionsChange: (sections: Set<string>) => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inject <mark> tags into Prism-highlighted HTML, only touching text nodes (not tags). */
function injectSearchMarks(html: string, query: string, currentOccurrence?: number): string {
  const escaped = escapeRegExp(query);
  const regex = new RegExp(escaped, 'gi');

  // Split HTML into tags and text segments
  const parts = html.split(/(<[^>]*>)/);
  let occurrence = 0;

  return parts
    .map((part) => {
      // HTML tag — leave untouched
      if (part.startsWith('<')) return part;
      // Text node — wrap matches in <mark>
      return part.replace(regex, (match) => {
        const isCurrent = occurrence === currentOccurrence;
        occurrence++;
        const cls = isCurrent
          ? 'rounded bg-orange-400 text-white current-code-match'
          : 'rounded bg-yellow-200';
        return `<mark class="${cls}">${match}</mark>`;
      });
    })
    .join('');
}

/** Code block with Prism syntax highlighting + search mark injection */
const PrismSearchCode: React.FC<{
  code: string;
  searchQuery: string;
  currentOccurrence?: number;
  scrollRef?: React.MutableRefObject<HTMLSpanElement | null>;
}> = ({ code, searchQuery, currentOccurrence, scrollRef }) => {
  const preRef = useRef<HTMLPreElement>(null);

  const html = useMemo(() => {
    const grammar = Prism.languages.python;
    const highlighted = Prism.highlight(code, grammar, 'python');
    if (!searchQuery.trim()) return highlighted;
    return injectSearchMarks(highlighted, searchQuery, currentOccurrence);
  }, [code, searchQuery, currentOccurrence]);

  // After render, find the current match element and assign to scrollRef
  useEffect(() => {
    if (!preRef.current || !scrollRef) return;
    const el = preRef.current.querySelector('.current-code-match');
    scrollRef.current = (el as HTMLSpanElement) || null;
  }, [html, scrollRef]);

  return (
    <pre className="language-python p-4 text-xs font-mono bg-white m-0 overflow-auto" ref={preRef}>
      <code className="language-python" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
};

/** Plain Prism code block (no search) */
const PrismCode: React.FC<{ code: string }> = ({ code }) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current) {
      Prism.highlightElement(ref.current);
    }
  }, [code]);

  return (
    <pre className="p-4 text-xs font-mono bg-white m-0 overflow-auto">
      <code ref={ref} className="language-python">{code}</code>
    </pre>
  );
};

interface CodeSectionProps {
  label: string;
  name?: string;
  source?: string;
  fallbackMessage?: string;
  isExpanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  searchQuery?: string;
  isCurrentMatchSection?: boolean;
  currentMatchOccurrence?: number;
  scrollRef?: React.MutableRefObject<HTMLSpanElement | null>;
}

const CodeSection: React.FC<CodeSectionProps> = ({
  label,
  name,
  source,
  fallbackMessage,
  isExpanded,
  onToggle,
  disabled = false,
  searchQuery = "",
  isCurrentMatchSection = false,
  currentMatchOccurrence,
  scrollRef,
}) => (
  <CollapsibleSection
    isExpanded={isExpanded}
    onToggle={onToggle}
    disabled={disabled}
    title={
      <>
        <h3 className="text-sm font-medium text-gray-900">
          <HighlightedText text={label} searchQuery={searchQuery} />
        </h3>
        {name && (
          <span className="text-xs text-gray-500 font-mono">
            <HighlightedText text={name} searchQuery={searchQuery} />
          </span>
        )}
      </>
    }
    contentClassName="bg-white"
  >
    {source ? (
      searchQuery.trim() ? (
        <PrismSearchCode
          code={source}
          searchQuery={searchQuery}
          currentOccurrence={isCurrentMatchSection ? currentMatchOccurrence : undefined}
          scrollRef={isCurrentMatchSection ? scrollRef : undefined}
        />
      ) : (
        <PrismCode code={source} />
      )
    ) : fallbackMessage ? (
      <div className="p-4 text-sm text-gray-500">{fallbackMessage}</div>
    ) : null}
  </CollapsibleSection>
);

export const WorkflowDiagram: React.FC<WorkflowDiagramProps> = ({ session, expandedSections, onExpandedSectionsChange }) => {
  const metadata = session?.source_metadata;

  // Search state — instant search like config tab (no committed query)
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const currentMatchRef = useRef<HTMLSpanElement | null>(null);
  const shouldScrollRef = useRef(false);
  const prevQueryRef = useRef("");

  const noSourceCodeState = (
    <EmptyState
      icon={
        <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      }
      title="No source code available"
      className="h-full bg-layer-1"
    />
  );

  if (!metadata) return noSourceCodeState;

  const hasWorkflow = !!metadata.workflow_source;
  const hasReward = !!metadata.reward_fn_source || !!metadata.reward_fn_name;
  const hasAgent = !!metadata.agent_source;

  if (!hasWorkflow && !hasReward && !hasAgent) return noSourceCodeState;

  const isSearchActive = searchQuery.trim().length > 0;
  const query = searchQuery.trim();

  // Ordered list of sections with source code
  const allSections = [
    { key: 'workflow', label: 'Workflow', name: metadata.workflow_class, source: metadata.workflow_source },
    { key: 'reward', label: 'Reward Function', name: metadata.reward_fn_name, source: metadata.reward_fn_source, fallbackMessage: metadata.reward_fn_name && !metadata.reward_fn_source ? 'Source code not available for built-in functions.' : undefined },
    { key: 'agent', label: 'Agent', name: metadata.agent_class, source: metadata.agent_source },
  ].filter((s) => s.key === 'workflow' ? hasWorkflow : s.key === 'reward' ? hasReward : hasAgent);

  // Count matches per section and determine which sections match
  const sectionMatchCounts = new Map<string, number>();
  let totalMatches = 0;
  const matchingSectionKeys = new Set<string>();

  if (isSearchActive) {
    for (const section of allSections) {
      let count = 0;
      if (section.source) {
        count = countMatches(section.source, query);
      }
      sectionMatchCounts.set(section.key, count);
      totalMatches += count;

      // Section matches if source has matches OR label/name contains query
      const lowerQuery = query.toLowerCase();
      if (
        count > 0 ||
        section.label.toLowerCase().includes(lowerQuery) ||
        (section.name && section.name.toLowerCase().includes(lowerQuery))
      ) {
        matchingSectionKeys.add(section.key);
      }
    }
  }

  // Map global match index → { sectionKey, localOccurrence }
  let currentMatchInfo: { sectionKey: string; localOccurrence: number } | null = null;
  if (totalMatches > 0) {
    let remaining = currentMatchIndex;
    for (const section of allSections) {
      const count = sectionMatchCounts.get(section.key) || 0;
      if (remaining < count) {
        currentMatchInfo = { sectionKey: section.key, localOccurrence: remaining };
        break;
      }
      remaining -= count;
    }
  }

  const toggleSection = (key: string) => {
    if (isSearchActive) return; // disable toggle during search
    const next = new Set(expandedSections);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onExpandedSectionsChange(next);
  };

  // Reset match index when query changes
  if (query !== prevQueryRef.current) {
    prevQueryRef.current = query;
    setCurrentMatchIndex(0);
    if (totalMatches > 0) {
      shouldScrollRef.current = true;
    }
  }

  const navigateNext = () => {
    if (totalMatches === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex((prev) => (prev + 1) % totalMatches);
  };

  const navigatePrev = () => {
    if (totalMatches === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex((prev) => (prev - 1 + totalMatches) % totalMatches);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Search bar header — same style as config search */}
      <div className="px-4 h-14 border-b border-gray-200 flex-shrink-0 flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            placeholder="Search code..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && totalMatches > 0) {
                if (e.shiftKey) navigatePrev();
                else navigateNext();
              }
            }}
            className="w-full pl-8 pr-8 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
          />
          <SearchIcon
            size={16}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {totalMatches > 0 && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button onClick={navigatePrev} className="p-0.5 hover:bg-layer-2 rounded text-gray-500" title="Previous match (Shift+Enter)">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button onClick={navigateNext} className="p-0.5 hover:bg-layer-2 rounded text-gray-500" title="Next match (Enter)">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              {currentMatchIndex + 1}/{totalMatches}
            </span>
          </div>
        )}
      </div>

      {/* Scroll effect */}
      <ScrollToMatch shouldScrollRef={shouldScrollRef} scrollRef={currentMatchRef} deps={[currentMatchIndex, totalMatches]} />

      <div className="flex-1 overflow-y-auto">
        {isSearchActive && matchingSectionKeys.size === 0 ? (
          <EmptyState
            icon={<SearchIcon size={24} className="text-gray-400" />}
            title="No matches found"
            className="py-12 px-4"
          />
        ) : (
          allSections.map((section) => {
            // During search, only show matching sections
            if (isSearchActive && !matchingSectionKeys.has(section.key)) return null;

            const isOpen = isSearchActive
              ? matchingSectionKeys.has(section.key)
              : expandedSections.has(section.key);

            return (
              <CodeSection
                key={section.key}
                label={section.label}
                name={section.name}
                source={section.source}
                fallbackMessage={section.fallbackMessage}
                isExpanded={isOpen}
                onToggle={() => toggleSection(section.key)}
                disabled={isSearchActive}
                searchQuery={query}
                isCurrentMatchSection={currentMatchInfo?.sectionKey === section.key}
                currentMatchOccurrence={currentMatchInfo?.sectionKey === section.key ? currentMatchInfo.localOccurrence : undefined}
                scrollRef={currentMatchRef}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

/** Helper component to run scroll effect without hooks-in-conditional issues */
const ScrollToMatch: React.FC<{
  shouldScrollRef: React.MutableRefObject<boolean>;
  scrollRef: React.MutableRefObject<HTMLSpanElement | null>;
  deps: any[];
}> = ({ shouldScrollRef, scrollRef, deps }) => {
  useEffect(() => {
    if (shouldScrollRef.current) {
      const rafId = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        shouldScrollRef.current = false;
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, deps);
  return null;
};
