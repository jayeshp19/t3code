import { Debouncer } from "@tanstack/react-pacer";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

interface PersistedUiState {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  pinnedProjectCwds?: string[];
  pinnedThreadIds?: string[];
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
  projectPinnedById: Record<string, boolean>;
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadPinnedById: Record<string, boolean>;
}

export interface UiState extends UiProjectState, UiThreadState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string;
}

export interface SyncThreadInput {
  id: ThreadId;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  projectPinnedById: {},
  threadLastVisitedAtById: {},
  threadPinnedById: {},
};

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedPinnedProjectCwds = new Set<string>();
const persistedPinnedThreadIds = new Set<ThreadId>();
const currentProjectCwdById = new Map<ProjectId, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    hydratePersistedProjectState(JSON.parse(raw) as PersistedUiState);
    return initialState;
  } catch {
    return initialState;
  }
}

function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedPinnedProjectCwds.clear();
  persistedPinnedThreadIds.clear();
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
  for (const cwd of parsed.pinnedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedPinnedProjectCwds.add(cwd);
    }
  }
  for (const threadId of parsed.pinnedThreadIds ?? []) {
    if (typeof threadId === "string" && threadId.length > 0) {
      persistedPinnedThreadIds.add(threadId as ThreadId);
    }
  }
}

function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const pinnedProjectCwds = Object.entries(state.projectPinnedById)
      .filter(([, pinned]) => pinned)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const pinnedThreadIds = Object.entries(state.threadPinnedById)
      .filter(([, pinned]) => pinned)
      .map(([threadId]) => threadId);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds,
        projectOrderCwds,
        pinnedProjectCwds,
        pinnedThreadIds,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly ProjectId[], right: readonly ProjectId[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousProjectIdByCwd = new Map(
    [...previousProjectCwdById.entries()].map(([projectId, cwd]) => [cwd, projectId] as const),
  );
  currentProjectCwdById.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.id, project.cwd);
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.id) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const nextPinnedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const previousPinnedById = state.projectPinnedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    const previousProjectIdForCwd = previousProjectIdByCwd.get(project.cwd);
    const expanded =
      previousExpandedById[project.id] ??
      (previousProjectIdForCwd ? previousExpandedById[previousProjectIdForCwd] : undefined) ??
      (persistedExpandedProjectCwds.size > 0
        ? persistedExpandedProjectCwds.has(project.cwd)
        : true);
    const pinned =
      previousPinnedById[project.id] ??
      (previousProjectIdForCwd ? previousPinnedById[previousProjectIdForCwd] : undefined) ??
      persistedPinnedProjectCwds.has(project.cwd);
    nextExpandedById[project.id] = expanded;
    nextPinnedById[project.id] = pinned;
    return {
      id: project.id,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<ProjectId>();
          const orderedProjectIds: ProjectId[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (projectId in nextExpandedById ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    recordsEqual(state.projectPinnedById, nextPinnedById) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
    projectPinnedById: nextPinnedById,
  };
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.id));
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  const nextThreadPinnedById = Object.fromEntries(
    Object.entries(state.threadPinnedById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.id] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.id] = thread.seedVisitedAt;
    }
    if (nextThreadPinnedById[thread.id] === undefined) {
      nextThreadPinnedById[thread.id] = persistedPinnedThreadIds.has(thread.id);
    }
  }
  if (
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    recordsEqual(state.threadPinnedById, nextThreadPinnedById)
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadPinnedById: nextThreadPinnedById,
  };
}

export function markThreadVisited(state: UiState, threadId: ThreadId, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: ThreadId,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function clearThreadUi(state: UiState, threadId: ThreadId): UiState {
  if (!(threadId in state.threadLastVisitedAtById) && !(threadId in state.threadPinnedById)) {
    return state;
  }
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  const nextThreadPinnedById = { ...state.threadPinnedById };
  delete nextThreadLastVisitedAtById[threadId];
  delete nextThreadPinnedById[threadId];
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadPinnedById: nextThreadPinnedById,
  };
}

export function toggleThreadPinned(state: UiState, threadId: ThreadId): UiState {
  const nextThreadPinnedById = { ...state.threadPinnedById };
  if (nextThreadPinnedById[threadId]) {
    nextThreadPinnedById[threadId] = false;
  } else {
    nextThreadPinnedById[threadId] = true;
  }
  if (recordsEqual(state.threadPinnedById, nextThreadPinnedById)) {
    return state;
  }
  return {
    ...state,
    threadPinnedById: nextThreadPinnedById,
  };
}

export function toggleProject(state: UiState, projectId: ProjectId): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(
  state: UiState,
  projectId: ProjectId,
  expanded: boolean,
): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectId: ProjectId,
  targetProjectId: ProjectId,
): UiState {
  if (draggedProjectId === targetProjectId) {
    return state;
  }
  const draggedIndex = state.projectOrder.findIndex((projectId) => projectId === draggedProjectId);
  const targetIndex = state.projectOrder.findIndex((projectId) => projectId === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const projectOrder = [...state.projectOrder];
  const [draggedProject] = projectOrder.splice(draggedIndex, 1);
  if (!draggedProject) {
    return state;
  }
  projectOrder.splice(targetIndex, 0, draggedProject);
  return {
    ...state,
    projectOrder,
  };
}

export function toggleProjectPinned(state: UiState, projectId: ProjectId): UiState {
  const nextProjectPinnedById = { ...state.projectPinnedById };
  if (nextProjectPinnedById[projectId]) {
    nextProjectPinnedById[projectId] = false;
  } else {
    nextProjectPinnedById[projectId] = true;
  }
  if (recordsEqual(state.projectPinnedById, nextProjectPinnedById)) {
    return state;
  }
  return {
    ...state,
    projectPinnedById: nextProjectPinnedById,
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: ThreadId) => void;
  toggleThreadPinned: (threadId: ThreadId) => void;
  toggleProject: (projectId: ProjectId) => void;
  toggleProjectPinned: (projectId: ProjectId) => void;
  setProjectExpanded: (projectId: ProjectId, expanded: boolean) => void;
  reorderProjects: (draggedProjectId: ProjectId, targetProjectId: ProjectId) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  toggleThreadPinned: (threadId) => set((state) => toggleThreadPinned(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  toggleProjectPinned: (projectId) => set((state) => toggleProjectPinned(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
