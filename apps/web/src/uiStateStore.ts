import { Debouncer } from "@tanstack/react-pacer";
import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
// Version 1 stored card visibility, not folder expansion.
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 2;
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

export const SIDEBAR_FOLDER_ICON_NAMES = [
  "folder",
  "star",
  "briefcase",
  "flask",
  "bug",
  "rocket",
  "heart",
  "zap",
  "book",
  "home",
  "users",
  "code",
  "sparkles",
  "target",
  "inbox",
] as const;
export type SidebarFolderIconName = (typeof SIDEBAR_FOLDER_ICON_NAMES)[number];

export function isSidebarFolderIconName(value: unknown): value is SidebarFolderIconName {
  return (
    typeof value === "string" && (SIDEBAR_FOLDER_ICON_NAMES as readonly string[]).includes(value)
  );
}

/** Fork feature: a user-defined sidebar folder grouping unsettled threads. */
export interface SidebarThreadFolder {
  readonly id: string;
  readonly name: string;
  /** Scoped thread keys (`<environmentId>:<threadId>`); a thread belongs to at most one folder. */
  readonly threadKeys: readonly string[];
  readonly collapsed: boolean;
  /** Absent means the default folder glyph. */
  readonly icon?: SidebarFolderIconName;
}

export interface PersistedUiState {
  threadFolders?: SidebarThreadFolder[];
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  sidebarProjectScopeKey?: string | null;
  threadChangedFilesExpansionVersion?: number;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  pullRequestMergeMethod?: string;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  // Logical project key the sidebar list is scoped to, or null for "all
  // projects". Lives here so routes that unmount the sidebar (Settings)
  // cannot reset the filter.
  sidebarProjectScopeKey: string | null;
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiPullRequestState {
  pullRequestMergeMethod: PullRequestMergeMethod;
}

export interface UiFolderState {
  /** Sidebar folders; desktop/web only, stored per device (fork feature). */
  threadFolders: SidebarThreadFolder[];
}

export interface UiState
  extends UiProjectState,
    UiThreadState,
    UiEndpointState,
    UiPullRequestState,
    UiFolderState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  sidebarProjectScopeKey: null,
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  pullRequestMergeMethod: "merge",
  threadFolders: [],
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeOptionalKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

function isPullRequestMergeMethod(value: unknown): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

function sanitizeThreadFolders(value: unknown): SidebarThreadFolder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const seenThreadKeys = new Set<string>();
  const folders: SidebarThreadFolder[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (id.length === 0 || name.length === 0 || seenIds.has(id)) continue;
    seenIds.add(id);
    const threadKeys = sanitizeStringArray(candidate.threadKeys).filter((key) => {
      if (seenThreadKeys.has(key)) return false;
      seenThreadKeys.add(key);
      return true;
    });
    folders.push({
      id,
      name,
      threadKeys,
      collapsed: candidate.collapsed === true,
      ...(isSidebarFolderIconName(candidate.icon) ? { icon: candidate.icon } : {}),
    });
  }
  return folders;
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);

  return {
    projectExpandedById,
    projectOrder,
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    threadChangedFilesExpandedById:
      parsed.threadChangedFilesExpansionVersion === THREAD_CHANGED_FILES_EXPANSION_VERSION
        ? sanitizePersistedThreadChangedFilesExpanded(parsed.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey: sanitizeOptionalKey(parsed.defaultAdvertisedEndpointKey),
    sidebarProjectScopeKey: sanitizeOptionalKey(parsed.sidebarProjectScopeKey),
    pullRequestMergeMethod: isPullRequestMergeMethod(parsed.pullRequestMergeMethod)
      ? parsed.pullRequestMergeMethod
      : initialState.pullRequestMergeMethod,
    threadFolders: sanitizeThreadFolders(parsed.threadFolders),
  };
}

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
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        sidebarProjectScopeKey: state.sidebarProjectScopeKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
        pullRequestMergeMethod: state.pullRequestMergeMethod,
        threadFolders: state.threadFolders,
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

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
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
      [threadId]: visitedAt,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
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

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  if (currentThreadState[turnId] === expanded) {
    return state;
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: expanded,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function setSidebarProjectScopeKey(state: UiState, projectKey: string | null): UiState {
  const nextKey = sanitizeOptionalKey(projectKey);
  if (state.sidebarProjectScopeKey === nextKey) {
    return state;
  }
  return {
    ...state,
    sidebarProjectScopeKey: nextKey,
  };
}

function setPullRequestMergeMethod(state: UiState, method: PullRequestMergeMethod): UiState {
  return state.pullRequestMergeMethod === method
    ? state
    : { ...state, pullRequestMergeMethod: method };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

// ---------------------------------------------------------------------------
// Sidebar thread folders (fork feature)
// ---------------------------------------------------------------------------

export function findThreadFolderId(
  folders: readonly SidebarThreadFolder[],
  threadKey: string,
): string | null {
  for (const folder of folders) {
    if (folder.threadKeys.includes(threadKey)) return folder.id;
  }
  return null;
}

export function createThreadFolder(
  state: UiState,
  folder: { readonly id: string; readonly name: string },
  initialThreadKey?: string,
): UiState {
  const name = folder.name.trim();
  if (folder.id.length === 0 || name.length === 0) return state;
  if (state.threadFolders.some((existing) => existing.id === folder.id)) return state;
  const withoutThread = initialThreadKey
    ? removeThreadKeyFromFolders(state.threadFolders, initialThreadKey)
    : state.threadFolders;
  return {
    ...state,
    threadFolders: [
      ...withoutThread,
      {
        id: folder.id,
        name,
        threadKeys: initialThreadKey ? [initialThreadKey] : [],
        collapsed: false,
      },
    ],
  };
}

export function renameThreadFolder(state: UiState, folderId: string, name: string): UiState {
  const nextName = name.trim();
  if (nextName.length === 0) return state;
  const index = state.threadFolders.findIndex((folder) => folder.id === folderId);
  if (index < 0 || state.threadFolders[index]!.name === nextName) return state;
  const threadFolders = [...state.threadFolders];
  threadFolders[index] = { ...threadFolders[index]!, name: nextName };
  return { ...state, threadFolders };
}

export function deleteThreadFolder(state: UiState, folderId: string): UiState {
  if (!state.threadFolders.some((folder) => folder.id === folderId)) return state;
  return {
    ...state,
    threadFolders: state.threadFolders.filter((folder) => folder.id !== folderId),
  };
}

export function setThreadFolderCollapsed(
  state: UiState,
  folderId: string,
  collapsed: boolean,
): UiState {
  const index = state.threadFolders.findIndex((folder) => folder.id === folderId);
  if (index < 0 || state.threadFolders[index]!.collapsed === collapsed) return state;
  const threadFolders = [...state.threadFolders];
  threadFolders[index] = { ...threadFolders[index]!, collapsed };
  return { ...state, threadFolders };
}

function removeThreadKeyFromFolders(
  folders: readonly SidebarThreadFolder[],
  threadKey: string,
): SidebarThreadFolder[] {
  return folders.map((folder) =>
    folder.threadKeys.includes(threadKey)
      ? { ...folder, threadKeys: folder.threadKeys.filter((key) => key !== threadKey) }
      : folder,
  );
}

/** Move a thread into `folderId`, or out of every folder when `folderId` is null. */
export function moveThreadToFolder(
  state: UiState,
  threadKey: string,
  folderId: string | null,
): UiState {
  if (threadKey.length === 0) return state;
  if (findThreadFolderId(state.threadFolders, threadKey) === folderId) return state;
  if (folderId !== null && !state.threadFolders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const threadFolders = removeThreadKeyFromFolders(state.threadFolders, threadKey).map((folder) =>
    folder.id === folderId ? { ...folder, threadKeys: [...folder.threadKeys, threadKey] } : folder,
  );
  return { ...state, threadFolders };
}

/** Manual reorder of folders: drop `folderId` at `targetFolderId`'s slot. */
export function reorderThreadFolder(
  state: UiState,
  folderId: string,
  targetFolderId: string,
): UiState {
  if (folderId === targetFolderId) return state;
  const from = state.threadFolders.findIndex((folder) => folder.id === folderId);
  const to = state.threadFolders.findIndex((folder) => folder.id === targetFolderId);
  if (from < 0 || to < 0) return state;
  const threadFolders = [...state.threadFolders];
  threadFolders.splice(to, 0, threadFolders.splice(from, 1)[0]!);
  return { ...state, threadFolders };
}

export function setThreadFolderIcon(
  state: UiState,
  folderId: string,
  icon: SidebarFolderIconName,
): UiState {
  const index = state.threadFolders.findIndex((folder) => folder.id === folderId);
  if (index < 0 || (state.threadFolders[index]!.icon ?? "folder") === icon) return state;
  const threadFolders = [...state.threadFolders];
  const { icon: _previous, ...rest } = threadFolders[index]!;
  threadFolders[index] = icon === "folder" ? rest : { ...rest, icon };
  return { ...state, threadFolders };
}

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setSidebarProjectScopeKey: (projectKey: string | null) => void;
  setPullRequestMergeMethod: (method: PullRequestMergeMethod) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
  createThreadFolder: (
    folder: { readonly id: string; readonly name: string },
    initialThreadKey?: string,
  ) => void;
  renameThreadFolder: (folderId: string, name: string) => void;
  deleteThreadFolder: (folderId: string) => void;
  setThreadFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  moveThreadToFolder: (threadKey: string, folderId: string | null) => void;
  reorderThreadFolder: (folderId: string, targetFolderId: string) => void;
  setThreadFolderIcon: (folderId: string, icon: SidebarFolderIconName) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setSidebarProjectScopeKey: (projectKey) =>
    set((state) => setSidebarProjectScopeKey(state, projectKey)),
  setPullRequestMergeMethod: (method) => set((state) => setPullRequestMergeMethod(state, method)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
  createThreadFolder: (folder, initialThreadKey) =>
    set((state) => createThreadFolder(state, folder, initialThreadKey)),
  renameThreadFolder: (folderId, name) => set((state) => renameThreadFolder(state, folderId, name)),
  deleteThreadFolder: (folderId) => set((state) => deleteThreadFolder(state, folderId)),
  setThreadFolderCollapsed: (folderId, collapsed) =>
    set((state) => setThreadFolderCollapsed(state, folderId, collapsed)),
  moveThreadToFolder: (threadKey, folderId) =>
    set((state) => moveThreadToFolder(state, threadKey, folderId)),
  reorderThreadFolder: (folderId, targetFolderId) =>
    set((state) => reorderThreadFolder(state, folderId, targetFolderId)),
  setThreadFolderIcon: (folderId, icon) =>
    set((state) => setThreadFolderIcon(state, folderId, icon)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
