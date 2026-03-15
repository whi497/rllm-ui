"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  SearchIcon,
  SortIcon,
  CheckIcon,
  CloseIcon,
} from "./icons";
import { Spinner, EmptyState, CollapsibleSection, useClickOutside, ThreeDotMenu } from "./ui";
import { HighlightedText, textContains } from "./HighlightedText";
import SearchBar from "./SearchBar";
import { apiFetch } from "../config/api";

interface TrajectoryStep {
  // eval fields (types.Step)
  input?: any;
  output?: any;
  metadata?: Record<string, any>;
  // training fields (agents.AgentStep)
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
  task?: Record<string, any>;
  reward: number;
  info?: Record<string, any>;
  input?: Record<string, any>;
  output?: any;
  signals?: Record<string, number>;
  metadata?: Record<string, any>;
  steps: TrajectoryStep[];
}

interface Episode {
  id: string;
  session_id: string;
  step: number;
  task: Record<string, any>;
  is_correct: boolean;
  termination_reason: string | null;
  trajectories: Trajectory[];
  metrics?: Record<string, any>;
  info?: Record<string, any>;
  metadata?: Record<string, any>;
  artifacts?: Record<string, any>;
  created_at: string;
}

interface MatchLocation {
  episodeId: string;
  trajectoryUid: string;
  stepIndex: number;
  field: string;
}

interface GroupMatchLocation {
  groupId: string;
  trajectoryIndex: number;
  stepIndex: number;
  field: string;
}

interface EpisodePanelProps {
  selectedStep: number | null;
  sessionId?: string;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  hideStepLabel?: boolean;
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
  metadata: TrajectoryGroupMetadata[]; // Now at top level (always present)
  data: {
    // Optional - only populated when full trajectory data is fetched
    trajectories: Trajectory[];
    metadata: TrajectoryGroupMetadata[];
  } | null;
  created_at: string;
}

type ViewMode = "episodes" | "groups";

const searchEpisodesAPI = async (
  query: string,
  sessionId: string,
  step?: number | null,
): Promise<SearchResponse> => {
  const params = new URLSearchParams({
    q: query,
    session_id: sessionId,
  });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await apiFetch(`/api/episodes/search?${params}`);
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
};

const fetchTrajectoryGroupsAPI = async (
  sessionId: string,
  step?: number | null,
): Promise<TrajectoryGroup[]> => {
  const params = new URLSearchParams({ session_id: sessionId });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await apiFetch(
    `/api/trajectory-groups?${params}`,
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
  step?: number | null,
): Promise<TrajectoryGroupSearchResponse> => {
  const params = new URLSearchParams({
    q: query,
    session_id: sessionId,
  });
  if (step !== null && step !== undefined) {
    params.set("step", String(step));
  }
  const response = await apiFetch(
    `/api/trajectory-groups/search?${params}`,
  );
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
};

// Fetch a single trajectory group with full trajectory data
const fetchTrajectoryGroupAPI = async (
  groupId: string,
  includeTrajectories: boolean = true,
): Promise<TrajectoryGroup> => {
  const params = new URLSearchParams({
    include_trajectories: String(includeTrajectories),
  });
  const response = await apiFetch(
    `/api/trajectory-groups/${groupId}?${params}`,
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
    correctCount: eps.filter((e) => e.is_correct).length,
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

const groupTrajectoryGroupsByTask = (
  groups: TrajectoryGroup[],
  taskCounts: Map<string, { correct: number; total: number }>,
): TaskGroupBatch[] => {
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
    const rewards = grps
      .filter((g) => g.avg_reward !== null)
      .map((g) => g.avg_reward!);
    const avgReward =
      rewards.length > 0
        ? rewards.reduce((a, b) => a + b, 0) / rewards.length
        : null;
    const counts = taskCounts.get(taskId);
    return {
      taskId,
      groups: grps,
      totalTrajectories: totalTrajs,
      avgReward,
      correctCount: counts?.correct ?? 0,
      totalCount: counts?.total ?? 0,
    };
  });
};

export const EpisodePanel: React.FC<EpisodePanelProps> = ({
  selectedStep,
  sessionId,
  viewMode: externalViewMode,
  hideStepLabel = false,
}) => {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [expandedEpisodes, setExpandedEpisodes] = useState<Set<string>>(
    new Set(),
  );
  const [expandedTrajectories, setExpandedTrajectories] = useState<Set<string>>(
    new Set(),
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
  const [trajectoryGroups, setTrajectoryGroups] = useState<TrajectoryGroup[]>(
    [],
  );
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Batch grouping state
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(
    new Set(),
  );

  // Sort state (episodes)
  const [sortMode, setSortMode] = useState<
    "default" | "solve-rate-desc" | "solve-rate-asc"
  >("default");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // Group search state
  const [groupSearchQuery, setGroupSearchQuery] = useState("");
  const [groupCommittedQuery, setGroupCommittedQuery] = useState("");
  const [groupSearchResults, setGroupSearchResults] = useState<
    TrajectoryGroup[]
  >([]);
  const [groupSearchLoading, setGroupSearchLoading] = useState(false);
  const [groupSearchError, setGroupSearchError] = useState<string | null>(null);
  const [groupMatchedTerms, setGroupMatchedTerms] = useState<string[]>([]);
  const [groupMatchLocations, setGroupMatchLocations] = useState<GroupMatchLocation[]>([]);
  const [currentGroupMatchIndex, setCurrentGroupMatchIndex] = useState(0);
  const [preloadedGroupData, setPreloadedGroupData] = useState<Map<string, TrajectoryGroup>>(new Map());

  // Group sort state
  const [groupSortMode, setGroupSortMode] = useState("default");
  const [groupSortMenuOpen, setGroupSortMenuOpen] = useState(false);
  const groupSortMenuRef = useRef<HTMLDivElement>(null);

  const currentMatchRef = useRef<HTMLSpanElement>(null);
  const prevDebouncedQuery = useRef("");
  const shouldScrollRef = useRef(false);

  const currentGroupMatchRef = useRef<HTMLSpanElement>(null);
  const prevGroupDebouncedQuery = useRef("");
  const shouldGroupScrollRef = useRef(false);

  const effectiveSessionId = sessionId;

  // Fetch episodes per-step (mirrors trajectory groups pattern)
  useEffect(() => {
    if (!effectiveSessionId || selectedStep === null) {
      setEpisodes([]);
      return;
    }

    const fetchEpisodes = async () => {
      setEpisodesLoading(true);
      setEpisodesError(null);
      try {
        const params = new URLSearchParams({
          session_id: effectiveSessionId,
          step: String(selectedStep),
        });
        const response = await apiFetch(`/api/episodes?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setEpisodes(data);
      } catch (err) {
        setEpisodesError(err instanceof Error ? err.message : "Failed to fetch episodes");
        setEpisodes([]);
      } finally {
        setEpisodesLoading(false);
      }
    };

    fetchEpisodes();
  }, [effectiveSessionId, selectedStep]);

  const filteredEpisodes = useMemo(() => {
    if (committedQuery.trim()) {
      return searchResults;
    }
    return episodes; // already filtered by step from the API
  }, [episodes, committedQuery, searchResults]);

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
          selectedStep,
        );
        const { episodes: results = [], matched_terms: terms = [] } = response;
        setSearchResults(results);
        setMatchedTerms(terms);

        const matches: MatchLocation[] = [];
        const expandEpisodes = new Set<string>();
        const expandTrajectories = new Set<string>();
        const expandBatches = new Set<string>();
        const taskMatchAdded = new Set<string>(); // one task match per batch

        results.forEach((episode) => {
          const taskId = getTaskId(episode.id);
          const taskText = getTaskSummary(episode.task);
          if (textContains(taskText, committedQuery, terms) && !taskMatchAdded.has(taskId)) {
            matches.push({
              episodeId: episode.id,
              trajectoryUid: "",
              stepIndex: -1,
              field: "task",
            });
            taskMatchAdded.add(taskId);
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
        const groups = await fetchTrajectoryGroupsAPI(
          effectiveSessionId,
          selectedStep,
        );
        setTrajectoryGroups(groups);
      } catch (err) {
        setGroupsError(
          err instanceof Error ? err.message : "Failed to fetch groups",
        );
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
      setGroupMatchedTerms([]);
      setGroupMatchLocations([]);
      setPreloadedGroupData(new Map());
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
          selectedStep,
        );
        const groups = response.groups || [];
        const terms = response.matched_terms || [];
        setGroupSearchResults(groups);
        setGroupMatchedTerms(terms);

        // Fetch full trajectory data for all matched groups in parallel
        const fullDataMap = new Map<string, TrajectoryGroup>();
        const fullGroups = await Promise.all(
          groups.map((g) =>
            fetchTrajectoryGroupAPI(g.id, true).catch(() => null),
          ),
        );
        fullGroups.forEach((fullGroup, idx) => {
          if (fullGroup) {
            fullDataMap.set(groups[idx].id, fullGroup);
          }
        });
        setPreloadedGroupData(fullDataMap);

        // Scan for field-level matches
        const matches: GroupMatchLocation[] = [];
        const expandBatchIds = new Set<string>();
        const expandGroupIds = new Set<string>();

        for (const group of groups) {
          const fullGroup = fullDataMap.get(group.id);
          const trajectories = fullGroup?.data?.trajectories || [];

          expandBatchIds.add(group.task_id);
          expandGroupIds.add(group.id);

          trajectories.forEach((trajectory, trajIdx) => {
            trajectory.steps?.forEach((step, stepIdx) => {
              const visibleFields = getVisibleFields(step);
              visibleFields.forEach(({ key, value }) => {
                const fieldText = formatFieldValue(value);
                if (textContains(fieldText, groupCommittedQuery, terms)) {
                  matches.push({
                    groupId: group.id,
                    trajectoryIndex: trajIdx,
                    stepIndex: stepIdx,
                    field: key,
                  });
                }
              });
            });
          });
        }

        setGroupMatchLocations(matches);
        setExpandedBatches(expandBatchIds);
        setExpandedGroups(expandGroupIds);

        if (prevGroupDebouncedQuery.current !== groupCommittedQuery) {
          setCurrentGroupMatchIndex(0);
          prevGroupDebouncedQuery.current = groupCommittedQuery;
          if (matches.length > 0) {
            shouldGroupScrollRef.current = true;
          }
        }
      } catch (err) {
        setGroupSearchError(
          err instanceof Error ? err.message : "Search failed",
        );
        setGroupSearchResults([]);
        setGroupMatchedTerms([]);
        setGroupMatchLocations([]);
        setPreloadedGroupData(new Map());
      } finally {
        setGroupSearchLoading(false);
      }
    };

    performSearch();
  }, [groupCommittedQuery, effectiveSessionId, selectedStep]);

  useEffect(() => {
    if (shouldScrollRef.current && matchLocations.length > 0) {
      // Defer scroll by one frame to ensure expanded content is rendered in the DOM
      const rafId = requestAnimationFrame(() => {
        if (currentMatchRef.current) {
          currentMatchRef.current.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
        shouldScrollRef.current = false;
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [currentMatchIndex, matchLocations]);

  // Group match scroll effect — double rAF to ensure deeply nested expanded content is fully rendered
  useEffect(() => {
    if (shouldGroupScrollRef.current && groupMatchLocations.length > 0) {
      let innerRafId: number;
      const outerRafId = requestAnimationFrame(() => {
        innerRafId = requestAnimationFrame(() => {
          if (currentGroupMatchRef.current) {
            currentGroupMatchRef.current.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }
          shouldGroupScrollRef.current = false;
        });
      });
      return () => {
        cancelAnimationFrame(outerRafId);
        cancelAnimationFrame(innerRafId);
      };
    }
  }, [currentGroupMatchIndex, groupMatchLocations]);

  useClickOutside(sortMenuRef, () => setSortMenuOpen(false), sortMenuOpen);
  useClickOutside(groupSortMenuRef, () => setGroupSortMenuOpen(false), groupSortMenuOpen);

  const navigateToNextMatch = useCallback(() => {
    if (matchLocations.length === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex((prev) => (prev + 1) % matchLocations.length);
  }, [matchLocations.length]);

  const navigateToPrevMatch = useCallback(() => {
    if (matchLocations.length === 0) return;
    shouldScrollRef.current = true;
    setCurrentMatchIndex(
      (prev) => (prev - 1 + matchLocations.length) % matchLocations.length,
    );
  }, [matchLocations.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (searchQuery.trim() && searchQuery !== committedQuery) {
        // New or changed query — commit it
        setCommittedQuery(searchQuery);
      } else if (matchLocations.length > 0) {
        // Same query — navigate matches
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
  const currentGroupMatch = groupMatchLocations[currentGroupMatchIndex] || null;

  const displayEpisodes = committedQuery.trim()
    ? filteredEpisodes
    : filteredEpisodes;

  // Group episodes by task_id for batch view
  const episodeBatches = useMemo(() => {
    return groupEpisodesByTask(displayEpisodes);
  }, [displayEpisodes]);

  // Sort batches by correct rate
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

  // Stable task-level episode counts (avoids re-render cascade from SSE episode refetches)
  const taskEpisodeCounts = useMemo(() => {
    const counts = new Map<string, { correct: number; total: number }>();
    for (const ep of filteredEpisodes) {
      const taskId = getTaskId(ep.id);
      let entry = counts.get(taskId);
      if (!entry) {
        entry = { correct: 0, total: 0 };
        counts.set(taskId, entry);
      }
      entry.total++;
      if (ep.is_correct) entry.correct++;
    }
    return counts;
  }, [filteredEpisodes]);

  // Map taskId → task summary text (from episodes, for use in group view)
  const taskTextByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    for (const ep of filteredEpisodes) {
      const taskId = getTaskId(ep.id);
      if (!map.has(taskId) && ep.task) {
        map.set(taskId, getTaskSummary(ep.task));
      }
    }
    return map;
  }, [filteredEpisodes]);

  // Group trajectory groups by task_id
  const displayGroupBatches = useMemo(() => {
    return groupTrajectoryGroupsByTask(displayGroups, taskEpisodeCounts);
  }, [displayGroups, taskEpisodeCounts]);

  // Extract unique trajectory names for dynamic sort options
  const uniqueTrajectoryNames = useMemo(() => {
    const names = new Set<string>();
    for (const g of displayGroups) {
      if (g.trajectory_name) names.add(g.trajectory_name);
    }
    return Array.from(names).sort();
  }, [displayGroups]);

  // Sort group batches by the selected trajectory name's avg reward
  const sortedGroupBatches = useMemo(() => {
    if (groupSortMode === "default") return displayGroupBatches;

    // Parse sort mode: "{trajectoryName}-desc" or "{trajectoryName}-asc"
    const lastDash = groupSortMode.lastIndexOf("-");
    if (lastDash === -1) return displayGroupBatches;
    const trajName = groupSortMode.slice(0, lastDash);
    const direction = groupSortMode.slice(lastDash + 1); // "desc" or "asc"

    return [...displayGroupBatches].sort((a, b) => {
      const getReward = (batch: TaskGroupBatch) => {
        const matching = batch.groups.find(
          (g) => g.trajectory_name === trajName,
        );
        return matching?.avg_reward ?? 0;
      };
      const rewardA = getReward(a);
      const rewardB = getReward(b);
      return direction === "desc" ? rewardB - rewardA : rewardA - rewardB;
    });
  }, [displayGroupBatches, groupSortMode]);

  const episodeSortOptions: SortOption[] = useMemo(() => [
    { value: "default", label: "Default" },
    { value: "solve-rate-desc", label: "Correct rate (desc)" },
    { value: "solve-rate-asc", label: "Correct rate (asc)" },
  ], []);

  const groupSortOptions: SortOption[] = useMemo(() => [
    { value: "default", label: "Default" },
    ...uniqueTrajectoryNames.flatMap((name) => [
      { value: `${name}-desc`, label: `${name.charAt(0).toUpperCase() + name.slice(1)} avg reward (desc)` },
      { value: `${name}-asc`, label: `${name.charAt(0).toUpperCase() + name.slice(1)} avg reward (asc)` },
    ]),
  ], [uniqueTrajectoryNames]);

  const navigateToNextGroupMatch = useCallback(() => {
    if (groupMatchLocations.length === 0) return;
    shouldGroupScrollRef.current = true;
    setCurrentGroupMatchIndex((prev) => (prev + 1) % groupMatchLocations.length);
  }, [groupMatchLocations.length]);

  const navigateToPrevGroupMatch = useCallback(() => {
    if (groupMatchLocations.length === 0) return;
    shouldGroupScrollRef.current = true;
    setCurrentGroupMatchIndex(
      (prev) => (prev - 1 + groupMatchLocations.length) % groupMatchLocations.length,
    );
  }, [groupMatchLocations.length]);

  const handleGroupKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (groupSearchQuery.trim() && groupSearchQuery !== groupCommittedQuery) {
        setGroupCommittedQuery(groupSearchQuery);
      } else if (groupMatchLocations.length > 0) {
        if (e.shiftKey) {
          navigateToPrevGroupMatch();
        } else {
          navigateToNextGroupMatch();
        }
      } else if (groupSearchQuery.trim()) {
        setGroupCommittedQuery(groupSearchQuery);
      }
    }
  };

  // Expand / Collapse all — Episodes (expand batches + episodes, but not trajectories)
  const expandAllEpisodes = useCallback(() => {
    setExpandedBatches(new Set(sortedBatches.map((b) => b.taskId)));
    setExpandedEpisodes(new Set(displayEpisodes.map((e) => e.id)));
  }, [sortedBatches, displayEpisodes]);

  const collapseAllEpisodes = useCallback(() => {
    setExpandedBatches(new Set());
    setExpandedEpisodes(new Set());
    setExpandedTrajectories(new Set());
  }, []);

  // Expand / Collapse all — Groups (expand batches + groups, but not trajectories)
  const expandAllGroups = useCallback(() => {
    setExpandedBatches(new Set(sortedGroupBatches.map((b) => b.taskId)));
    setExpandedGroups(new Set(displayGroups.map((g) => g.id)));
  }, [sortedGroupBatches, displayGroups]);

  const collapseAllGroups = useCallback(() => {
    setExpandedBatches(new Set());
    setExpandedGroups(new Set());
    setExpandedTrajectories(new Set());
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Content - Scrollable */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {viewMode === "groups" ? (
          // Groups View
          groupsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="sm" variant="blue" label="Loading groups..." />
            </div>
          ) : groupsError ? (
            <EmptyState
              icon={
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              }
              title="Failed to load groups"
              description={groupsError}
              iconSize="sm"
              iconBg="bg-red-50"
              className="py-12 px-4"
            />
          ) : selectedStep === null && !groupCommittedQuery.trim() ? (
            <EmptyState
              icon={
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              }
              title="Select a data point"
              className="py-12 px-4"
            />
          ) : displayGroups.length === 0 && !groupCommittedQuery.trim() ? (
            <EmptyState
              icon={
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              }
              title={`No trajectory groups at step ${selectedStep}`}
              className="py-12 px-4"
            />
          ) : (
            <div className="divide-y divide-gray-100">
              <div className="px-4 py-2.5 bg-layer-1 border-b border-gray-200 flex items-center gap-3 sticky top-0 z-10">
                <div className="flex flex-col flex-shrink-0">
                  <span className="text-sm font-medium text-gray-900">
                    {groupCommittedQuery.trim()
                      ? `${displayGroups.length} result${displayGroups.length !== 1 ? "s" : ""}`
                      : `Step ${selectedStep}`}
                  </span>
                  {!groupCommittedQuery.trim() && (
                    <span className="text-[11px] leading-tight text-gray-400">
                      {sortedGroupBatches.length} task
                      {sortedGroupBatches.length !== 1 ? "s" : ""} · {displayGroups.length} group
                      {displayGroups.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <SearchBar
                  query={groupSearchQuery}
                  onQueryChange={setGroupSearchQuery}
                  onKeyDown={handleGroupKeyDown}
                  onClear={() => { setGroupSearchQuery(""); setGroupCommittedQuery(""); }}
                  showClear={!!(groupSearchQuery || groupCommittedQuery)}
                  matchCount={groupMatchLocations.length}
                  currentMatchIndex={currentGroupMatchIndex}
                  onNavigateNext={navigateToNextGroupMatch}
                  onNavigatePrev={navigateToPrevGroupMatch}
                />
                <SortMenu
                  menuRef={groupSortMenuRef}
                  isOpen={groupSortMenuOpen}
                  onToggle={() => setGroupSortMenuOpen((prev) => !prev)}
                  currentMode={groupSortMode}
                  onSelect={(v) => { setGroupSortMode(v); setGroupSortMenuOpen(false); }}
                  options={groupSortOptions}
                />
                <ThreeDotMenu
                  actions={[
                    { label: "Expand all", onClick: expandAllGroups },
                    { label: "Collapse all", onClick: collapseAllGroups },
                  ]}
                />
              </div>
              {groupSearchLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Spinner size="sm" variant="blue" label="Searching..." />
                </div>
              ) : groupSearchError ? (
                <EmptyState
                  icon={
                    <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  }
                  title="Search failed"
                  description={groupSearchError}
                  iconSize="sm"
                  iconBg="bg-red-50"
                  className="py-12 px-4"
                />
              ) : displayGroups.length === 0 && groupCommittedQuery.trim() ? (
                <EmptyState
                  icon={<SearchIcon size={24} className="text-gray-400" />}
                  title="No matches found"
                  className="py-12 px-4"
                />
              ) : null}

              {!groupSearchLoading && !groupSearchError && sortedGroupBatches.map((batch) => (
                <TaskGroupBatchCard
                  key={batch.taskId}
                  batch={batch}
                  isExpanded={expandedBatches.has(batch.taskId)}
                  onToggle={() => toggleBatch(batch.taskId)}
                  expandedGroups={expandedGroups}
                  onGroupToggle={toggleGroup}
                  expandedTrajectories={expandedTrajectories}
                  onTrajectoryToggle={toggleTrajectory}
                  searchQuery={groupCommittedQuery}
                  searchTerms={groupMatchedTerms}
                  currentGroupMatch={currentGroupMatch}
                  currentGroupMatchRef={currentGroupMatchRef}
                  preloadedGroupData={preloadedGroupData}
                  taskText={taskTextByTaskId.get(batch.taskId)}
                />
              ))}
            </div>
          )
        ) : // Episodes View
        episodesLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="sm" variant="blue" />
          </div>
        ) : episodesError ? (
          <EmptyState
            icon={
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
            title="Failed to load episodes"
            iconBg="bg-red-50"
            className="py-12 px-4"
          />
        ) : searchError ? (
          <EmptyState
            icon={
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
            title="Search failed"
            iconBg="bg-red-50"
            className="py-12 px-4"
          />
        ) : displayEpisodes.length === 0 && !committedQuery.trim() ? (
          selectedStep === null ? (
            <EmptyState
              icon={
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              }
              title="Select a data point"
              className="py-12 px-4"
            />
          ) : (
            <EmptyState
              icon={
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              }
              title={`No episodes at step ${selectedStep}`}
              className="py-12 px-4"
            />
          )
        ) : (
          <div className="divide-y divide-gray-100">
            {selectedStep !== null && (
              <div className="px-4 py-2.5 bg-layer-1 border-b border-gray-200 flex items-center gap-3 sticky top-0 z-10">
                {!hideStepLabel && (
                  <div className="flex flex-col flex-shrink-0">
                    <span className="text-sm font-medium text-gray-900">
                      {committedQuery.trim()
                        ? `${displayEpisodes.length} result${displayEpisodes.length !== 1 ? "s" : ""}`
                        : `Step ${selectedStep}`}
                    </span>
                    {!committedQuery.trim() && (
                      <span className="text-[11px] leading-tight text-gray-400">
                        {sortedBatches.length} task
                        {sortedBatches.length !== 1 ? "s" : ""} · {displayEpisodes.length} episode
                        {displayEpisodes.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
                {viewMode === "episodes" && (
                  <>
                    <SearchBar
                      query={searchQuery}
                      onQueryChange={setSearchQuery}
                      onKeyDown={handleKeyDown}
                      onClear={() => { setSearchQuery(""); setCommittedQuery(""); }}
                      showClear={!!(searchQuery || committedQuery)}
                      matchCount={matchLocations.length}
                      currentMatchIndex={currentMatchIndex}
                      onNavigateNext={navigateToNextMatch}
                      onNavigatePrev={navigateToPrevMatch}
                    />
                    <SortMenu
                      menuRef={sortMenuRef}
                      isOpen={sortMenuOpen}
                      onToggle={() => setSortMenuOpen((prev) => !prev)}
                      currentMode={sortMode}
                      onSelect={(v) => { setSortMode(v as any); setSortMenuOpen(false); }}
                      options={episodeSortOptions}
                    />
                    <ThreeDotMenu
                      actions={[
                        { label: "Expand all", onClick: expandAllEpisodes },
                        { label: "Collapse all", onClick: collapseAllEpisodes },
                      ]}
                    />
                  </>
                )}
              </div>
            )}

            {searchLoading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner size="sm" variant="blue" label="Searching..." />
              </div>
            ) : displayEpisodes.length === 0 && committedQuery.trim() ? (
              <EmptyState
                icon={<SearchIcon size={24} className="text-gray-400" />}
                title="No matches found"
                className="py-12 px-4"
              />
            ) : null}

            {!searchLoading && sortedBatches.map((batch) => (
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
        )}
      </div>
    </div>
  );
};

interface EpisodeCardProps {
  episode: Episode;
  rolloutIndex: number;
  isExpanded: boolean;
  onToggle: () => void;
  expandedTrajectories: Set<string>;
  onTrajectoryToggle: (uid: string) => void;
  searchQuery: string;
  searchTerms: string[];
  currentMatch: MatchLocation | null;
  currentMatchRef: React.RefObject<HTMLSpanElement | null>;
}

const EpisodeCard: React.FC<EpisodeCardProps> = ({
  episode,
  rolloutIndex,
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

  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-layer-2 transition-colors text-left"
      >
        <div className="shrink-0">
          {isExpanded ? (
            <ChevronDownIcon size={16} className="text-gray-400" />
          ) : (
            <ChevronRightIcon size={16} className="text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded ${
                episode.is_correct
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {episode.is_correct ? (
                <CheckIcon size={14} />
              ) : (
                <CloseIcon size={14} />
              )}
            </span>
            <span className="text-sm text-gray-700">Rollout {rolloutIndex}</span>
          </div>
        </div>

        <span className="text-xs text-gray-400 shrink-0">
          {trajectories.length} traj
        </span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4">
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
  currentMatchRef: React.RefObject<HTMLSpanElement | null>;
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
  // Task is the same for all episodes in a batch — show it once at batch level
  const taskText = batch.episodes.length > 0 ? getTaskSummary(batch.episodes[0].task) : "";
  const isCurrentMatchInTask =
    currentMatch?.field === "task" &&
    batch.episodes.some((e) => e.id === currentMatch?.episodeId);

  return (
    <CollapsibleSection
      isExpanded={isExpanded}
      onToggle={onToggle}
      title={
        <>
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
            {batch.correctCount}/{batch.totalCount}
          </span>
        </>
      }
      contentClassName="pl-3 border-l-2 border-gray-200 ml-2"
    >
      {taskText && (
        <div className="mt-2 mx-4 p-3 bg-white rounded-lg border border-gray-200">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
            Task
          </p>
          <p className="text-sm text-gray-900">
            <HighlightedText
              text={taskText}
              searchQuery={searchQuery}
              searchTerms={searchTerms}
              isCurrentMatch={isCurrentMatchInTask}
              matchRef={isCurrentMatchInTask ? currentMatchRef : undefined}
            />
          </p>
        </div>
      )}
      {batch.episodes.map((episode, idx) => (
        <EpisodeCard
          key={episode.id}
          episode={episode}
          rolloutIndex={idx}
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
    </CollapsibleSection>
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
  searchQuery?: string;
  searchTerms?: string[];
  currentGroupMatch?: GroupMatchLocation | null;
  currentGroupMatchRef?: React.RefObject<HTMLSpanElement | null>;
  preloadedGroupData?: Map<string, TrajectoryGroup>;
  taskText?: string;
}

const TaskGroupBatchCard: React.FC<TaskGroupBatchCardProps> = ({
  batch,
  isExpanded,
  onToggle,
  expandedGroups,
  onGroupToggle,
  expandedTrajectories,
  onTrajectoryToggle,
  searchQuery = "",
  searchTerms = [],
  currentGroupMatch,
  currentGroupMatchRef,
  preloadedGroupData,
  taskText,
}) => {
  return (
    <CollapsibleSection
      isExpanded={isExpanded}
      onToggle={onToggle}
      title={
        <>
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
            {batch.correctCount}/{batch.totalCount}
          </span>
        </>
      }
      contentClassName="pl-3 border-l-2 border-gray-200 ml-2"
    >
      {taskText && (
        <div className="mt-2 mx-4 p-3 bg-white rounded-lg border border-gray-200">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
            Task
          </p>
          <p className="text-sm text-gray-900">
            <HighlightedText
              text={taskText}
              searchQuery={searchQuery}
              searchTerms={searchTerms}
            />
          </p>
        </div>
      )}
      {batch.groups.map((group) => (
        <TrajectoryGroupCard
          key={group.id}
          group={group}
          isExpanded={expandedGroups.has(group.id)}
          onToggle={() => onGroupToggle(group.id)}
          expandedTrajectories={expandedTrajectories}
          onTrajectoryToggle={onTrajectoryToggle}
          searchQuery={searchQuery}
          searchTerms={searchTerms}
          currentGroupMatch={currentGroupMatch}
          currentGroupMatchRef={currentGroupMatchRef}
          preloadedData={preloadedGroupData?.get(group.id)}
        />
      ))}
    </CollapsibleSection>
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
  currentMatchRef: React.RefObject<HTMLSpanElement | null>;
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
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-layer-1 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDownIcon size={14} className="text-gray-400" />
        ) : (
          <ChevronRightIcon size={14} className="text-gray-400" />
        )}
        <span className="text-sm font-medium text-gray-700 capitalize">
          {trajectory.name || `Trajectory ${index + 1}`}
        </span>
        <span className="text-sm text-gray-500">
          {trajectory.steps?.length || 0} steps
        </span>
        <span className="text-sm text-gray-500 ml-auto">
          reward={trajectory.reward?.toFixed(3) ?? "N/A"}
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
  currentMatchRef: React.RefObject<HTMLSpanElement | null>;
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
            reward={step.reward?.toFixed(3) ?? "0"}
          </span>
          {step.done && (
            <span className="px-1.5 py-0.5 bg-layer-2 text-gray-600 rounded text-xs">
              done
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {visibleFields.map(({ key, value }) => {
          const fieldConfig = getFieldConfig(key, value);
          const fieldContent = formatFieldValue(value);
          const isCurrent = isCurrentMatch(key);

          return (
            <ExpandableFieldBox
              key={key}
              label={fieldConfig.label}
              labelColor={fieldConfig.labelColor}
              bgColor={fieldConfig.bgColor}
              borderColor={fieldConfig.borderColor}
            >
              <HighlightedText
                text={fieldContent}
                searchQuery={searchQuery}
                searchTerms={searchTerms}
                isCurrentMatch={isCurrent}
                matchRef={isCurrent ? currentMatchRef : undefined}
              />
            </ExpandableFieldBox>
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
  searchQuery?: string;
  searchTerms?: string[];
  currentGroupMatch?: GroupMatchLocation | null;
  currentGroupMatchRef?: React.RefObject<HTMLSpanElement | null>;
  preloadedData?: TrajectoryGroup;
}

const TrajectoryGroupCard: React.FC<TrajectoryGroupCardProps> = ({
  group,
  isExpanded,
  onToggle,
  expandedTrajectories,
  onTrajectoryToggle,
  searchQuery = "",
  searchTerms = [],
  currentGroupMatch,
  currentGroupMatchRef,
  preloadedData,
}) => {
  // State for fetching full trajectory data on demand
  const [fullGroupData, setFullGroupData] = useState<TrajectoryGroup | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch full data when expanded (if not already loaded and no preloaded data)
  useEffect(() => {
    if (
      isExpanded &&
      !fullGroupData &&
      !preloadedData &&
      !isLoading &&
      !group.data?.trajectories?.length
    ) {
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
  }, [
    isExpanded,
    fullGroupData,
    preloadedData,
    isLoading,
    group.id,
    group.data?.trajectories?.length,
  ]);

  // Use preloaded data first, then fetched data, then original group data
  const effectiveGroup = preloadedData || fullGroupData || group;
  const trajectories = effectiveGroup.data?.trajectories || [];
  // Metadata is now at top level (always present), with fallback to data.metadata for backwards compatibility
  const metadata =
    effectiveGroup.metadata || effectiveGroup.data?.metadata || [];
  // True when we've actually loaded or have data — avoids flashing "No trajectories" before the fetch starts
  const dataLoaded = fullGroupData !== null || preloadedData != null || (group.data?.trajectories?.length ?? 0) > 0;
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-layer-2 transition-colors text-left"
      >
        <div className="shrink-0">
          {isExpanded ? (
            <ChevronDownIcon size={16} className="text-gray-400" />
          ) : (
            <ChevronRightIcon size={16} className="text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900 capitalize">
              {group.trajectory_name || "unnamed"}
            </span>
            {group.avg_reward !== null && group.avg_reward === 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-red-100 text-red-700">
                <CloseIcon size={14} />
              </span>
            )}
            {group.avg_reward !== null && (
              <span className="text-sm text-gray-500">
                avg reward={group.avg_reward.toFixed(3)}
              </span>
            )}
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4">
          {loadError ? (
            <p className="text-sm text-red-500 py-2">Error: {loadError}</p>
          ) : isLoading || !dataLoaded ? (
            <Spinner size="sm" variant="blue" label="Loading trajectories..." />
          ) : trajectories.length === 0 ? (
            <p className="text-sm text-gray-500 py-2">
              No trajectories available
            </p>
          ) : (
            <>
            {trajectories.map((trajectory, idx) => {
              const trajUid = trajectory.uid || `${group.id}-${idx}`;
              const meta = metadata[idx];
              return (
                <GroupTrajectoryCard
                  key={`${group.id}-${idx}`}
                  trajectory={trajectory}
                  index={idx}
                  metadata={meta}
                  isExpanded={searchQuery ? true : expandedTrajectories.has(trajUid)}
                  onToggle={() => onTrajectoryToggle(trajUid)}
                  searchQuery={searchQuery}
                  searchTerms={searchTerms}
                  groupId={group.id}
                  trajectoryIndex={idx}
                  currentGroupMatch={currentGroupMatch}
                  currentGroupMatchRef={currentGroupMatchRef}
                />
              );
            })}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// Trajectory card within a group
interface GroupTrajectoryCardProps {
  trajectory: Trajectory;
  index: number;
  metadata?: TrajectoryGroupMetadata;
  isExpanded: boolean;
  onToggle: () => void;
  searchQuery?: string;
  searchTerms?: string[];
  groupId?: string;
  trajectoryIndex?: number;
  currentGroupMatch?: GroupMatchLocation | null;
  currentGroupMatchRef?: React.RefObject<HTMLSpanElement | null>;
}

const GroupTrajectoryCard: React.FC<GroupTrajectoryCardProps> = ({
  trajectory,
  index,
  metadata: _metadata,
  isExpanded,
  onToggle,
  searchQuery = "",
  searchTerms = [],
  groupId,
  trajectoryIndex,
  currentGroupMatch,
  currentGroupMatchRef,
}) => {
  return (
    <div className="mt-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-layer-1 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDownIcon size={14} className="text-gray-400" />
        ) : (
          <ChevronRightIcon size={14} className="text-gray-400" />
        )}
        <span className="text-sm font-medium text-gray-700">
          Trajectory {trajectoryIndex !== undefined ? trajectoryIndex : index}
        </span>
        <span className="text-sm text-gray-500">
          {trajectory.steps?.length || 0} steps
        </span>
        {(trajectory.reward ?? 0) === 0 && (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-red-100 text-red-700 ml-auto">
            <CloseIcon size={14} />
          </span>
        )}
        <span className={`text-sm text-gray-500 ${(trajectory.reward ?? 0) !== 0 ? "ml-auto" : ""}`}>
          reward={trajectory.reward?.toFixed(3) ?? "N/A"}
        </span>
      </button>

      {isExpanded && trajectory.steps && (
        <div className="border-t border-gray-100">
          {trajectory.steps.map((step, stepIdx) => (
            <GroupStepView
              key={stepIdx}
              step={step}
              index={stepIdx}
              searchQuery={searchQuery}
              searchTerms={searchTerms}
              groupId={groupId}
              trajectoryIndex={trajectoryIndex}
              currentGroupMatch={currentGroupMatch}
              currentGroupMatchRef={currentGroupMatchRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Step view for group trajectories (with optional search highlighting)
interface GroupStepViewProps {
  step: TrajectoryStep;
  index: number;
  searchQuery?: string;
  searchTerms?: string[];
  groupId?: string;
  trajectoryIndex?: number;
  currentGroupMatch?: GroupMatchLocation | null;
  currentGroupMatchRef?: React.RefObject<HTMLSpanElement | null>;
}

const GroupStepView: React.FC<GroupStepViewProps> = ({
  step,
  index,
  searchQuery = "",
  searchTerms = [],
  groupId,
  trajectoryIndex,
  currentGroupMatch,
  currentGroupMatchRef,
}) => {
  const visibleFields = getVisibleFields(step);

  const isCurrentMatch = (fieldKey: string) =>
    currentGroupMatch?.groupId === groupId &&
    currentGroupMatch?.trajectoryIndex === trajectoryIndex &&
    currentGroupMatch?.stepIndex === index &&
    currentGroupMatch?.field === fieldKey;

  return (
    <div className={`px-3 py-3 ${index > 0 ? "border-t border-gray-100" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">
          Step {index + 1}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">
            reward={step.reward?.toFixed(3) ?? "0"}
          </span>
          {step.done && (
            <span className="px-1.5 py-0.5 bg-layer-2 text-gray-600 rounded text-xs">
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
            <ExpandableFieldBox
              key={key}
              label={fieldConfig.label}
              labelColor={fieldConfig.labelColor}
              bgColor={fieldConfig.bgColor}
              borderColor={fieldConfig.borderColor}
            >
              <HighlightedText
                text={fieldContent}
                searchQuery={searchQuery}
                searchTerms={searchTerms}
                isCurrentMatch={isCurrent}
                matchRef={isCurrent ? currentGroupMatchRef : undefined}
              />
            </ExpandableFieldBox>
          );
        })}
      </div>
    </div>
  );
};

// Shared sort menu component
interface SortOption {
  value: string;
  label: string;
}

const SortMenu: React.FC<{
  menuRef: React.RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  onToggle: () => void;
  currentMode: string;
  onSelect: (value: string) => void;
  options: SortOption[];
}> = ({ menuRef, isOpen, onToggle, currentMode, onSelect, options }) => (
  <div ref={menuRef} className="relative flex-shrink-0">
    <button
      onClick={onToggle}
      className={`p-1 rounded transition-colors ${
        currentMode !== "default"
          ? "text-accent-600 bg-accent-50 hover:bg-accent-100"
          : "text-gray-400 hover:text-gray-600 hover:bg-layer-2"
      }`}
      title="Sort"
    >
      <SortIcon size={16} />
    </button>
    {isOpen && (
      <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 w-52">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
              currentMode === opt.value
                ? "text-accent-700 bg-accent-50"
                : "text-gray-700 hover:bg-layer-1"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    )}
  </div>
);

// Expandable field box component
const ExpandableFieldBox: React.FC<{
  label: string;
  labelColor: string;
  bgColor: string;
  borderColor: string;
  children: React.ReactNode;
}> = ({ label, labelColor, bgColor, borderColor, children }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const DEFAULT_HEIGHT = 192;

  useEffect(() => {
    if (contentRef.current) {
      const scrollH = contentRef.current.scrollHeight;
      setHeight(Math.min(scrollH, DEFAULT_HEIGHT));
    }
  }, [children]);

  return (
    <div>
      <p className={`text-xs font-medium ${labelColor} mb-1`}>{label}</p>
      <div
        ref={contentRef}
        className={`${bgColor} rounded-md border ${borderColor} p-2 text-sm text-gray-800 whitespace-pre-wrap break-words overflow-auto`}
        style={{ resize: 'vertical', height: height ?? 'auto', minHeight: '2rem', maxHeight: '60vh' }}
      >
        {children}
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

function isEmptyValue(value: any): boolean {
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return true;
  return false;
}

function getVisibleFields(
  step: TrajectoryStep,
): Array<{ key: string; value: any }> {
  const fields: Array<{ key: string; value: any }> = [];

  const fieldOrder = [
    "observation",
    "input",
    "thought",
    "model_response",
    "output",
    "action",
    "chat_completions",
    "info",
    "metadata",
  ];

  fieldOrder.forEach((key) => {
    if (!HIDDEN_FIELDS.has(key) && !isEmptyValue(step[key])) {
      fields.push({ key, value: step[key] });
    }
  });

  Object.keys(step).forEach((key) => {
    if (
      !HIDDEN_FIELDS.has(key) &&
      !fieldOrder.includes(key) &&
      !isEmptyValue(step[key])
    ) {
      fields.push({ key, value: step[key] });
    }
  });

  return fields;
}

function getFieldConfig(
  key: string,
  _value: any,
): {
  label: string;
  labelColor: string;
  bgColor: string;
  borderColor: string;
} {
  const style = {
    labelColor: "text-gray-600",
    bgColor: "bg-layer-1",
    borderColor: "border-gray-200",
  };
  const configs: Record<string, any> = {
    observation: { label: "Observation", ...style },
    input: { label: "Input", ...style },
    thought: { label: "Thought", ...style },
    model_response: { label: "Response", ...style },
    output: { label: "Output", ...style },
    action: { label: "Action", ...style },
    chat_completions: { label: "Chat Completions", ...style },
    info: { label: "Info", ...style },
    metadata: { label: "Metadata", ...style },
  };

  return (
    configs[key] || {
      label: formatFieldLabel(key),
      labelColor: "text-gray-600",
      bgColor: "bg-layer-1",
      borderColor: "border-gray-200",
    }
  );
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
