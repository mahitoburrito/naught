import { create } from "zustand";
import { Node } from "@xyflow/react";
import {
  DEFAULT_APPEARANCE,
  clampTerminalFontSize,
  isTerminalFontFamilyId,
  isTerminalThemeId,
  isWorkspaceBackgroundId,
  type TerminalFontFamilyId,
  type TerminalThemeId,
  type WorkspaceBackgroundId,
} from "../theme/appearance";
import {
  deletePersistedCategories,
  pruneEmptyTitleClusters,
} from "../utils/canvasLayout";

// localStorage keys for crash-resilient UI state
const STORAGE_KEY = "openui-desktop-ui-state";

export interface Agent {
  id: string;
  name: string;
  command: string;
  description: string;
  color: string;
  icon: string;
  profileId?: string;
  profileVersion?: number;
  profileConfig?: {
    name: string;
    description: string;
    command: string;
    initialPrompt?: string;
    color: string;
    icon: string;
    model?: string;
    systemPrompt?: string;
    tools: string[];
    mcpServers: Array<{ name: string; url?: string; command?: string }>;
    skills: string[];
    fallbackCommands: string[];
    permissionPolicy: "ask" | "allow-edits" | "read-only";
    metadata: Record<string, string>;
  };
}

export type AgentStatus = "running" | "waiting_input" | "tool_calling" | "idle" | "disconnected" | "error" | "creating";
export type TerminalOsc52ClipboardAccess = "deny" | "write_only" | "read_write";

export interface CheckpointSummary {
  id: string;
  repoRoot: string;
  name: string;
  createdAt: number;
  files: { path: string; exists: boolean }[];
  source?: "manual" | "session-launch";
  sessionId?: string;
  nodeId?: string;
}

export interface AgentChangeSummary {
  sessionId: string;
  nodeId: string;
  repoRoot: string;
  changedFileCount: number;
  added: number;
  removed: number;
  summary: string;
  files: {
    path: string;
    status: string;
    added: number;
    removed: number;
    untracked: boolean;
  }[];
}

export interface AgentSession {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  color: string;
  createdAt: string;
  cwd: string;
  originalCwd?: string; // Mother repo path when using worktrees
  gitBranch?: string;
  status: AgentStatus;
  /** Server timestamp of the last real status change, for "waiting a while". */
  statusChangedAt?: number;
  customName?: string;
  customColor?: string;
  notes?: string;
  isRestored?: boolean;
  /** A disconnected Claude node whose conversation can be resumed. */
  resumable?: boolean;
  // Linear ticket info
  ticketId?: string;
  ticketTitle?: string;
  // Current tool being used (from plugin)
  currentTool?: string;
  // Multi-repo worktree paths
  worktreePaths?: Record<string, string>;
  // Restore point captured before this session started
  launchCheckpoint?: CheckpointSummary;
  // Current uncommitted changes in this session's repo
  changeSummary?: AgentChangeSummary;
  agentProfileId?: string;
  agentProfileVersion?: number;
  agentPermissionPolicy?: "ask" | "allow-edits" | "read-only";
  agentModel?: string;
  terminalCols?: number;
  terminalRows?: number;
}

export interface DeleteToast {
  sessionId: string;
  nodeId: string;
  sessionName: string;
  items?: { sessionId: string; nodeId: string; sessionName: string }[];
  timeout: ReturnType<typeof setTimeout>;
}

export type ViewMode = "canvas" | "overview" | "focus" | "markdown" | "diff";
export type StatusFilter = AgentStatus | "all";

export interface AgentActivityEvent {
  id: string;
  nodeId: string;
  sessionId: string;
  title: string;
  body: string;
  status: AgentStatus;
  color: string;
  repoPath?: string;
  createdAt: number;
}

export interface LaunchPromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtIn?: boolean;
}

export const DEFAULT_LAUNCH_PROMPT_TEMPLATES: LaunchPromptTemplate[] = [];

export interface CanvasLayoutSnapshot {
  id: string;
  name: string;
  createdAt: number;
  positions: Record<string, { x: number; y: number }>;
}

// Diff viewer presentation preferences
export type DiffLayout = "unified" | "split";
export type DiffTheme =
  | "github-dark"
  | "github-light"
  | "one-dark-pro"
  | "dracula"
  | "nord"
  | "vitesse-dark";
export const DIFF_THEMES: DiffTheme[] = [
  "github-dark",
  "github-light",
  "one-dark-pro",
  "dracula",
  "nord",
  "vitesse-dark",
];

interface AppState {
  // Config
  launchCwd: string;
  setLaunchCwd: (cwd: string) => void;
  lastPickedDirectory: string;
  setLastPickedDirectory: (cwd: string) => void;
  terminalOsc52ClipboardAccess: TerminalOsc52ClipboardAccess;
  setTerminalOsc52ClipboardAccess: (access: TerminalOsc52ClipboardAccess) => void;

  // Agents
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;

  // Sessions / Nodes
  sessions: Map<string, AgentSession>;
  addSession: (nodeId: string, session: AgentSession) => void;
  updateSession: (nodeId: string, updates: Partial<AgentSession>) => void;
  removeSession: (nodeId: string) => void;

  // Canvas
  nodes: Node[];
  setNodes: (nodes: Node[]) => void;
  addNode: (node: Node) => void;
  updateNode: (nodeId: string, updates: Partial<Node>) => void;
  removeNode: (nodeId: string) => void;

  // UI State
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  // Selection mode — canvas multi-select for bulk actions
  selectionModeActive: boolean;
  setSelectionModeActive: (on: boolean) => void;
  multiSelectedNodeIds: string[];
  setMultiSelectedNodeIds: (ids: string[]) => void;
  addAgentModalOpen: boolean;
  setAddAgentModalOpen: (open: boolean) => void;
  newSessionModalOpen: boolean;
  setNewSessionModalOpen: (open: boolean) => void;
  newSessionForNodeId: string | null;
  setNewSessionForNodeId: (nodeId: string | null) => void;
  newSessionInitialPrompt: string;
  setNewSessionInitialPrompt: (prompt: string) => void;
  todosPanelOpen: boolean;
  setTodosPanelOpen: (open: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  activityCenterOpen: boolean;
  setActivityCenterOpen: (open: boolean) => void;
  agentProfilesOpen: boolean;
  setAgentProfilesOpen: (open: boolean) => void;
  activityLastSeenAt: number;

  // Session List Panel
  sessionListOpen: boolean;
  setSessionListOpen: (open: boolean) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (filter: StatusFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  // Collapsed project groups in the session list (keyed by group path)
  collapsedSessionGroups: string[];
  toggleSessionGroup: (groupKey: string) => void;

  // Full-screen terminal views
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  overviewExpandedNodeId: string | null;
  setOverviewExpandedNodeId: (nodeId: string | null) => void;
  overviewVisibleNodeIds: string[];
  setOverviewVisibleNodeIds: (nodeIds: string[]) => void;
  focusedSessionIds: string[]; // nodeIds pinned in focus mode
  addFocusedSession: (nodeId: string) => void;
  removeFocusedSession: (nodeId: string) => void;
  setFocusedSessions: (nodeIds: string[]) => void;
  // Per-layout pane size ratios for resizable splitter (sum to 1)
  splitRatios: Record<string, number[]>;
  setSplitRatios: (key: string, ratios: number[]) => void;

  // Markdown viewer
  openMarkdownFiles: string[]; // absolute file paths
  addMarkdownFile: (path: string) => void;
  removeMarkdownFile: (path: string) => void;
  setMarkdownFiles: (paths: string[]) => void;

  // Diff viewer — repo whose working-tree diff is being reviewed
  diffRepoPath: string | null;
  setDiffRepoPath: (path: string | null) => void;
  // Auto-open the diff viewer when an agent finishes with uncommitted changes.
  diffAutoOpen: boolean;
  setDiffAutoOpen: (on: boolean) => void;
  // Diff viewer presentation preferences
  diffLayout: DiffLayout;
  setDiffLayout: (layout: DiffLayout) => void;
  diffWrap: boolean;
  setDiffWrap: (wrap: boolean) => void;
  diffTheme: DiffTheme;
  setDiffTheme: (theme: DiffTheme) => void;

  // Embedded browser preview
  browserUrl: string;
  setBrowserUrl: (url: string) => void;
  browserPanelOpen: boolean;
  setBrowserPanelOpen: (open: boolean) => void;
  browserPanelWidth: number;
  setBrowserPanelWidth: (width: number) => void;

  // Appearance
  workspaceBackground: WorkspaceBackgroundId;
  setWorkspaceBackground: (background: WorkspaceBackgroundId) => void;
  terminalTheme: TerminalThemeId;
  setTerminalTheme: (theme: TerminalThemeId) => void;
  terminalFontFamily: TerminalFontFamilyId;
  setTerminalFontFamily: (font: TerminalFontFamilyId) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  launchPromptTemplates: LaunchPromptTemplate[];
  addLaunchPromptTemplate: (template: Omit<LaunchPromptTemplate, "id" | "builtIn">) => void;
  removeLaunchPromptTemplate: (id: string) => void;

  // Delete toast
  deleteToast: DeleteToast | null;
  setDeleteToast: (toast: DeleteToast | null) => void;

  agentActivityEvents: AgentActivityEvent[];
  addAgentActivityEvent: (event: Omit<AgentActivityEvent, "id" | "createdAt">) => void;
  removeAgentActivityEvent: (id: string) => void;
  clearAgentActivityEvents: () => void;

  // Canvas layout snapshots
  canvasLayoutSnapshots: CanvasLayoutSnapshot[];
  saveCanvasLayoutSnapshot: (name?: string) => void;
  restoreCanvasLayoutSnapshot: (id: string) => void;
  removeCanvasLayoutSnapshot: (id: string) => void;
}

// Load persisted UI state from localStorage
function loadPersistedUIState(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const persistedViewMode =
        parsed.viewMode === "overview" ||
        parsed.viewMode === "focus" ||
        parsed.viewMode === "diff"
          ? parsed.viewMode
          : "canvas";
      return {
        lastPickedDirectory:
          typeof parsed.lastPickedDirectory === "string"
            ? parsed.lastPickedDirectory.slice(0, 4096)
            : "",
        sessionListOpen: parsed.sessionListOpen ?? true,
        collapsedSessionGroups: Array.isArray(parsed.collapsedSessionGroups)
          ? parsed.collapsedSessionGroups.slice(0, 100)
          : [],
        viewMode: persistedViewMode,
        focusedSessionIds: parsed.focusedSessionIds ?? [],
        splitRatios: parsed.splitRatios ?? {},
        openMarkdownFiles: parsed.openMarkdownFiles ?? [],
        diffRepoPath: parsed.diffRepoPath ?? null,
        diffAutoOpen: parsed.diffAutoOpen ?? true,
        diffLayout: parsed.diffLayout ?? "unified",
        diffWrap: parsed.diffWrap ?? false,
        diffTheme: parsed.diffTheme ?? "github-dark",
        browserUrl: parsed.browserUrl ?? "",
        // Only restore an open browser dock when there is a URL to show —
        // a bare dock restored after relaunch is noise, not a preview.
        browserPanelOpen:
          (parsed.browserPanelOpen ?? parsed.viewMode === "browser") &&
          typeof parsed.browserUrl === "string" &&
          parsed.browserUrl.length > 0,
        browserPanelWidth: clampBrowserPanelWidth(parsed.browserPanelWidth),
        workspaceBackground: isWorkspaceBackgroundId(parsed.workspaceBackground)
          ? parsed.workspaceBackground
          : DEFAULT_APPEARANCE.workspaceBackground,
        terminalTheme: isTerminalThemeId(parsed.terminalTheme)
          ? parsed.terminalTheme
          : DEFAULT_APPEARANCE.terminalTheme,
        terminalFontFamily: isTerminalFontFamilyId(parsed.terminalFontFamily)
          ? parsed.terminalFontFamily
          : DEFAULT_APPEARANCE.terminalFontFamily,
        terminalFontSize: clampTerminalFontSize(parsed.terminalFontSize),
        activityLastSeenAt:
          typeof parsed.activityLastSeenAt === "number"
            ? parsed.activityLastSeenAt
            : 0,
        agentActivityEvents: Array.isArray(parsed.agentActivityEvents)
          ? parsed.agentActivityEvents.slice(0, 50)
          : [],
        launchPromptTemplates: Array.isArray(parsed.launchPromptTemplates)
          ? [
              ...DEFAULT_LAUNCH_PROMPT_TEMPLATES,
              ...parsed.launchPromptTemplates
                .filter((template: LaunchPromptTemplate) => !template.builtIn)
                .slice(0, 20),
            ]
          : DEFAULT_LAUNCH_PROMPT_TEMPLATES,
        canvasLayoutSnapshots: Array.isArray(parsed.canvasLayoutSnapshots)
          ? parsed.canvasLayoutSnapshots.slice(0, 8)
          : [],
      };
    }
  } catch {
    // Corrupted localStorage — ignore
  }
  return {};
}

const MAX_FOCUSED_SESSIONS = 16;
const DEFAULT_BROWSER_PANEL_WIDTH = 720;
const MIN_BROWSER_PANEL_WIDTH = 360;
const MAX_BROWSER_PANEL_WIDTH = 1100;

function clampBrowserPanelWidth(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) {
    return DEFAULT_BROWSER_PANEL_WIDTH;
  }
  return Math.min(MAX_BROWSER_PANEL_WIDTH, Math.max(MIN_BROWSER_PANEL_WIDTH, Math.round(width)));
}

const persisted = loadPersistedUIState();

export const useStore = create<AppState>((set) => ({
  // Config
  launchCwd: "",
  setLaunchCwd: (cwd) => set({ launchCwd: cwd }),
  lastPickedDirectory: (persisted.lastPickedDirectory as string) ?? "",
  setLastPickedDirectory: (cwd) => set({ lastPickedDirectory: cwd }),
  terminalOsc52ClipboardAccess: "deny",
  setTerminalOsc52ClipboardAccess: (access) => set({ terminalOsc52ClipboardAccess: access }),

  // Agents
  agents: [],
  setAgents: (agents) => set({ agents }),

  // Sessions
  sessions: new Map(),
  addSession: (nodeId, session) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(nodeId, session);
      return { sessions: newSessions };
    }),
  updateSession: (nodeId, updates) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(nodeId);
      if (session) {
        newSessions.set(nodeId, { ...session, ...updates });
      }
      return { sessions: newSessions };
    }),
  removeSession: (nodeId) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(nodeId);
      return { sessions: newSessions };
    }),

  // Canvas
  nodes: [],
  setNodes: (nodes) => {
    const pruned = pruneEmptyTitleClusters(nodes);
    if (pruned.removedCategoryIds.length > 0) {
      void deletePersistedCategories(pruned.removedCategoryIds);
    }
    set({ nodes: pruned.nodes });
  },
  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),
  updateNode: (nodeId, updates) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...updates } : n
      ),
    })),
  removeNode: (nodeId) =>
    set((state) => {
      const pruned = pruneEmptyTitleClusters(
        state.nodes.filter((node) => node.id !== nodeId),
      );
      if (pruned.removedCategoryIds.length > 0) {
        void deletePersistedCategories(pruned.removedCategoryIds);
      }
      return { nodes: pruned.nodes };
    }),

  // UI State
  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  selectionModeActive: false,
  setSelectionModeActive: (on) =>
    set((state) => ({
      selectionModeActive: on,
      multiSelectedNodeIds: [],
      // Both directions start from a clean slate: clear selection flags, and
      // keep category boxes out of the marquee while the mode is on.
      nodes: state.nodes.map((n) => {
        if (n.type === "category") {
          const nextSelectable = on ? false : undefined;
          if (n.selectable === nextSelectable && !n.selected) return n;
          return { ...n, selected: false, selectable: nextSelectable };
        }
        return n.selected ? { ...n, selected: false } : n;
      }),
      ...(on ? { selectedNodeId: null, sidebarOpen: false } : {}),
    })),
  multiSelectedNodeIds: [],
  setMultiSelectedNodeIds: (ids) => set({ multiSelectedNodeIds: ids }),
  addAgentModalOpen: false,
  setAddAgentModalOpen: (open) => set({ addAgentModalOpen: open }),
  newSessionModalOpen: false,
  setNewSessionModalOpen: (open) => set({ newSessionModalOpen: open }),
  newSessionForNodeId: null,
  setNewSessionForNodeId: (nodeId) => set({ newSessionForNodeId: nodeId }),
  newSessionInitialPrompt: "",
  setNewSessionInitialPrompt: (prompt) => set({ newSessionInitialPrompt: prompt }),
  agentProfilesOpen: false,
  setAgentProfilesOpen: (open) => set({ agentProfilesOpen: open }),
  todosPanelOpen: false,
  setTodosPanelOpen: (open) => set({ todosPanelOpen: open }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  activityCenterOpen: false,
  setActivityCenterOpen: (open) =>
    set(
      open
        ? { activityCenterOpen: true, activityLastSeenAt: Date.now() }
        : { activityCenterOpen: false },
    ),
  activityLastSeenAt: (persisted.activityLastSeenAt as number) ?? 0,

  // Session List Panel
  sessionListOpen: persisted.sessionListOpen ?? true,
  setSessionListOpen: (open) => set({ sessionListOpen: open }),
  statusFilter: "all",
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
  collapsedSessionGroups: (persisted.collapsedSessionGroups as string[]) ?? [],
  toggleSessionGroup: (groupKey) =>
    set((state) => ({
      collapsedSessionGroups: state.collapsedSessionGroups.includes(groupKey)
        ? state.collapsedSessionGroups.filter((key) => key !== groupKey)
        : [...state.collapsedSessionGroups, groupKey],
    })),

  // Focus Mode
  viewMode: (persisted.viewMode as ViewMode) ?? "canvas",
  setViewMode: (mode) =>
    set((state) => {
      const leavingCanvasSelection = mode !== "canvas" && state.selectionModeActive;
      return {
        viewMode: mode,
        overviewExpandedNodeId:
          mode === "overview" ? state.overviewExpandedNodeId : null,
        overviewVisibleNodeIds:
          mode === "overview" ? state.overviewVisibleNodeIds : [],
        // The browser dock only renders in focus mode. Close it when leaving
        // so it does not reopen unexpectedly on the next focused session.
        browserPanelOpen: mode === "focus" ? state.browserPanelOpen : false,
        ...(leavingCanvasSelection
          ? {
              selectionModeActive: false,
              multiSelectedNodeIds: [],
              nodes: state.nodes.map((node) => {
                if (node.type === "category") {
                  return { ...node, selected: false, selectable: undefined };
                }
                return node.selected ? { ...node, selected: false } : node;
              }),
            }
          : {}),
      };
    }),
  overviewExpandedNodeId: null,
  setOverviewExpandedNodeId: (nodeId) => set({ overviewExpandedNodeId: nodeId }),
  overviewVisibleNodeIds: [],
  setOverviewVisibleNodeIds: (nodeIds) => set({ overviewVisibleNodeIds: nodeIds.slice(0, 9) }),
  focusedSessionIds: persisted.focusedSessionIds ?? [],
  addFocusedSession: (nodeId) =>
    set((state) => ({
      focusedSessionIds: state.focusedSessionIds.includes(nodeId)
        ? state.focusedSessionIds
        : [...state.focusedSessionIds, nodeId].slice(0, MAX_FOCUSED_SESSIONS),
    })),
  removeFocusedSession: (nodeId) =>
    set((state) => ({
      focusedSessionIds: state.focusedSessionIds.filter((id) => id !== nodeId),
    })),
  setFocusedSessions: (nodeIds) =>
    set({ focusedSessionIds: nodeIds.slice(0, MAX_FOCUSED_SESSIONS) }),

  splitRatios: (persisted.splitRatios as Record<string, number[]>) ?? {},
  setSplitRatios: (key, ratios) =>
    set((state) => ({
      splitRatios: { ...state.splitRatios, [key]: ratios },
    })),

  // Markdown viewer
  openMarkdownFiles: (persisted.openMarkdownFiles as string[]) ?? [],
  addMarkdownFile: (path) =>
    set((state) => ({
      openMarkdownFiles: state.openMarkdownFiles.includes(path)
        ? state.openMarkdownFiles
        : [...state.openMarkdownFiles, path],
    })),
  removeMarkdownFile: (path) =>
    set((state) => ({
      openMarkdownFiles: state.openMarkdownFiles.filter((p) => p !== path),
    })),
  setMarkdownFiles: (paths) => set({ openMarkdownFiles: paths }),

  // Diff viewer
  diffRepoPath: (persisted.diffRepoPath as string | null) ?? null,
  setDiffRepoPath: (path) => set({ diffRepoPath: path }),
  diffAutoOpen: (persisted.diffAutoOpen as boolean) ?? true,
  setDiffAutoOpen: (on) => set({ diffAutoOpen: on }),
  diffLayout: (persisted.diffLayout as DiffLayout) ?? "unified",
  setDiffLayout: (layout) => set({ diffLayout: layout }),
  diffWrap: (persisted.diffWrap as boolean) ?? false,
  setDiffWrap: (wrap) => set({ diffWrap: wrap }),
  diffTheme: (persisted.diffTheme as DiffTheme) ?? "github-dark",
  setDiffTheme: (theme) => set({ diffTheme: theme }),

  // Embedded browser preview
  browserUrl: (persisted.browserUrl as string) ?? "",
  setBrowserUrl: (url) => set({ browserUrl: url }),
  browserPanelOpen: (persisted.browserPanelOpen as boolean) ?? false,
  setBrowserPanelOpen: (open) => set({ browserPanelOpen: open }),
  browserPanelWidth: clampBrowserPanelWidth(persisted.browserPanelWidth),
  setBrowserPanelWidth: (width) => set({ browserPanelWidth: clampBrowserPanelWidth(width) }),

  // Appearance
  workspaceBackground:
    (persisted.workspaceBackground as WorkspaceBackgroundId) ??
    DEFAULT_APPEARANCE.workspaceBackground,
  setWorkspaceBackground: (background) => set({ workspaceBackground: background }),
  terminalTheme:
    (persisted.terminalTheme as TerminalThemeId) ?? DEFAULT_APPEARANCE.terminalTheme,
  setTerminalTheme: (theme) => set({ terminalTheme: theme }),
  terminalFontFamily:
    (persisted.terminalFontFamily as TerminalFontFamilyId) ??
    DEFAULT_APPEARANCE.terminalFontFamily,
  setTerminalFontFamily: (font) => set({ terminalFontFamily: font }),
  terminalFontSize:
    (persisted.terminalFontSize as number) ?? DEFAULT_APPEARANCE.terminalFontSize,
  setTerminalFontSize: (size) => set({ terminalFontSize: clampTerminalFontSize(size) }),
  launchPromptTemplates:
    (persisted.launchPromptTemplates as LaunchPromptTemplate[] | undefined) ??
    DEFAULT_LAUNCH_PROMPT_TEMPLATES,
  addLaunchPromptTemplate: (template) =>
    set((state) => ({
      launchPromptTemplates: [
        ...DEFAULT_LAUNCH_PROMPT_TEMPLATES,
        ...state.launchPromptTemplates.filter((item) => !item.builtIn),
        {
          ...template,
          id: `prompt-${Date.now()}`,
          builtIn: false,
        },
      ].slice(0, DEFAULT_LAUNCH_PROMPT_TEMPLATES.length + 20),
    })),
  removeLaunchPromptTemplate: (id) =>
    set((state) => ({
      launchPromptTemplates: [
        ...DEFAULT_LAUNCH_PROMPT_TEMPLATES,
        ...state.launchPromptTemplates.filter((item) => !item.builtIn && item.id !== id),
      ],
    })),

  // Delete toast
  deleteToast: null,
  setDeleteToast: (toast) =>
    set((state) => {
      // A replaced toast's auto-dismiss timer would otherwise fire later and
      // dismiss the new toast early, cutting its undo window short.
      if (state.deleteToast && state.deleteToast !== toast) {
        clearTimeout(state.deleteToast.timeout);
      }
      return { deleteToast: toast };
    }),

  agentActivityEvents:
    (persisted.agentActivityEvents as AgentActivityEvent[] | undefined) ?? [],
  addAgentActivityEvent: (event) =>
    set((state) => ({
      agentActivityEvents: [
        {
          ...event,
          id: `${event.nodeId}-${event.status}-${Date.now()}`,
          createdAt: Date.now(),
        },
        ...state.agentActivityEvents,
      ].slice(0, 50),
    })),
  removeAgentActivityEvent: (id) =>
    set((state) => ({
      agentActivityEvents: state.agentActivityEvents.filter((event) => event.id !== id),
    })),
  clearAgentActivityEvents: () => set({ agentActivityEvents: [], activityLastSeenAt: Date.now() }),

  // Canvas layout snapshots
  canvasLayoutSnapshots:
    (persisted.canvasLayoutSnapshots as CanvasLayoutSnapshot[] | undefined) ?? [],
  saveCanvasLayoutSnapshot: (name) =>
    set((state) => {
      const positions: CanvasLayoutSnapshot["positions"] = {};
      for (const node of state.nodes) {
        if (node.type !== "agent") continue;
        positions[node.id] = { x: node.position.x, y: node.position.y };
      }
      if (Object.keys(positions).length === 0) return state;

      const snapshot: CanvasLayoutSnapshot = {
        id: `layout-${Date.now()}`,
        name: name || `Layout ${new Date().toLocaleTimeString()}`,
        createdAt: Date.now(),
        positions,
      };

      return {
        canvasLayoutSnapshots: [snapshot, ...state.canvasLayoutSnapshots].slice(0, 8),
      };
    }),
  restoreCanvasLayoutSnapshot: (id) =>
    set((state) => {
      const snapshot = state.canvasLayoutSnapshots.find((layout) => layout.id === id);
      if (!snapshot) return state;
      return {
        nodes: state.nodes.map((node) => {
          const position = snapshot.positions[node.id];
          return position ? { ...node, position } : node;
        }),
      };
    }),
  removeCanvasLayoutSnapshot: (id) =>
    set((state) => ({
      canvasLayoutSnapshots: state.canvasLayoutSnapshots.filter((layout) => layout.id !== id),
    })),
}));

// Auto-persist UI state to localStorage on change
useStore.subscribe((state) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        lastPickedDirectory: state.lastPickedDirectory,
        sessionListOpen: state.sessionListOpen,
        collapsedSessionGroups: state.collapsedSessionGroups,
        viewMode: state.viewMode,
        focusedSessionIds: state.focusedSessionIds,
        splitRatios: state.splitRatios,
        openMarkdownFiles: state.openMarkdownFiles,
        diffRepoPath: state.diffRepoPath,
        diffAutoOpen: state.diffAutoOpen,
        diffLayout: state.diffLayout,
        diffWrap: state.diffWrap,
        diffTheme: state.diffTheme,
        browserUrl: state.browserUrl,
        browserPanelOpen: state.browserPanelOpen,
        browserPanelWidth: state.browserPanelWidth,
        workspaceBackground: state.workspaceBackground,
        terminalTheme: state.terminalTheme,
        terminalFontFamily: state.terminalFontFamily,
        terminalFontSize: state.terminalFontSize,
        activityLastSeenAt: state.activityLastSeenAt,
        agentActivityEvents: state.agentActivityEvents,
        launchPromptTemplates: state.launchPromptTemplates.filter((template) => !template.builtIn),
        canvasLayoutSnapshots: state.canvasLayoutSnapshots,
      })
    );
  } catch {
    // localStorage full or unavailable — ignore
  }
});
