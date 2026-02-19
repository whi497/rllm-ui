import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { ChevronRightIcon, ChevronDownIcon, SearchIcon, SortIcon } from "./icons";
import { HighlightedText, textContains } from "./HighlightedText";
import { API_BASE_URL } from "../config/api";

interface TrajectoryStep {
  observation?: any;
  thought?: string;
  action?: any;
  model_response?: string;
  chat_completions?: any[];
  info?: any;
  reward: number;
  done: boolean;
  mc_return?: number;
  advantage?: number;
  prompt_ids?: any;
  response_ids?: any;
  logprobs?: any;
  [key: string]: any;
}

interface Trajectory {
  uid: string;
  name?: string;
  reward: number;
  info?: Record<string, any>;
  steps: TrajectoryStep[];
}

interface Episode {
  id: string;
  session_id: string;
  step: number;
  task: Record<string, any>;
  is_correct: boolean;
  reward: number | null;
  termination_reason: string | null;
  trajectories: Trajectory[];
  metrics?: Record<string, any>;
  info?: Record<string, any>;
  created_at: string;
}

interface MatchLocation {
  episodeId: string;
  trajectoryUid: string;
  stepIndex: number;
  field: string;
}

interface EpisodePanelProps {
  episodes: Episode[];
  selectedStep: number | null;
  sessionId?: string;
  loading?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
}

interface SearchResponse {
  episodes: (Episode & { rank?: number })[];
  matched_terms: string[];
}

// Trajectory Group types
interface TrajectoryGroupMetadata {
  episode_id: string;
}

interface TrajectoryGroup {
  id: string;
  session_id: string;
  step: number;
  group_id: string;
  task_id: string;
  trajectory_name: string;
  num_trajectories: number;
  avg_reward: number | null;
  correct_count: number;
  total_count: number;
  metadata: TrajectoryGroupMetadata[];  // Now at top level (always present)
  data: {  // Optional - only populated when full trajectory data is fetched
    trajectories: Trajectory[];
    metadata: TrajectoryGroupMetadata[];
  } | null;
  created_at: string;
}

type ViewMode = "episodes" | "groups";

const searchEpisodesAPI = async (
  query: string,
  sessionId: string,
  limit: number = 50,
  step?: number | null
): Promise<SearchResponse> => {
  const params = new URLSearchParams({
    q: query,
    session_id: sessionId,
    limit: String(limit),
  });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await fetch(
    `${API_BASE_URL}/api/episodes/search?${params}`
  );
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
};

const fetchTrajectoryGroupsAPI = async (
  sessionId: string,
  step?: number | null
): Promise<TrajectoryGroup[]> => {
  const params = new URLSearchParams({ session_id: sessionId });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await fetch(
    `${API_BASE_URL}/api/trajectory-groups?${params}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch trajectory groups: ${response.status}`);
  }
  const data = await response.json();
  return data.groups || [];
};

interface TrajectoryGroupSearchResponse {
  groups: TrajectoryGroup[];
  matched_terms: string[];
}

const searchTrajectoryGroupsAPI = async (
  query: string,
  sessionId: string,
  limit: number = 50,
  step?: number | null
): Promise<TrajectoryGroupSearchResponse> => {
  const params = new URLSearchParams({
    q: query,
    session_id: sessionId,
    limit: String(limit),
  });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await fetch(
    `${API_BASE_URL}/api/trajectory-groups/search?${params}`
  );
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
};

// Fetch a single trajectory group with full trajectory data
const fetchTrajectoryGroupAPI = async (
  groupId: string,
  includeTrajectories: boolean = true
): Promise<TrajectoryGroup> => {
  const params = new URLSearchParams({ include_trajectories: String(includeTrajectories) });
  const response = await fetch(
    `${API_BASE_URL}/api/trajectory-groups/${groupId}?${params}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch trajectory group: ${response.status}`);
  }
  return response.json();
};

// Helper to extract task_id from episode id (format: "task_id:rest")
const getTaskId = (episodeId: string): string => {
  const colonIndex = episodeId.indexOf(":");
  return colonIndex > 0 ? episodeId.slice(0, colonIndex) : episodeId;
};

// Group episodes by task_id
interface EpisodeBatch {
  taskId: string;
  episodes: Episode[];
  correctCount: number;
  totalCount: number;
}

const groupEpisodesByTask = (episodes: Episode[]): EpisodeBatch[] => {
  const grouped = new Map<string, Episode[]>();

  for (const episode of episodes) {
    const taskId = getTaskId(episode.id);
    if (!grouped.has(taskId)) {
      grouped.set(taskId, []);
    }
    grouped.get(taskId)!.push(episode);
  }

  return Array.from(grouped.entries()).map(([taskId, eps]) => ({
    taskId,
    episodes: eps,
    correctCount: eps.filter(e => e.is_correct).length,
    totalCount: eps.length,
  }));
};

// Group trajectory groups by task_id
interface TaskGroupBatch {
  taskId: string;
  groups: TrajectoryGroup[];
  totalTrajectories: number;
  avgReward: number | null;
  correctCount: number;
  totalCount: number;
}

const groupTrajectoryGroupsByTask = (groups: TrajectoryGroup[]): TaskGroupBatch[] => {
  const grouped = new Map<string, TrajectoryGroup[]>();

  for (const group of groups) {
    const taskId = group.task_id;
    if (!grouped.has(taskId)) {
      grouped.set(taskId, []);
    }
    grouped.get(taskId)!.push(group);
  }

  return Array.from(grouped.entries()).map(([taskId, grps]) => {
    const totalTrajs = grps.reduce((sum, g) => sum + g.num_trajectories, 0);
    const rewards = grps.filter(g => g.avg_reward !== null).map(g => g.avg_reward!);
    const avgReward = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : null;
    return {
      taskId,
      groups: grps,
      totalTrajectories: totalTrajs,
      avgReward,
      correctCount: grps.reduce((sum, g) => sum + g.correct_count, 0),
      totalCount: grps.reduce((sum, g) => sum + g.total_count, 0),
    };
  });
};

export const EpisodePanel: React.FC<EpisodePanelProps> = ({
  episodes,
  selectedStep,
  sessionId,
  loading = false,
  viewMode: externalViewMode,
}) => {
  const [expandedEpisodes, setExpandedEpisodes] = useState<Set<string>>(
    new Set()
  );
  const [expandedTrajectories, setExpandedTrajectories] = useState<Set<string>>(
    new Set()
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [matchLocations, setMatchLocations] = useState<MatchLocation[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const [searchResults, setSearchResults] = useState<
    (Episode & { rank?: number })[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [matchedTerms, setMatchedTerms] = useState<string[]>([]);

  // Trajectory groups view mode state
  const [internalViewMode] = useState<ViewMode>("episodes");
  const viewMode = externalViewMode ?? internalViewMode;
  const [trajectoryGroups, setTrajectoryGroups] = useState<TrajectoryGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Batch grouping state
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());

  // Sort state (episodes)
  const [sortMode, setSortMode] = useState<"default" | "solve-rate-desc" | "solve-rate-asc">("default");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // Group search state
  const [groupSearchQuery, setGroupSearchQuery] = useState("");
  const [groupCommittedQuery, setGroupCommittedQuery] = useState("");
  const [groupSearchResults, setGroupSearchResults] = useState<TrajectoryGroup[]>([]);
  const [groupSearchLoading, setGroupSearchLoading] = useState(false);
  const [groupSearchError, setGroupSearchError] = useState<string | null>(null);

  // Group sort state
  const [groupSortMode, setGroupSortMode] = useState("default");
  const [groupSortMenuOpen, setGroupSortMenuOpen] = useState(false);
  const groupSortMenuRef = useRef<HTMLDivElement>(null);

  const currentMatchRef = useRef<HTMLSpanElement>(null);
  const prevDebouncedQuery = useRef("");
  const shouldScrollRef = useRef(false);

  const effectiveSessionId = sessionId || episodes[0]?.session_id;

  const filteredEpisodes = useMemo(() => {
    if (committedQuery.trim()) {
      return searchResults;
    }
    return selectedStep !== null
      ? episodes.filter((ep) => ep.step === selectedStep)
      : [];
  }, [episodes, selectedStep, committedQuery, searchResults]);

  useEffect(() => {
    if (!committedQuery.trim()) {
      setSearchResults([]);
      setMatchLocations([]);
      setCurrentMatchIndex(0);
      setSearchError(null);
      setMatchedTerms([]);
      return;
    }

    if (!effectiveSessionId) {
      setSearchError("No session ID available");
      return;
    }

    const performSearch = async () => {
      setSearchLoading(true);
      setSearchError(null);

      try {
        const response = await searchEpisodesAPI(
          committedQuery,
          effectiveSessionId,
          50,
          selectedStep
        );
        const { episodes: results = [], matched_terms: terms = [] } = response;
        setSearchResults(results);
        setMatchedTerms(terms);

        const matches: MatchLocation[] = [];
        const expandEpisodes = new Set<string>();
        const expandTrajectories = new Set<string>();
        const expandBatches = new Set<string>();

        results.forEach((episode) => {
          const taskId = getTaskId(episode.id);
          const taskText = getTaskSummary(episode.task);
          if (textContains(taskText, committedQuery, terms)) {
            matches.push({
              episodeId: episode.id,
              trajectoryUid: "",
              stepIndex: -1,
              field: "task",
            });
            expandEpisodes.add(episode.id);
            expandBatches.add(taskId);
          }

          const trajectories = episode.trajectories || [];
          trajectories.forEach((trajectory, trajIdx) => {
            const trajUid = trajectory.uid || `${episode.id}-${trajIdx}`;

            trajectory.steps?.forEach((step, stepIdx) => {
              const visibleFields = getVisibleFields(step);

              visibleFields.forEach(({ key, value }) => {
                const fieldText = formatFieldValue(value);
                if (textContains(fieldText, committedQuery, terms)) {
                  matches.push({
                    episodeId: episode.id,
                    trajectoryUid: trajUid,
                    stepIndex: stepIdx,
                    field: key,
                  });
                  expandEpisodes.add(episode.id);
                  expandTrajectories.add(trajUid);
                  expandBatches.add(taskId);
                }
              });
            });
          });
        });

        setMatchLocations(matches);

        if (prevDebouncedQuery.current !== committedQuery) {
          setCurrentMatchIndex(0);
          prevDebouncedQuery.current = committedQuery;
          if (matches.length > 0) {
            shouldScrollRef.current = true;
          }
        }

        if (matches.length > 0) {
          setExpandedEpisodes(expandEpisodes);
          setExpandedTrajectories(expandTrajectories);
          setExpandedBatches(expandBatches);
        }
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : "Search failed");
        setSearchResults([]);
        setMatchLocations([]);
        setMatchedTerms([]);
      } finally {
        setSearchLoading(false);
      }
    };

    performSearch();
  }, [committedQuery, effectiveSessionId, selectedStep]);

  // Fetch trajectory groups when in groups view mode
  useEffect(() => {
    if (!effectiveSessionId || selectedStep === null) {
      return;
    }

    const fetchGroups = async () => {
      setGroupsLoading(true);
      setGroupsError(null);
      try {
        const groups = await fetchTrajectoryGroupsAPI(effectiveSessionId, selectedStep);
        setTrajectoryGroups(groups);
      } catch (err) {
        setGroupsError(err instanceof Error ? err.message : "Failed to fetch groups");
        setTrajectoryGroups([]);
      } finally {
        setGroupsLoading(false);
      }
    };

    fetchGroups();
  }, [effectiveSessionId, selectedStep]);

  // Group search effect
  useEffect(() => {
    if (!groupCommittedQuery.trim()) {
      setGroupSearchResults([]);
      setGroupSearchError(null);
      return;
    }

    if (!effectiveSessionId) {
      setGroupSearchError("No session ID available");
      return;
    }

    const performSearch = async () => {
      setGroupSearchLoading(true);
      setGroupSearchError(null);

      try {
        const response = await searchTrajectoryGroupsAPI(
          groupCommittedQuery,
          effectiveSessionId,
          50,
          selectedStep
        );
        setGroupSearchResults(response.groups || []);
      } catch (err) {
        setGroupSearchError(err instanceof Error ? err.message : "Search failed");
        setGroupSearchResults([]);
      } finally {
        setGroupSearchLoading(false);
      }
    };

    performSearch();
  }, [groupCommittedQuery, effectiveSessionId, selectedStep]);

  useEffect(() => {
    if (shouldScrollRef.current && currentMatchRef.current) {
      currentMatchRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      shouldScrollRef.current = false;
    }
  }, [currentMatchIndex, matchLocations]);

  // Click outside to close sort menu
  useEffect(() => {
    if (!sortMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sortMenuOpen]);

  // Click outside to close group sort menu
  useEffect(() => {
    if (!groupSortMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (groupSortMenuRef.current && !groupSortMenuRef.current.contains(e.target as Node)) {
        setGroupSortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [groupSortMenuOpen]);

  const navigateToNextMatch = useCallback(() => {
    if (matchLocations.length === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex((prev) => (prev + 1) % matchLocations.length);
  }, [matchLocations.length]);

  const navigateToPrevMatch = useCallback(() => {
    if (matchLocations.length === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex(
      (prev) => (prev - 1 + matchLocations.length) % matchLocations.length
    );
  }, [matchLocations.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (matchLocations.length > 0) {
        if (e.shiftKey) {
          navigateToPrevMatch();
        } else {
          navigateToNextMatch();
        }
      } else if (searchQuery.trim()) {
        setCommittedQuery(searchQuery);
      }
    }
  };

  const toggleEpisode = (episodeId: string) => {
    setExpandedEpisodes((prev) => {
      const next = new Set(prev);
      if (next.has(episodeId)) {
        next.delete(episodeId);
      } else {
        next.add(episodeId);
      }
      return next;
    });
  };

  const toggleTrajectory = (trajUid: string) => {
    setExpandedTrajectories((prev) => {
      const next = new Set(prev);
      if (next.has(trajUid)) {
        next.delete(trajUid);
      } else {
        next.add(trajUid);
      }
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const toggleBatch = (taskId: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const currentMatch = matchLocations[currentMatchIndex] || null;

  const displayEpisodes = committedQuery.trim()
    ? filteredEpisodes
    : filteredEpisodes;

  // Group episodes by task_id for batch view
  const episodeBatches = useMemo(() => {
    return groupEpisodesByTask(displayEpisodes);
  }, [displayEpisodes]);

  // Sort batches by solve rate
  const sortedBatches = useMemo(() => {
    if (sortMode === "default") return episodeBatches;
    return [...episodeBatches].sort((a, b) => {
      const rateA = a.totalCount > 0 ? a.correctCount / a.totalCount : 0;
      const rateB = b.totalCount > 0 ? b.correctCount / b.totalCount : 0;
      return sortMode === "solve-rate-desc" ? rateB - rateA : rateA - rateB;
    });
  }, [episodeBatches, sortMode]);

  // Groups: display groups (search results or all)
  const displayGroups = useMemo(() => {
    return groupCommittedQuery.trim() ? groupSearchResults : trajectoryGroups;
  }, [groupCommittedQuery, groupSearchResults, trajectoryGroups]);

  // Group trajectory groups by task_id
  const displayGroupBatches = useMemo(() => {
    return groupTrajectoryGroupsByTask(displayGroups);
  }, [displayGroups]);

  // Extract unique trajectory names for dynamic sort options
  const uniqueTrajectoryNames = useMemo(() => {
    const names = new Set<string>();
    for (const g of displayGroups) {
      if (g.trajectory_name) names.add(g.trajectory_name);
    }
    return Array.from(names).sort();
  }, [displayGroups]);

  // Sort group batches by the selected trajectory name's solve rate
  const sortedGroupBatches = useMemo(() => {
    if (groupSortMode === "default") return displayGroupBatches;

    // Parse sort mode: "{trajectoryName}-desc" or "{trajectoryName}-asc"
    const lastDash = groupSortMode.lastIndexOf("-");
    if (lastDash === -1) return displayGroupBatches;
    const trajName = groupSortMode.slice(0, lastDash);
    const direction = groupSortMode.slice(lastDash + 1); // "desc" or "asc"

    return [...displayGroupBatches].sort((a, b) => {
      const getRate = (batch: TaskGroupBatch) => {
        const matching = batch.groups.find(g => g.trajectory_name === trajName);
        if (!matching || matching.total_count === 0) return 0;
        return matching.correct_count / matching.total_count;
      };
      const rateA = getRate(a);
      const rateB = getRate(b);
      return direction === "desc" ? rateB - rateA : rateA - rateB;
    });
  }, [displayGroupBatches, groupSortMode]);

  const handleGroupKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && groupSearchQuery.trim()) {
      setGroupCommittedQuery(groupSearchQuery);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Content - Scrollable */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {viewMode === "groups" ? (
          // Groups View
          groupsLoading || groupSearchLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex flex-col items-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                <span className="text-sm text-gray-500">
                  {groupSearchLoading ? "Searching..." : "Loading groups..."}
                </span>
              </div>
            </div>
          ) : groupsError || groupSearchError ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">
                {groupSearchError ? "Search failed" : "Failed to load groups"}
              </p>
              <p className="text-sm text-gray-500 mt-1">{groupSearchError || groupsError}</p>
            </div>
          ) : selectedStep === null && !groupCommittedQuery.trim() ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">Select a data point</p>
            </div>
          ) : displayGroups.length === 0 && !groupCommittedQuery.trim() ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">
                No trajectory groups at step {selectedStep}
              </p>
            </div>
          ) : displayGroups.length === 0 && groupCommittedQuery.trim() ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <SearchIcon sx={{ fontSize: 24 }} className="text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-900">No matches found</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
                <div className="flex items-center flex-shrink-0">
                  <span className="text-sm font-medium text-gray-900">
                    {groupCommittedQuery.trim()
                      ? `${displayGroups.length} result${displayGroups.length !== 1 ? "s" : ""}`
                      : `Step ${selectedStep}`}
                  </span>
                  {!groupCommittedQuery.trim() && (
                    <span className="text-sm text-gray-500 ml-2">
                      · {sortedGroupBatches.length} task{sortedGroupBatches.length !== 1 ? "s" : ""} · {displayGroups.length} group{displayGroups.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <div className="flex-1 relative min-w-0">
                    <input
                      type="text"
                      placeholder="Search (Enter)..."
                      value={groupSearchQuery}
                      onChange={(e) => setGroupSearchQuery(e.target.value)}
                      onKeyDown={handleGroupKeyDown}
                      className="w-full pl-8 pr-8 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
                    />
                    <SearchIcon
                      sx={{ fontSize: 16 }}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    {(groupSearchQuery || groupCommittedQuery) && (
                      <button
                        onClick={() => {
                          setGroupSearchQuery("");
                          setGroupCommittedQuery("");
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        title="Clear search"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {/* Group sort menu */}
                  <div ref={groupSortMenuRef} className="relative flex-shrink-0">
                    <button
                      onClick={() => setGroupSortMenuOpen((prev) => !prev)}
                      className={`p-1 rounded transition-colors ${
                        groupSortMode !== "default"
                          ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                          : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                      }`}
                      title="Sort"
                    >
                      <SortIcon sx={{ fontSize: 16 }} />
                    </button>
                    {groupSortMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 w-44">
                        <button
                          onClick={() => { setGroupSortMode("default"); setGroupSortMenuOpen(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                            groupSortMode === "default" ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          Default
                        </button>
                        {uniqueTrajectoryNames.length > 0 && (
                          <div className="border-t border-gray-100 my-1" />
                        )}
                        {uniqueTrajectoryNames.map((name) => (
                          <React.Fragment key={name}>
                            <button
                              onClick={() => { setGroupSortMode(`${name}-desc`); setGroupSortMenuOpen(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                                groupSortMode === `${name}-desc` ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                              }`}
                            >
                              {name.charAt(0).toUpperCase() + name.slice(1)} (desc)
                            </button>
                            <button
                              onClick={() => { setGroupSortMode(`${name}-asc`); setGroupSortMenuOpen(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                                groupSortMode === `${name}-asc` ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                              }`}
                            >
                              {name.charAt(0).toUpperCase() + name.slice(1)} (asc)
                            </button>
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {sortedGroupBatches.map((batch) => (
                <TaskGroupBatchCard
                  key={batch.taskId}
                  batch={batch}
                  isExpanded={expandedBatches.has(batch.taskId)}
                  onToggle={() => toggleBatch(batch.taskId)}
                  expandedGroups={expandedGroups}
                  onGroupToggle={toggleGroup}
                  expandedTrajectories={expandedTrajectories}
                  onTrajectoryToggle={toggleTrajectory}
                />
              ))}
            </div>
          )
        ) : (
          // Episodes View
          loading || searchLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex flex-col items-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                {searchLoading && (
                  <span className="text-sm text-gray-500">Searching...</span>
                )}
              </div>
            </div>
          ) : searchError ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">Search failed</p>
            </div>
          ) : displayEpisodes.length === 0 && !committedQuery.trim() ? (
            selectedStep === null ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-900">Select a data point</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-900">
                  No episodes at step {selectedStep}
                </p>
              </div>
            )
          ) : displayEpisodes.length === 0 && committedQuery.trim() ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <SearchIcon sx={{ fontSize: 24 }} className="text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-900">No matches found</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {selectedStep !== null && (
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
                  <div className="flex items-center flex-shrink-0">
                    <span className="text-sm font-medium text-gray-900">
                      {committedQuery.trim()
                        ? `${displayEpisodes.length} result${displayEpisodes.length !== 1 ? "s" : ""}`
                        : `Step ${selectedStep}`}
                    </span>
                    {!committedQuery.trim() && (
                      <span className="text-sm text-gray-500 ml-2">
                        · {sortedBatches.length} task{sortedBatches.length !== 1 ? "s" : ""} · {displayEpisodes.length} episode{displayEpisodes.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {viewMode === "episodes" && (
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <div className="flex-1 relative min-w-0">
                        <input
                          type="text"
                          placeholder="Search (Enter)..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={handleKeyDown}
                          className="w-full pl-8 pr-8 py-1.5 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:border-gray-400"
                        />
                        <SearchIcon
                          sx={{ fontSize: 13 }}
                          className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
                        />
                        {(searchQuery || committedQuery) && (
                          <button
                            onClick={() => {
                              setSearchQuery("");
                              setCommittedQuery("");
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            title="Clear search"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                      {matchLocations.length > 0 && (
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            onClick={navigateToPrevMatch}
                            className="p-0.5 hover:bg-gray-100 rounded text-gray-500"
                            title="Previous match (Shift+Enter)"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                            </svg>
                          </button>
                          <button
                            onClick={navigateToNextMatch}
                            className="p-0.5 hover:bg-gray-100 rounded text-gray-500"
                            title="Next match (Enter)"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                          <span className="text-xs text-gray-500">
                            {currentMatchIndex + 1}/{matchLocations.length}
                          </span>
                        </div>
                      )}
                      {/* Sort menu */}
                      <div ref={sortMenuRef} className="relative flex-shrink-0">
                        <button
                          onClick={() => setSortMenuOpen((prev) => !prev)}
                          className={`p-1 rounded transition-colors ${
                            sortMode !== "default"
                              ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                              : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                          }`}
                          title="Sort"
                        >
                          <SortIcon sx={{ fontSize: 16 }} />
                        </button>
                        {sortMenuOpen && (
                          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 w-44">
                            <button
                              onClick={() => { setSortMode("default"); setSortMenuOpen(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                                sortMode === "default" ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                              }`}
                            >
                              Default
                            </button>
                            <button
                              onClick={() => { setSortMode("solve-rate-desc"); setSortMenuOpen(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                                sortMode === "solve-rate-desc" ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                              }`}
                            >
                              Solve rate (desc)
                            </button>
                            <button
                              onClick={() => { setSortMode("solve-rate-asc"); setSortMenuOpen(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                                sortMode === "solve-rate-asc" ? "text-blue-700 bg-blue-50" : "text-gray-700 hover:bg-gray-50"
                              }`}
                            >
                              Solve rate (asc)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {sortedBatches.map((batch) => (
                <EpisodeBatchCard
                  key={batch.taskId}
                  batch={batch}
                  isExpanded={expandedBatches.has(batch.taskId)}
                  onToggle={() => toggleBatch(batch.taskId)}
                  expandedEpisodes={expandedEpisodes}
                  onEpisodeToggle={toggleEpisode}
                  expandedTrajectories={expandedTrajectories}
                  onTrajectoryToggle={toggleTrajectory}
                  searchQuery={committedQuery}
                  searchTerms={matchedTerms}
                  currentMatch={currentMatch}
                  currentMatchRef={currentMatchRef}
                />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};

interface EpisodeCardProps {
  episode: Episode;
  isExpanded: boolean;
  onToggle: () => void;
  expandedTrajectories: Set<string>;
  onTrajectoryToggle: (uid: string) => void;
  searchQuery: string;
  searchTerms: string[];
  currentMatch: MatchLocation | null;
  currentMatchRef: React.RefObject<HTMLSpanElement>;
}

const EpisodeCard: React.FC<EpisodeCardProps> = ({
  episode,
  isExpanded,
  onToggle,
  expandedTrajectories,
  onTrajectoryToggle,
  searchQuery,
  searchTerms,
  currentMatch,
  currentMatchRef,
}) => {
  const trajectories = episode.trajectories || [];
  const isCurrentMatchInTask =
    currentMatch?.episodeId === episode.id && currentMatch?.field === "task";

  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        <div className="shrink-0">
          {isExpanded ? (
            <ChevronDownIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                episode.is_correct
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {episode.is_correct ? "correct" : "incorrect"}
            </span>
            <span className="text-sm text-gray-500">
              Step {episode.step}
            </span>
            <span className="text-sm text-gray-400">·</span>
            <span className="text-sm text-gray-500">
              r={episode.reward?.toFixed(3) ?? "N/A"}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1 font-mono">
            {episode.id}
          </p>
        </div>

        <span className="text-xs text-gray-400 shrink-0">
          {trajectories.length} traj
        </span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4">
          <div className="mt-2 p-3 bg-white rounded-lg border border-gray-200">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Task
            </p>
            <p className="text-sm text-gray-900">
              <HighlightedText
                text={getTaskSummary(episode.task)}
                searchQuery={searchQuery}
                searchTerms={searchTerms}
                isCurrentMatch={isCurrentMatchInTask}
                matchRef={isCurrentMatchInTask ? currentMatchRef : undefined}
              />
            </p>
          </div>

          {trajectories.map((trajectory, idx) => {
            const trajUid = trajectory.uid || `${episode.id}-${idx}`;
            return (
              <TrajectoryCard
                key={trajUid}
                trajectory={trajectory}
                index={idx}
                episodeId={episode.id}
                trajUid={trajUid}
                isExpanded={expandedTrajectories.has(trajUid)}
                onToggle={() => onTrajectoryToggle(trajUid)}
                searchQuery={searchQuery}
                searchTerms={searchTerms}
                currentMatch={currentMatch}
                currentMatchRef={currentMatchRef}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

// Episode Batch Card - Groups episodes by task_id
interface EpisodeBatchCardProps {
  batch: EpisodeBatch;
  isExpanded: boolean;
  onToggle: () => void;
  expandedEpisodes: Set<string>;
  onEpisodeToggle: (episodeId: string) => void;
  expandedTrajectories: Set<string>;
  onTrajectoryToggle: (uid: string) => void;
  searchQuery: string;
  searchTerms: string[];
  currentMatch: MatchLocation | null;
  currentMatchRef: React.RefObject<HTMLSpanElement>;
}

const EpisodeBatchCard: React.FC<EpisodeBatchCardProps> = ({
  batch,
  isExpanded,
  onToggle,
  expandedEpisodes,
  onEpisodeToggle,
  expandedTrajectories,
  onTrajectoryToggle,
  searchQuery,
  searchTerms,
  currentMatch,
  currentMatchRef,
}) => {
  const passRate = batch.totalCount > 0
    ? ((batch.correctCount / batch.totalCount) * 100).toFixed(0)
    : "N/A";

  return (
    <div className="border-b border-gray-200 last:border-b-0 bg-gray-50">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDownIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          )}
          <span className="text-sm font-medium text-gray-900 font-mono">
            {batch.taskId}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              batch.correctCount === batch.totalCount
                ? "bg-green-100 text-green-700"
                : batch.correctCount === 0
                ? "bg-red-100 text-red-700"
                : "bg-amber-100 text-amber-700"
            }`}
          >
            {passRate}% pass
          </span>
        </div>
        <span className="text-xs text-gray-400">
          {batch.totalCount} episode{batch.totalCount !== 1 ? "s" : ""}
        </span>
      </button>

      {isExpanded && (
        <div className="pl-6 border-l-2 border-gray-200 ml-4">
          {batch.episodes.map((episode) => (
            <EpisodeCard
              key={episode.id}
              episode={episode}
              isExpanded={expandedEpisodes.has(episode.id)}
              onToggle={() => onEpisodeToggle(episode.id)}
              expandedTrajectories={expandedTrajectories}
              onTrajectoryToggle={onTrajectoryToggle}
              searchQuery={searchQuery}
              searchTerms={searchTerms}
              currentMatch={currentMatch}
              currentMatchRef={currentMatchRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Task Group Batch Card - Groups trajectory groups by task_id
interface TaskGroupBatchCardProps {
  batch: TaskGroupBatch;
  isExpanded: boolean;
  onToggle: () => void;
  expandedGroups: Set<string>;
  onGroupToggle: (groupId: string) => void;
  expandedTrajectories: Set<string>;
  onTrajectoryToggle: (uid: string) => void;
}

const TaskGroupBatchCard: React.FC<TaskGroupBatchCardProps> = ({
  batch,
  isExpanded,
  onToggle,
  expandedGroups,
  onGroupToggle,
  expandedTrajectories,
  onTrajectoryToggle,
}) => {
  return (
    <div className="border-b border-gray-200 last:border-b-0 bg-gray-50">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDownIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          )}
          <span className="text-sm font-medium text-gray-900 font-mono">
            {batch.taskId}
          </span>
          {batch.avgReward !== null && (
            <span className="text-sm text-gray-500">
              avg r={batch.avgReward.toFixed(3)}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-400">
          {batch.groups.length} group{batch.groups.length !== 1 ? "s" : ""} · {batch.totalTrajectories} traj
        </span>
      </button>

      {isExpanded && (
        <div className="pl-6 border-l-2 border-gray-200 ml-4">
          {batch.groups.map((group) => (
            <TrajectoryGroupCard
              key={group.id}
              group={group}
              isExpanded={expandedGroups.has(group.id)}
              onToggle={() => onGroupToggle(group.id)}
              expandedTrajectories={expandedTrajectories}
              onTrajectoryToggle={onTrajectoryToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface TrajectoryCardProps {
  trajectory: Trajectory;
  index: number;
  episodeId: string;
  trajUid: string;
  isExpanded: boolean;
  onToggle: () => void;
  searchQuery: string;
  searchTerms: string[];
  currentMatch: MatchLocation | null;
  currentMatchRef: React.RefObject<HTMLSpanElement>;
}

const TrajectoryCard: React.FC<TrajectoryCardProps> = ({
  trajectory,
  index,
  episodeId,
  trajUid,
  isExpanded,
  onToggle,
  searchQuery,
  searchTerms,
  currentMatch,
  currentMatchRef,
}) => {
  return (
    <div className="mt-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDownIcon sx={{ fontSize: 14 }} className="text-gray-400" />
        ) : (
          <ChevronRightIcon sx={{ fontSize: 14 }} className="text-gray-400" />
        )}
        <span className="text-sm font-medium text-gray-700 capitalize">
          {trajectory.name || `Trajectory ${index + 1}`}
        </span>
        <span className="text-sm text-gray-500">
          {trajectory.steps?.length || 0} steps
        </span>
        <span className="text-sm text-gray-500 ml-auto">
          r={trajectory.reward?.toFixed(3) ?? "N/A"}
        </span>
      </button>

      {isExpanded && trajectory.steps && (
        <div className="border-t border-gray-100">
          {trajectory.steps.map((step, stepIdx) => (
            <StepView
              key={stepIdx}
              step={step}
              index={stepIdx}
              episodeId={episodeId}
              trajUid={trajUid}
              searchQuery={searchQuery}
              searchTerms={searchTerms}
              currentMatch={currentMatch}
              currentMatchRef={currentMatchRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface StepViewProps {
  step: TrajectoryStep;
  index: number;
  episodeId: string;
  trajUid: string;
  searchQuery: string;
  searchTerms: string[];
  currentMatch: MatchLocation | null;
  currentMatchRef: React.RefObject<HTMLSpanElement>;
}

const StepView: React.FC<StepViewProps> = ({
  step,
  index,
  episodeId,
  trajUid,
  searchQuery,
  searchTerms,
  currentMatch,
  currentMatchRef,
}) => {
  const visibleFields = getVisibleFields(step);

  const isCurrentMatch = (fieldKey: string) =>
    currentMatch?.episodeId === episodeId &&
    currentMatch?.trajectoryUid === trajUid &&
    currentMatch?.stepIndex === index &&
    currentMatch?.field === fieldKey;

  return (
    <div className={`px-3 py-3 ${index > 0 ? "border-t border-gray-100" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">
          Step {index + 1}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">
            r={step.reward?.toFixed(3) ?? "0"}
          </span>
          {step.done && (
            <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
              done
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {visibleFields.map(({ key, value }) => {
          const fieldConfig = getFieldConfig(key, value);
          const fieldContent = formatFieldValue(value);
          const isCurrent = isCurrentMatch(key);

          return (
            <div key={key}>
              <p className={`text-xs font-medium ${fieldConfig.labelColor} mb-1`}>
                {fieldConfig.label}
              </p>
              <div
                className={`${fieldConfig.bgColor} rounded-md border ${fieldConfig.borderColor} p-2 text-sm text-gray-800 whitespace-pre-wrap break-words ${fieldConfig.maxHeight} overflow-y-auto`}
              >
                <HighlightedText
                  text={fieldContent}
                  searchQuery={searchQuery}
                  searchTerms={searchTerms}
                  isCurrentMatch={isCurrent}
                  matchRef={isCurrent ? currentMatchRef : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Trajectory Group Card Component
interface TrajectoryGroupCardProps {
  group: TrajectoryGroup;
  isExpanded: boolean;
  onToggle: () => void;
  expandedTrajectories: Set<string>;
  onTrajectoryToggle: (uid: string) => void;
}

const TrajectoryGroupCard: React.FC<TrajectoryGroupCardProps> = ({
  group,
  isExpanded,
  onToggle,
  expandedTrajectories,
  onTrajectoryToggle,
}) => {
  // State for fetching full trajectory data on demand
  const [fullGroupData, setFullGroupData] = useState<TrajectoryGroup | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch full data when expanded (if not already loaded)
  useEffect(() => {
    if (isExpanded && !fullGroupData && !isLoading && !group.data?.trajectories?.length) {
      setIsLoading(true);
      setLoadError(null);
      fetchTrajectoryGroupAPI(group.id, true)
        .then((data) => {
          setFullGroupData(data);
          setIsLoading(false);
        })
        .catch((err) => {
          setLoadError(err.message);
          setIsLoading(false);
        });
    }
  }, [isExpanded, fullGroupData, isLoading, group.id, group.data?.trajectories?.length]);

  // Use full data if loaded, otherwise fall back to group data
  const effectiveGroup = fullGroupData || group;
  const trajectories = effectiveGroup.data?.trajectories || [];
  // Metadata is now at top level (always present), with fallback to data.metadata for backwards compatibility
  const metadata = effectiveGroup.metadata || effectiveGroup.data?.metadata || [];
  const passRate = group.total_count > 0
    ? ((group.correct_count / group.total_count) * 100).toFixed(0)
    : "N/A";

  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        <div className="shrink-0">
          {isExpanded ? (
            <ChevronDownIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} className="text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900 capitalize">
              {group.trajectory_name || "unnamed"}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                group.correct_count === group.total_count
                  ? "bg-green-100 text-green-700"
                  : group.correct_count === 0
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {passRate}% pass
            </span>
            <span className="text-sm text-gray-500">
              {group.num_trajectories} traj
            </span>
            {group.avg_reward !== null && (
              <>
                <span className="text-sm text-gray-400">·</span>
                <span className="text-sm text-gray-500">
                  avg r={group.avg_reward.toFixed(3)}
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1 font-mono">
            {group.group_id}
          </p>
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4">
          {/* Loading state */}
          {isLoading && (
            <p className="text-sm text-gray-500 py-2">Loading trajectories...</p>
          )}
          {/* Error state */}
          {loadError && (
            <p className="text-sm text-red-500 py-2">Error: {loadError}</p>
          )}
          {/* Trajectories */}
          {!isLoading && trajectories.map((trajectory, idx) => {
            const trajUid = trajectory.uid || `${group.id}-${idx}`;
            const meta = metadata[idx];
            return (
              <GroupTrajectoryCard
                key={trajUid}
                trajectory={trajectory}
                index={idx}
                metadata={meta}
                isExpanded={expandedTrajectories.has(trajUid)}
                onToggle={() => onTrajectoryToggle(trajUid)}
              />
            );
          })}
          {/* No trajectories message */}
          {!isLoading && !loadError && trajectories.length === 0 && (
            <p className="text-sm text-gray-500 py-2">No trajectories available</p>
          )}
        </div>
      )}
    </div>
  );
};

// Trajectory card within a group (simplified version without search)
interface GroupTrajectoryCardProps {
  trajectory: Trajectory;
  index: number;
  metadata?: TrajectoryGroupMetadata;
  isExpanded: boolean;
  onToggle: () => void;
}

const GroupTrajectoryCard: React.FC<GroupTrajectoryCardProps> = ({
  trajectory,
  index,
  metadata,
  isExpanded,
  onToggle,
}) => {
  return (
    <div className="mt-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDownIcon sx={{ fontSize: 14 }} className="text-gray-400" />
        ) : (
          <ChevronRightIcon sx={{ fontSize: 14 }} className="text-gray-400" />
        )}
        <span className="text-sm font-medium text-gray-700">
          Trajectory {index + 1}
        </span>
        {metadata && (
          <span className="text-xs text-gray-400 font-mono">
            {metadata.episode_id}
          </span>
        )}
        <span className="text-sm text-gray-500">
          {trajectory.steps?.length || 0} steps
        </span>
        <span className="text-sm text-gray-500 ml-auto">
          r={trajectory.reward?.toFixed(3) ?? "N/A"}
        </span>
      </button>

      {isExpanded && trajectory.steps && (
        <div className="border-t border-gray-100">
          {trajectory.steps.map((step, stepIdx) => (
            <GroupStepView key={stepIdx} step={step} index={stepIdx} />
          ))}
        </div>
      )}
    </div>
  );
};

// Simplified step view for group trajectories (without search highlighting)
interface GroupStepViewProps {
  step: TrajectoryStep;
  index: number;
}

const GroupStepView: React.FC<GroupStepViewProps> = ({ step, index }) => {
  const visibleFields = getVisibleFields(step);

  return (
    <div className={`px-3 py-3 ${index > 0 ? "border-t border-gray-100" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">
          Step {index + 1}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">
            r={step.reward?.toFixed(3) ?? "0"}
          </span>
          {step.done && (
            <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
              done
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {visibleFields.map(({ key, value }) => {
          const fieldConfig = getFieldConfig(key, value);
          const fieldContent = formatFieldValue(value);

          return (
            <div key={key}>
              <p className={`text-xs font-medium ${fieldConfig.labelColor} mb-1`}>
                {fieldConfig.label}
              </p>
              <div
                className={`${fieldConfig.bgColor} rounded-md border ${fieldConfig.borderColor} p-2 text-sm text-gray-800 whitespace-pre-wrap break-words ${fieldConfig.maxHeight} overflow-y-auto`}
              >
                {fieldContent}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const HIDDEN_FIELDS = new Set([
  "prompt_ids",
  "response_ids",
  "logprobs",
  "mc_return",
  "advantage",
  "reward",
  "done",
]);

function getVisibleFields(
  step: TrajectoryStep
): Array<{ key: string; value: any }> {
  const fields: Array<{ key: string; value: any }> = [];

  const fieldOrder = [
    "observation",
    "thought",
    "model_response",
    "action",
    "chat_completions",
    "info",
  ];

  fieldOrder.forEach((key) => {
    if (step[key] != null && !HIDDEN_FIELDS.has(key)) {
      fields.push({ key, value: step[key] });
    }
  });

  Object.keys(step).forEach((key) => {
    if (
      step[key] != null &&
      !HIDDEN_FIELDS.has(key) &&
      !fieldOrder.includes(key)
    ) {
      fields.push({ key, value: step[key] });
    }
  });

  return fields;
}

function getFieldConfig(
  key: string,
  _value: any
): {
  label: string;
  labelColor: string;
  bgColor: string;
  borderColor: string;
  maxHeight: string;
} {
  const configs: Record<string, any> = {
    observation: {
      label: "Observation",
      labelColor: "text-blue-600",
      bgColor: "bg-blue-50",
      borderColor: "border-blue-100",
      maxHeight: "max-h-32",
    },
    thought: {
      label: "Thought",
      labelColor: "text-amber-600",
      bgColor: "bg-amber-50",
      borderColor: "border-amber-100",
      maxHeight: "max-h-32",
    },
    model_response: {
      label: "Response",
      labelColor: "text-purple-600",
      bgColor: "bg-purple-50",
      borderColor: "border-purple-100",
      maxHeight: "max-h-48",
    },
    action: {
      label: "Action",
      labelColor: "text-green-600",
      bgColor: "bg-green-50",
      borderColor: "border-green-100",
      maxHeight: "max-h-32",
    },
    chat_completions: {
      label: "Chat Completions",
      labelColor: "text-indigo-600",
      bgColor: "bg-indigo-50",
      borderColor: "border-indigo-100",
      maxHeight: "max-h-48",
    },
    info: {
      label: "Info",
      labelColor: "text-gray-600",
      bgColor: "bg-gray-50",
      borderColor: "border-gray-200",
      maxHeight: "max-h-32",
    },
  };

  return configs[key] || {
    label: formatFieldLabel(key),
    labelColor: "text-gray-600",
    bgColor: "bg-gray-50",
    borderColor: "border-gray-200",
    maxHeight: "max-h-32",
  };
}

function formatFieldLabel(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatFieldValue(value: any): string {
  if (value === null || value === undefined) {
    return "N/A";
  }

  if (Array.isArray(value) && value.length > 0 && value[0]?.role) {
    return value
      .map((msg: any) => {
        const role = msg.role || "unknown";
        const content = msg.content || "";
        return `[${role.toUpperCase()}]: ${content}`;
      })
      .join("\n\n");
  }

  if (typeof value === "object" && value.tool_calls) {
    const parts: string[] = [];

    if (value.tool_calls && Array.isArray(value.tool_calls)) {
      parts.push("Tool Calls:");
      value.tool_calls.forEach((call: any, idx: number) => {
        parts.push(`\n${idx + 1}. ${call.function?.name || "unknown"}`);
        if (call.function?.arguments) {
          parts.push(`   Args: ${call.function.arguments}`);
        }
      });
    }

    const otherKeys = Object.keys(value).filter((k) => k !== "tool_calls");
    if (otherKeys.length > 0) {
      parts.push("\n\nOther:");
      otherKeys.forEach((k) => {
        parts.push(`${k}: ${formatContent(value[k])}`);
      });
    }

    return parts.join("\n");
  }

  return formatContent(value);
}

function getTaskSummary(task: Record<string, any>): string {
  if (task.question) return task.question;
  if (task.problem) return task.problem;
  if (task.prompt) return task.prompt;
  if (task.input) return task.input;
  if (task.text) return task.text;

  const jsonStr = JSON.stringify(task);
  return jsonStr.length > 200 ? jsonStr.slice(0, 200) + "..." : jsonStr;
}

function formatContent(content: any): string {
  if (content === null || content === undefined) {
    return "N/A";
  }
  if (typeof content === "string") {
    return content;
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
