import React, { useState, useMemo } from "react";
import { CollapsibleSection } from "./ui";
import { HighlightedText } from "./HighlightedText";
import { SearchIcon } from "./icons";
import { EmptyState } from "./ui";

const formatConfigValue = (value: any): string => {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null))
      return value.join(", ");
    return JSON.stringify(value);
  }
  return String(value);
};

/** Returns true if a value is a "leaf" (not a nested object to recurse into). */
function isLeaf(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return true;
  if (typeof value === "object") return false;
  return true;
}

/**
 * Recursively filters config to only include paths where a key or leaf value
 * matches the query. Returns null if nothing matches.
 */
function filterConfigRecursive(
  obj: Record<string, any>,
  query: string
): Record<string, any> | null {
  const result: Record<string, any> = {};
  let hasMatch = false;

  for (const [key, value] of Object.entries(obj)) {
    const keyMatches = key.toLowerCase().includes(query);

    if (isLeaf(value)) {
      const valueMatches = formatConfigValue(value)
        .toLowerCase()
        .includes(query);
      if (keyMatches || valueMatches) {
        result[key] = value;
        hasMatch = true;
      }
    } else {
      // It's a nested object
      if (keyMatches) {
        // Section name matches → include entire subtree
        result[key] = value;
        hasMatch = true;
      } else {
        // Recurse into children
        const filtered = filterConfigRecursive(value, query);
        if (filtered !== null) {
          result[key] = filtered;
          hasMatch = true;
        }
      }
    }
  }

  return hasMatch ? result : null;
}

/** Collects all section keys (at every depth) present in the filtered config. */
function collectSectionKeys(
  obj: Record<string, any>,
  prefix: string = ""
): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    if (!isLeaf(value)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      keys.add(fullKey);
      const childKeys = collectSectionKeys(value, fullKey);
      childKeys.forEach((k) => keys.add(k));
    }
  }
  return keys;
}

/** Recursively count all leaf entries in an object. */
function countLeaves(obj: Record<string, any>): number {
  let count = 0;
  for (const value of Object.values(obj)) {
    if (isLeaf(value)) count++;
    else count += countLeaves(value);
  }
  return count;
}

interface ConfigSectionProps {
  sectionKey: string;
  sectionPath: string;
  data: Record<string, any>;
  searchQuery: string;
  isSearchActive: boolean;
  searchExpandedKeys: Set<string>;
  expandedSections: Set<string>;
  onToggle: (path: string) => void;
  depth: number;
}

const ConfigSection: React.FC<ConfigSectionProps> = ({
  sectionKey,
  sectionPath,
  data,
  searchQuery,
  isSearchActive,
  searchExpandedKeys,
  expandedSections,
  onToggle,
  depth,
}) => {
  const isOpen = isSearchActive
    ? searchExpandedKeys.has(sectionPath)
    : expandedSections.has(sectionPath);

  const toggle = () => {
    if (isSearchActive) return;
    onToggle(sectionPath);
  };

  const total = countLeaves(data);

  // Separate leaf entries from nested sections
  const leafEntries: [string, any][] = [];
  const nestedEntries: [string, Record<string, any>][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isLeaf(value)) {
      leafEntries.push([key, value]);
    } else {
      nestedEntries.push([key, value]);
    }
  }

  const section = (
    <CollapsibleSection
      isExpanded={isOpen}
      onToggle={toggle}
      disabled={isSearchActive}
      className={`border-b border-gray-200 last:border-b-0 bg-layer-1`}
      title={
        <h3 className="text-sm font-medium text-gray-900">
          <HighlightedText
            text={sectionKey}
            searchQuery={searchQuery}
          />
        </h3>
      }
      rightLabel={
        <>
          {total} {total === 1 ? "field" : "fields"}
        </>
      }
    >
      {/* Render leaf key-value pairs */}
      {leafEntries.length > 0 && (
        <dl className="bg-layer-1">
          {leafEntries.map(([key, value]) => (
            <div
              key={key}
              className="px-4 py-2 flex justify-between items-start gap-4"
            >
              <dt className="text-sm text-gray-500">
                <HighlightedText text={key} searchQuery={searchQuery} />
              </dt>
              <dd className="text-sm text-gray-900 text-right font-mono">
                <HighlightedText
                  text={formatConfigValue(value)}
                  searchQuery={searchQuery}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Render nested sections recursively */}
      {nestedEntries.map(([key, value]) => (
        <ConfigSection
          key={key}
          sectionKey={key}
          sectionPath={`${sectionPath}.${key}`}
          data={value}
          searchQuery={searchQuery}
          isSearchActive={isSearchActive}
          searchExpandedKeys={searchExpandedKeys}
          expandedSections={expandedSections}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </CollapsibleSection>
  );

  if (depth > 0) {
    return <div style={{ marginLeft: 16 }}>{section}</div>;
  }
  return section;
};

interface ConfigRendererProps {
  data: Record<string, any>;
  searchQuery: string;
}

export const ConfigRenderer: React.FC<ConfigRendererProps> = ({
  data,
  searchQuery,
}) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set()
  );

  const query = searchQuery.toLowerCase();
  const isSearchActive = query.length > 0;

  const filteredConfig = useMemo(() => {
    if (!isSearchActive) return null;
    return filterConfigRecursive(data, query);
  }, [data, query, isSearchActive]);

  const searchExpandedKeys = useMemo(() => {
    if (!filteredConfig) return new Set<string>();
    return collectSectionKeys(filteredConfig);
  }, [filteredConfig]);

  const configToRender = isSearchActive ? filteredConfig : data;

  if (!configToRender || Object.keys(configToRender).length === 0) {
    if (isSearchActive) {
      return (
        <EmptyState
          icon={
            <SearchIcon size={24} className="text-gray-400" />
          }
          title="No matching fields"
          className="py-12 px-4"
        />
      );
    }
    return null;
  }

  // Separate top-level leaves from top-level sections
  const topLeaves: [string, any][] = [];
  const topSections: [string, Record<string, any>][] = [];
  for (const [key, value] of Object.entries(configToRender)) {
    if (isLeaf(value)) {
      topLeaves.push([key, value]);
    } else {
      topSections.push([key, value]);
    }
  }

  const handleToggle = (path: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const hasRllmKey = topSections.some(([key]) => key === "rllm");

  // Helper to render a list of sections
  const renderSections = (
    sections: [string, Record<string, any>][],
    pathPrefix?: string
  ) =>
    sections.map(([key, value]) => (
      <ConfigSection
        key={key}
        sectionKey={key}
        sectionPath={pathPrefix ? `${pathPrefix}.${key}` : key}
        data={value}
        searchQuery={searchQuery}
        isSearchActive={isSearchActive}
        searchExpandedKeys={searchExpandedKeys}
        expandedSections={expandedSections}
        onToggle={handleToggle}
        depth={0}
      />
    ));

  // Helper to render top-level leaves
  const renderTopLeaves = () =>
    topLeaves.length > 0 ? (
      <dl className="bg-layer-1 border-b border-gray-200">
        {topLeaves.map(([key, value]) => (
          <div
            key={key}
            className="px-4 py-2 flex justify-between items-start gap-4"
          >
            <dt className="text-sm text-gray-500">
              <HighlightedText text={key} searchQuery={searchQuery} />
            </dt>
            <dd className="text-sm text-gray-900 text-right font-mono">
              <HighlightedText
                text={formatConfigValue(value)}
                searchQuery={searchQuery}
              />
            </dd>
          </div>
        ))}
      </dl>
    ) : null;

  // Fallback: single-column layout (no rllm key — old sessions)
  if (!hasRllmKey) {
    return (
      <>
        {renderTopLeaves()}
        {renderSections(topSections)}
      </>
    );
  }

  // Two-column layout: rllm on the left, everything else on the right
  const rllmData = topSections.find(([key]) => key === "rllm")![1];
  const otherSections = topSections.filter(([key]) => key !== "rllm");

  // Break rllm into its sub-sections (rendered directly, not wrapped in a parent collapsible)
  const rllmLeaves: [string, any][] = [];
  const rllmSubSections: [string, Record<string, any>][] = [];
  for (const [key, value] of Object.entries(rllmData)) {
    if (isLeaf(value)) {
      rllmLeaves.push([key, value]);
    } else {
      rllmSubSections.push([key, value]);
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Left column: rllm config */}
      <div className="w-1/2 overflow-y-auto border-r border-gray-200">
        <div className="px-4 h-14 border-b border-gray-200 flex items-center sticky top-0 z-10 bg-white">
          <span className="text-sm font-medium text-gray-900">rllm config</span>
        </div>
        {rllmLeaves.length > 0 && (
          <dl className="bg-layer-1 border-b border-gray-200">
            {rllmLeaves.map(([key, value]) => (
              <div
                key={key}
                className="px-4 py-2 flex justify-between items-start gap-4"
              >
                <dt className="text-sm text-gray-500">
                  <HighlightedText text={key} searchQuery={searchQuery} />
                </dt>
                <dd className="text-sm text-gray-900 text-right font-mono">
                  <HighlightedText
                    text={formatConfigValue(value)}
                    searchQuery={searchQuery}
                  />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {renderSections(rllmSubSections, "rllm")}
      </div>

      {/* Right column: backend config */}
      <div className="w-1/2 overflow-y-auto">
        <div className="px-4 h-14 border-b border-gray-200 flex items-center sticky top-0 z-10 bg-white">
          <span className="text-sm font-medium text-gray-900">Backend config</span>
        </div>
        {renderTopLeaves()}
        {renderSections(otherSections)}
      </div>
    </div>
  );
};
