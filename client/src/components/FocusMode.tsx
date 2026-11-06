import { lazy, Suspense, useState, useCallback, useMemo, useEffect, useRef, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Maximize2,
  Wrench,
  MessageSquare,
  WifiOff,
  RotateCcw,
  Columns,
  Rows,
  Grid2X2,
  Square,
  Plus,
  ChevronLeft,
  Search,
  History,
  ListPlus,
  Globe,
  GitBranch,
  Folder,
  Command,
  FileText,
  Layers3,
  Undo2,
  RadioTower,
  ChevronDown,
  Check,
  AlertTriangle,
  Workflow,
  Code2,
  Loader2,
} from "lucide-react";
import { resumeSession } from "../utils/resumeSession";
import { useStore } from "../stores/useStore";
import { getTerminalTheme } from "../theme/appearance";
import {
  Terminal,
  getTerminalInputSyncState,
  sendTerminalInputDirect,
  type TerminalInputSyncState,
} from "./Terminal";
import { ResizableSplit } from "./ResizableSplit";
import { InPaneMarkdown } from "./InPaneMarkdown";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { AGENT_STATUS, agentStatusStyle } from "../theme/agentStatus";
import {
  TerminalWorkbenchPanel,
  type TerminalWorkbenchPanelMode,
} from "./TerminalWorkbenchPanel";
import { TerminalCommandSearch } from "./TerminalCommandSearch";
import { TerminalBlockView } from "./TerminalBlockView";
import { TerminalLaunchLibrary } from "./TerminalLaunchLibrary";
import {
  collectWorkspaceSessionIds,
  mapWorkspaceLayout,
  type TerminalWorkspacePaneNode,
  useTerminalWorkspace,
} from "./useTerminalWorkspace";

const toolDisplayNames: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Finding",
  Task: "Tasking",
  WebFetch: "Fetching",
  WebSearch: "Searching",
};

type SplitLayout = "auto" | "columns" | "rows" | "grid";
type SynchronizedInputScope = "none" | "current-tab" | "all-tabs";

const CodeWorkspace = lazy(() => import("./CodeWorkspace").then((module) => ({ default: module.CodeWorkspace })));

type SynchronizedPaneEligibility = {
  state: "source" | "ready" | "paused" | "offline" | "editor-mismatch";
  label: string;
};

export function FocusMode() {
  const {
    viewMode,
    setViewMode,
    focusedSessionIds,
    addFocusedSession,
    removeFocusedSession,
    sessions,
    nodes,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
    terminalTheme,
    browserPanelOpen,
    setBrowserPanelOpen,
  } = useStore();

  const [activePane, setActivePane] = useState<string | null>(null);
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
  const [layout, setLayout] = useState<SplitLayout>("auto");
  const [openedFiles, setOpenedFiles] = useState<Record<string, string | null>>({});
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [workbenchPanel, setWorkbenchPanel] = useState<TerminalWorkbenchPanelMode | null>(null);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [blockViewOpen, setBlockViewOpen] = useState(false);
  const [launchLibraryOpen, setLaunchLibraryOpen] = useState(false);
  const [launchLibraryDirty, setLaunchLibraryDirty] = useState(false);
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
  const [workflowLibraryDirty, setWorkflowLibraryDirty] = useState(false);
  const [codeWorkspaceSessionId, setCodeWorkspaceSessionId] = useState<string | null>(null);
  const [codeWorkspaceDirty, setCodeWorkspaceDirty] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabTitle, setEditingTabTitle] = useState("");
  const [synchronizedInputScope, setSynchronizedInputScope] = useState<SynchronizedInputScope>("none");
  const [synchronizedInputMenuOpen, setSynchronizedInputMenuOpen] = useState(false);
  const [synchronizedInputSourceId, setSynchronizedInputSourceId] = useState<string | null>(null);
  const [synchronizedInputStates, setSynchronizedInputStates] = useState<Record<string, TerminalInputSyncState>>({});
  const [synchronizedInputMessage, setSynchronizedInputMessage] = useState<string | null>(null);
  const [synchronizedInputDispatching, setSynchronizedInputDispatching] = useState(false);
  const synchronizedInputDispatchingRef = useRef(false);
  const terminalInputs = useRef(new Map<string, (text: string) => void>());
  const terminalPalette = getTerminalTheme(terminalTheme);
  const terminalWorkspace = useTerminalWorkspace(viewMode === "focus");
  const workspace = terminalWorkspace.workspace;
  const activeWorkspaceTab = workspace?.tabs.find((tab) => tab.id === workspace.activeTabId)
    || workspace?.tabs[0];

  const closeWorkflowLibrary = useCallback(() => {
    if (workflowLibraryDirty && !window.confirm("Discard unsaved workflow changes?")) return false;
    setWorkflowLibraryOpen(false);
    setWorkflowLibraryDirty(false);
    return true;
  }, [workflowLibraryDirty]);

  const closeLaunchLibrary = useCallback(() => {
    if (launchLibraryDirty && !window.confirm("Discard unsaved launch configuration changes?")) return false;
    setLaunchLibraryOpen(false);
    setLaunchLibraryDirty(false);
    return true;
  }, [launchLibraryDirty]);

  const closeCodeWorkspace = useCallback(() => {
    if (codeWorkspaceDirty && !window.confirm("Discard unsaved editor changes?")) return false;
    setCodeWorkspaceSessionId(null);
    setCodeWorkspaceDirty(false);
    return true;
  }, [codeWorkspaceDirty]);

  const setOpenedFile = (nodeId: string, path: string | null) => {
    setOpenedFiles((prev) => ({ ...prev, [nodeId]: path }));
  };

  const pinnedSessions = useMemo(
    () =>
      focusedSessionIds
        .map((nodeId) => ({
          nodeId,
          session: sessions.get(nodeId),
          node: nodes.find((n) => n.id === nodeId),
        }))
        .filter((e) => e.session != null),
    [focusedSessionIds, sessions, nodes]
  );

  const sessionsBySessionId = useMemo(() => new Map(
    Array.from(sessions.entries()).map(([nodeId, session]) => [
      session.sessionId,
      { nodeId, session, node: nodes.find((item) => item.id === nodeId) },
    ]),
  ), [sessions, nodes]);

  useEffect(() => {
    if (codeWorkspaceSessionId && !sessionsBySessionId.has(codeWorkspaceSessionId)) {
      setCodeWorkspaceSessionId(null);
      setCodeWorkspaceDirty(false);
    }
  }, [codeWorkspaceSessionId, sessionsBySessionId]);

  const focusedSessions = useMemo(() => {
    if (!workspace) return pinnedSessions;
    if (!activeWorkspaceTab) return [];
    return collectWorkspaceSessionIds(activeWorkspaceTab.root)
      .map((sessionId) => sessionsBySessionId.get(sessionId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }, [activeWorkspaceTab, pinnedSessions, sessionsBySessionId, workspace]);

  const workspaceVisibleSessionIds = useMemo(() => new Set(
    workspace?.tabs.flatMap((tab) => collectWorkspaceSessionIds(tab.root)) || [],
  ), [workspace]);

  const availableSessions = useMemo(
    () =>
      Array.from(sessions.entries())
        .filter(([nodeId, session]) => workspace
          ? !workspaceVisibleSessionIds.has(session.sessionId)
          : !focusedSessionIds.includes(nodeId))
        .map(([nodeId, session]) => ({
          nodeId,
          session,
          node: nodes.find((n) => n.id === nodeId),
        })),
    [focusedSessionIds, sessions, nodes, workspace, workspaceVisibleSessionIds]
  );

  const synchronizedSessionIdsFor = useCallback((sourceSessionId: string, scope: Exclude<SynchronizedInputScope, "none">) => {
    if (!workspace) return [];
    const sourceTab = workspace.tabs.find((tab) =>
      collectWorkspaceSessionIds(tab.root).includes(sourceSessionId)
    );
    if (!sourceTab) return [];
    return scope === "all-tabs"
      ? workspace.tabs.flatMap((tab) => collectWorkspaceSessionIds(tab.root))
      : collectWorkspaceSessionIds(sourceTab.root);
  }, [workspace]);

  const readSynchronizedInputState = useCallback((sessionId: string) =>
    synchronizedInputStates[sessionId] || getTerminalInputSyncState(sessionId),
  [synchronizedInputStates]);

  const synchronizedPaneEligibility = useCallback((
    sessionId: string,
    sourceSessionId = synchronizedInputSourceId || activeWorkspaceTab?.activeSessionId || "",
  ): SynchronizedPaneEligibility => {
    if (!sourceSessionId || synchronizedInputScope === "none") return { state: "paused", label: "Not synchronized" };
    const targetIds = synchronizedSessionIdsFor(sourceSessionId, synchronizedInputScope);
    if (!targetIds.includes(sessionId)) return { state: "paused", label: "Outside sync scope" };
    if (sessionId === sourceSessionId) return { state: "source", label: "Sync source" };
    const source = readSynchronizedInputState(sourceSessionId);
    const target = readSynchronizedInputState(sessionId);
    if (!target?.connected) return { state: "offline", label: "Sync offline" };
    if (!source?.connected) return { state: "paused", label: "Source unavailable" };
    if (source.alternateScreen) {
      if (!source.editorIdentity) return { state: "paused", label: "Editor unknown" };
      if (!target.alternateScreen || !target.editorIdentity) {
        return { state: "editor-mismatch", label: "Editor mismatch" };
      }
      return target.editorIdentity === source.editorIdentity
        ? { state: "ready", label: `Synced ${source.editorIdentity}` }
        : { state: "editor-mismatch", label: "Editor mismatch" };
    }
    if (source.phase !== "at_prompt" || !source.certain) {
      return { state: "paused", label: "Sync paused" };
    }
    if (target.alternateScreen || target.phase !== "at_prompt" || !target.certain) {
      return { state: "paused", label: "Sync paused" };
    }
    return { state: "ready", label: "Synced" };
  }, [activeWorkspaceTab?.activeSessionId, readSynchronizedInputState, synchronizedInputScope, synchronizedInputSourceId, synchronizedSessionIdsFor]);

  const handlePromptInputChange = useCallback((sessionId: string, state: TerminalInputSyncState) => {
    setSynchronizedInputStates((current) => {
      const previous = current[sessionId];
      if (previous && previous.revision === state.revision && previous.connected === state.connected &&
        previous.editorIdentity === state.editorIdentity && previous.phase === state.phase &&
        previous.alternateScreen === state.alternateScreen && previous.certain === state.certain &&
        previous.buffer === state.buffer) return current;
      return { ...current, [sessionId]: state };
    });
  }, []);

  const stopSynchronizedInput = useCallback((message?: string) => {
    setSynchronizedInputScope("none");
    setSynchronizedInputMenuOpen(false);
    setSynchronizedInputSourceId(null);
    setSynchronizedInputMessage(message || null);
  }, []);

  const startSynchronizedInput = useCallback((scope: Exclude<SynchronizedInputScope, "none">) => {
    const sourceSessionId = activeWorkspaceTab?.activeSessionId;
    if (!workspace || !sourceSessionId) {
      setSynchronizedInputMessage("Open a terminal workspace before synchronizing input.");
      return;
    }
    const targetIds = synchronizedSessionIdsFor(sourceSessionId, scope);
    if (targetIds.length < 2) {
      setSynchronizedInputMessage(scope === "all-tabs" ? "Add another workspace pane or tab first." : "Split this tab before synchronizing input.");
      return;
    }
    for (const targetSessionId of targetIds) {
      if (targetSessionId === sourceSessionId) continue;
      const state = getTerminalInputSyncState(targetSessionId);
      if (state?.connected && state.phase === "at_prompt" && state.certain && !state.alternateScreen && state.buffer) {
        sendTerminalInputDirect(targetSessionId, "\x15", false);
      }
    }
    setSynchronizedInputScope(scope);
    setSynchronizedInputSourceId(sourceSessionId);
    setSynchronizedInputMenuOpen(false);
    setSynchronizedInputMessage(null);
  }, [activeWorkspaceTab?.activeSessionId, synchronizedSessionIdsFor, workspace]);

  const dispatchSynchronizedCommand = useCallback(async (sourceSessionId: string, command: string) => {
    if (synchronizedInputScope === "none" || synchronizedInputDispatchingRef.current) return;
    synchronizedInputDispatchingRef.current = true;
    setSynchronizedInputDispatching(true);
    setSynchronizedInputMessage(null);
    try {
      const response = await fetch("/api/terminal/synchronized-input/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSessionId, scope: synchronizedInputScope, command }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Synchronized command could not be dispatched");
      const dispatched = Array.isArray(body.dispatchedSessionIds) ? body.dispatchedSessionIds.length : 0;
      const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;
      setSynchronizedInputMessage(skipped > 0
        ? `Sent to ${dispatched}; ${skipped} pane${skipped === 1 ? "" : "s"} paused.`
        : `Sent to ${dispatched} panes.`);
    } catch (error) {
      setSynchronizedInputMessage(error instanceof Error ? error.message : "Synchronized command failed");
    } finally {
      synchronizedInputDispatchingRef.current = false;
      setSynchronizedInputDispatching(false);
    }
  }, [synchronizedInputScope]);

  const handleSynchronizedUserInput = useCallback((sourceSessionId: string, data: string): boolean => {
    if (synchronizedInputScope === "none") return false;
    const source = getTerminalInputSyncState(sourceSessionId);
    if (!source?.connected) return false;
    setSynchronizedInputSourceId(sourceSessionId);

    if (source.alternateScreen) {
      if (!source.editorIdentity) {
        setSynchronizedInputMessage("Synchronization is paused because the full-screen program could not be identified.");
        return false;
      }
      const targetIds = synchronizedSessionIdsFor(sourceSessionId, synchronizedInputScope);
      let delivered = 0;
      for (const targetSessionId of targetIds) {
        const target = getTerminalInputSyncState(targetSessionId);
        if (!target?.connected || !target.alternateScreen || target.editorIdentity !== source.editorIdentity) continue;
        if (sendTerminalInputDirect(targetSessionId, data, targetSessionId === sourceSessionId)) delivered++;
      }
      setSynchronizedInputMessage(delivered < targetIds.length
        ? `${source.editorIdentity}: ${delivered} of ${targetIds.length} matching editors.`
        : null);
      return delivered > 0;
    }

    if (source.phase !== "at_prompt" || !source.certain) return false;
    if ((data === "\r" || data === "\n") && source.buffer.trim()) {
      void dispatchSynchronizedCommand(sourceSessionId, source.buffer);
      return true;
    }
    return false;
  }, [dispatchSynchronizedCommand, synchronizedInputScope, synchronizedSessionIdsFor]);

  const synchronizedTargetSessionIds = useMemo(() => {
    if (synchronizedInputScope === "none") return [];
    const sourceSessionId = synchronizedInputSourceId || activeWorkspaceTab?.activeSessionId;
    return sourceSessionId ? synchronizedSessionIdsFor(sourceSessionId, synchronizedInputScope) : [];
  }, [activeWorkspaceTab?.activeSessionId, synchronizedInputScope, synchronizedInputSourceId, synchronizedSessionIdsFor]);

  useEffect(() => {
    if (viewMode !== "focus" && synchronizedInputScope !== "none") {
      stopSynchronizedInput();
    }
  }, [stopSynchronizedInput, synchronizedInputScope, viewMode]);

  useEffect(() => {
    if (synchronizedInputScope === "none") return;
    const sourceSessionId = synchronizedInputSourceId || activeWorkspaceTab?.activeSessionId;
    if (!sourceSessionId || !workspaceVisibleSessionIds.has(sourceSessionId)) {
      stopSynchronizedInput("Synchronization stopped because its source pane closed.");
    }
  }, [activeWorkspaceTab?.activeSessionId, stopSynchronizedInput, synchronizedInputScope, synchronizedInputSourceId, workspaceVisibleSessionIds]);

  // The persisted workspace owns active/zoomed pane state. The local node IDs
  // remain as a compatibility bridge for terminal and canvas components.
  useEffect(() => {
    const active = activeWorkspaceTab
      ? sessionsBySessionId.get(activeWorkspaceTab.activeSessionId)?.nodeId
      : focusedSessions[0]?.nodeId;
    if (active && active !== activePane) setActivePane(active);
  }, [activeWorkspaceTab, focusedSessions, sessionsBySessionId]);

  useEffect(() => {
    if (activeWorkspaceTab) {
      const zoomed = activeWorkspaceTab.zoomedSessionId
        ? sessionsBySessionId.get(activeWorkspaceTab.zoomedSessionId)?.nodeId || null
        : null;
      if (zoomed !== maximizedPane) setMaximizedPane(zoomed);
      return;
    }
    if (maximizedPane && !focusedSessions.some((entry) => entry.nodeId === maximizedPane)) {
      setMaximizedPane(null);
    }
  }, [activeWorkspaceTab, focusedSessions, maximizedPane, sessionsBySessionId]);

  useEffect(() => {
    if (availableSessions.length === 0) {
      setSessionPickerOpen(false);
    }
  }, [availableSessions.length]);

  useEffect(() => {
    if (activePane && !focusedSessions.some((entry) => entry.nodeId === activePane)) {
      setActivePane(focusedSessions[0]?.nodeId || null);
    }
  }, [activePane, focusedSessions]);

  useEffect(() => {
    if (viewMode !== "focus") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && commandSearchOpen) {
        // The centered Command Center owns Escape so parameter entry can step
        // back to results before the whole surface closes.
        return;
      }
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        if (codeWorkspaceSessionId && target?.closest(".monaco-editor")) return;
        if (codeWorkspaceSessionId && target?.closest("[data-code-file-picker]")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (synchronizedInputMenuOpen) {
          setSynchronizedInputMenuOpen(false);
        } else if (blockViewOpen) {
          setBlockViewOpen(false);
        } else if (launchLibraryOpen) {
          closeLaunchLibrary();
        } else if (workflowLibraryOpen) {
          closeWorkflowLibrary();
        } else if (sessionPickerOpen) {
          setSessionPickerOpen(false);
        } else if (codeWorkspaceSessionId) {
          closeCodeWorkspace();
        } else if (workbenchPanel) {
          setWorkbenchPanel(null);
        } else if (maximizedPane) {
          setMaximizedPane(null);
        } else {
          setViewMode("canvas");
        }
        return;
      }
      const key = event.key.toLowerCase();
      const activeSessionId = activeWorkspaceTab?.activeSessionId;
      if (key === "e" && event.shiftKey && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (codeWorkspaceSessionId) {
          closeCodeWorkspace();
        } else if (activeSessionId) {
          if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
          if (launchLibraryOpen && !closeLaunchLibrary()) return;
          setCodeWorkspaceSessionId(activeSessionId);
          setCodeWorkspaceDirty(false);
          setWorkbenchPanel(null);
          setBrowserPanelOpen(false);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.altKey && activeSessionId) {
        if (key === "i") {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (synchronizedInputScope === "none") startSynchronizedInput("current-tab");
          else stopSynchronizedInput();
          return;
        }
        const direction = key === "arrowleft" ? "left"
          : key === "arrowright" ? "right"
          : key === "arrowup" ? "up"
          : key === "arrowdown" ? "down"
          : null;
        if (direction) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void terminalWorkspace.focusPane(activeSessionId, direction);
        }
        return;
      }
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return;
      if (key === "l" && event.metaKey && event.ctrlKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (launchLibraryOpen) closeLaunchLibrary();
        else {
          if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
          setLaunchLibraryOpen(true);
          setWorkbenchPanel(null);
          setCommandSearchOpen(false);
        }
        return;
      }
      if (workspace && /^[1-9]$/.test(key) && !event.shiftKey) {
        const tab = workspace.tabs[Number(key) - 1];
        if (tab) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void terminalWorkspace.activateTab(tab.id);
        }
        return;
      }
      if (activeSessionId && key === "d") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void terminalWorkspace.splitPane(activeSessionId, event.shiftKey ? "down" : "right");
        return;
      }
      if (activeSessionId && key === "w" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void terminalWorkspace.closePane(activeSessionId);
        return;
      }
      if (workspace?.closedPaneCount && key === "t" && event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void terminalWorkspace.undoClose();
        return;
      }
      if (key === "p" && !event.shiftKey) {
        if (codeWorkspaceSessionId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
        setCommandSearchOpen((open) => !open);
        setSessionPickerOpen(false);
      } else if (key === "r" && event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (workflowLibraryOpen) closeWorkflowLibrary();
        else setWorkflowLibraryOpen(true);
        setWorkbenchPanel(null);
        setCommandSearchOpen(false);
        setLaunchLibraryOpen(false);
      } else if (key === "m" && event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setBlockViewOpen((open) => !open);
        setCommandSearchOpen(false);
      } else if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!workflowLibraryOpen || closeWorkflowLibrary()) setWorkbenchPanel("find");
      } else if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!workflowLibraryOpen || closeWorkflowLibrary()) setWorkbenchPanel("queue");
      } else if (event.shiftKey && key === "h") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!workflowLibraryOpen || closeWorkflowLibrary()) setWorkbenchPanel("history");
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeWorkspaceTab, blockViewOpen, closeCodeWorkspace, closeLaunchLibrary, closeWorkflowLibrary, codeWorkspaceSessionId, commandSearchOpen, launchLibraryOpen, maximizedPane, sessionPickerOpen, setBrowserPanelOpen, setViewMode, startSynchronizedInput, stopSynchronizedInput, synchronizedInputMenuOpen, synchronizedInputScope, terminalWorkspace, viewMode, workbenchPanel, workflowLibraryOpen, workspace]);

  const handleClose = useCallback(
    (nodeId: string) => {
      const session = sessions.get(nodeId);
      if (workspace && session) {
        void terminalWorkspace.closePane(session.sessionId);
        return;
      }
      removeFocusedSession(nodeId);
      if (activePane === nodeId) {
        setActivePane(null);
      }
      if (maximizedPane === nodeId) {
        setMaximizedPane(null);
      }
      // If no more focused sessions, exit focus mode
      if (focusedSessionIds.length <= 1) {
        setViewMode("canvas");
      }
    },
    [removeFocusedSession, focusedSessionIds, setViewMode, activePane, maximizedPane, sessions, terminalWorkspace, workspace]
  );

  const handleNewSession = useCallback(
    (nodeId: string) => {
      setNewSessionForNodeId(nodeId);
      setNewSessionModalOpen(true);
    },
    [setNewSessionForNodeId, setNewSessionModalOpen]
  );

  const handleAddFocusedSession = useCallback(
    (nodeId: string) => {
      const session = sessions.get(nodeId);
      if (workspace && session) {
        void terminalWorkspace.addTab(session.sessionId, session.customName || session.agentName);
        setSessionPickerOpen(false);
        return;
      }
      addFocusedSession(nodeId);
      setActivePane(nodeId);
      setSessionPickerOpen(false);
      setMaximizedPane(null);
    },
    [addFocusedSession, sessions, terminalWorkspace, workspace]
  );

  const toggleMaximize = useCallback(
    (nodeId: string) => {
      const session = sessions.get(nodeId);
      if (workspace && session) {
        void terminalWorkspace.zoomPane(session.sessionId);
        return;
      }
      setMaximizedPane((prev) => (prev === nodeId ? null : nodeId));
    },
    [sessions, terminalWorkspace, workspace]
  );

  const toggleWorkbenchPanel = useCallback((mode: TerminalWorkbenchPanelMode) => {
    if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
    if (codeWorkspaceSessionId && !closeCodeWorkspace()) return;
    setWorkbenchPanel((current) => current === mode ? null : mode);
  }, [closeCodeWorkspace, closeWorkflowLibrary, codeWorkspaceSessionId, workflowLibraryOpen]);

  const sendToTerminal = useCallback((sessionId: string, text: string) => {
    const sendInput = terminalInputs.current.get(sessionId);
    if (!sendInput) throw new Error("The active terminal is still connecting");
    sendInput(text);
  }, []);

  const executeOrQueueCommand = useCallback(async (
    sessionId: string,
    command: string,
    sensitive: boolean,
  ) => {
    if (synchronizedInputScope !== "none") {
      await dispatchSynchronizedCommand(sessionId, command);
      return;
    }
    if (sensitive) {
      sendToTerminal(sessionId, `${command}\r`);
      return;
    }
    const response = await fetch(`/api/sessions/${sessionId}/command-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Command could not be queued");
  }, [dispatchSynchronizedCommand, sendToTerminal, synchronizedInputScope]);

  const saveActiveTabAsLaunch = useCallback(async (name: string) => {
    if (!activeWorkspaceTab) return;
    const sessionIds = collectWorkspaceSessionIds(activeWorkspaceTab.root);
    const refs = new Map(sessionIds.map((sessionId, index) => [sessionId, `pane-${index + 1}`]));
    const launchSessions = sessionIds.map((sessionId) => sessionsBySessionId.get(sessionId)?.session)
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .map((session) => ({
        ref: refs.get(session.sessionId),
        agentId: session.agentId,
        agentName: session.agentName,
        command: session.command,
        cwd: session.cwd,
        customName: session.customName,
        customColor: session.customColor || session.color,
      }));
    return await terminalWorkspace.createLaunchConfiguration({
      name,
      description: `Saved from OpenUI terminal workspace with ${launchSessions.length} pane${launchSessions.length === 1 ? "" : "s"}.`,
      sessions: launchSessions,
      layout: mapWorkspaceLayout(activeWorkspaceTab.root, refs),
      activeSessionRef: refs.get(activeWorkspaceTab.activeSessionId),
      launchMode: "atomic",
    });
  }, [activeWorkspaceTab, sessionsBySessionId, terminalWorkspace]);

  if (viewMode !== "focus" || (!workspace && focusedSessions.length === 0)) return null;

  if (workspace && workspace.tabs.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="absolute inset-0 z-[60] flex flex-col bg-[oklch(7.5%_0.004_260)]"
      >
        <div className="titlebar-drag flex h-12 flex-shrink-0 items-center border-b border-[oklch(23%_0.007_260)] bg-[oklch(8.5%_0.004_260)] pl-[74px] pr-2">
          <button
            onClick={() => {
              if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
              setViewMode("canvas");
            }}
            className="titlebar-no-drag flex h-8 items-center gap-1.5 rounded-md px-2 text-[10px] text-zinc-500 transition-colors hover:bg-[oklch(17%_0.007_260)] hover:text-zinc-200"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Canvas
          </button>
          <span className="ml-3 text-[11px] text-zinc-600">Terminal workspace</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-md text-center">
            <Layers3 className="mx-auto h-7 w-7 text-zinc-700" />
            <h2 className="mt-4 text-[14px] font-medium text-zinc-200">No open workspace tabs</h2>
            <p className="mx-auto mt-2 max-w-sm text-[11px] leading-5 text-zinc-600">
              Closed terminals are still running. Restore the last layout or open a retained session in a new tab.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {workspace.closedPaneCount > 0 && (
                <button
                  onClick={() => void terminalWorkspace.undoClose()}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-[oklch(67%_0.12_48)] px-3 text-[10px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.12_48)]"
                >
                  <Undo2 className="h-3 w-3" /> Reopen closed layout
                </button>
              )}
              {availableSessions.slice(0, 5).map(({ nodeId, session }) => (
                <button
                  key={nodeId}
                  onClick={() => handleAddFocusedSession(nodeId)}
                  className="h-8 rounded-md border border-[oklch(27%_0.008_260)] px-3 text-[10px] text-zinc-400 transition-colors hover:bg-[oklch(17%_0.007_260)] hover:text-zinc-200"
                >
                  Open {session.customName || session.agentName}
                </button>
              ))}
            </div>
            {terminalWorkspace.error && <p className="mt-4 text-[10px] text-[oklch(72%_0.12_28)]">{terminalWorkspace.error}</p>}
          </div>
        </div>
      </motion.div>
    );
  }

  const count = focusedSessions.length;
  const activeFocusSession = focusedSessions.find((item) => item.nodeId === activePane)
    || focusedSessions[0]
    || pinnedSessions[0]
    || Array.from(sessionsBySessionId.values())[0];
  if (!activeFocusSession) {
    return (
      <div className="absolute inset-0 z-[60] flex items-center justify-center bg-[oklch(7.5%_0.004_260)] text-[11px] text-zinc-600">
        Syncing workspace terminals…
      </div>
    );
  }
  const visibleSessions = maximizedPane
    ? focusedSessions.filter((s) => s.nodeId === maximizedPane)
    : focusedSessions;

  // Pick effective layout. "auto" picks columns up to 3, otherwise grid.
  const effectiveLayout: SplitLayout = maximizedPane
    ? "columns"
    : layout === "auto"
    ? count <= 3
      ? "columns"
      : "grid"
    : layout;

  const renderPane = ({
    nodeId,
    session,
    node,
  }: (typeof focusedSessions)[number]) => {
    if (!session) return null;
    const displayColor = getAgentAccentColor(
      session.agentId,
      session.customColor || session.color,
    );
    const displayName = session.customName || session.agentName;
    const iconId = (node?.data?.icon as string) || "cpu";
    const status = agentStatusStyle(session.status);
    const isActive = activePane === nodeId;
    const isDisconnected = session.status === "disconnected";
    const needsInput = session.status === "waiting_input";
    const toolDisplay = session.currentTool
      ? toolDisplayNames[session.currentTool] || session.currentTool
      : null;
    const synchronizedSourceSessionId = synchronizedInputSourceId || activeWorkspaceTab?.activeSessionId || "";
    const synchronizedArmed = synchronizedInputScope !== "none" && synchronizedTargetSessionIds.includes(session.sessionId);
    const synchronizedEligibility = synchronizedArmed
      ? synchronizedPaneEligibility(session.sessionId, synchronizedSourceSessionId)
      : null;
    const synchronizedSourceState = synchronizedSourceSessionId
      ? readSynchronizedInputState(synchronizedSourceSessionId)
      : null;
    const synchronizedSourceName = sessionsBySessionId.get(synchronizedSourceSessionId)?.session.customName ||
      sessionsBySessionId.get(synchronizedSourceSessionId)?.session.agentName || "source pane";
    const synchronizedPreview = synchronizedEligibility?.state === "ready" &&
      session.sessionId !== synchronizedSourceSessionId &&
      synchronizedSourceState?.phase === "at_prompt" &&
      synchronizedSourceState.certain &&
      !synchronizedSourceState.alternateScreen &&
      synchronizedSourceState.buffer
      ? { sourceName: synchronizedSourceName, text: synchronizedSourceState.buffer }
      : undefined;

    return (
      <div
        key={nodeId}
        className="focus-terminal-pane flex h-full min-h-0 flex-col cursor-text transition-[box-shadow,background-color] duration-150"
        onClick={() => setActivePane(nodeId)}
        onFocusCapture={() => {
          setActivePane(nodeId);
          if (workspace && activeWorkspaceTab?.activeSessionId !== session.sessionId) {
            void terminalWorkspace.focusPane(session.sessionId);
          }
        }}
        style={{
          backgroundColor: isActive ? terminalPalette.surface : terminalPalette.background,
          boxShadow: isActive
            ? `inset 0 0 0 1px color-mix(in oklch, ${displayColor} 42%, transparent)`
            : synchronizedEligibility?.state === "ready" || synchronizedEligibility?.state === "source"
              ? "inset 0 0 0 1px oklch(48% 0.07 48)"
            : needsInput
              ? `inset 0 0 0 1px color-mix(in oklch, ${status.color} 46%, transparent)`
              : "none",
        }}
      >
        <div
          className="flex h-10 flex-shrink-0 items-center justify-between border-b px-3 transition-colors"
          style={{
            borderColor: isActive
              ? `color-mix(in oklch, ${displayColor} 28%, ${terminalPalette.border})`
              : terminalPalette.border,
            backgroundColor: needsInput
              ? `color-mix(in oklch, ${status.color} 8%, ${terminalPalette.surface})`
              : isActive
                ? terminalPalette.surface
                : terminalPalette.background,
          }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: `color-mix(in oklch, ${displayColor} 14%, transparent)` }}
            >
              <AgentIcon
                agentId={session.agentId}
                iconId={iconId}
                className="h-3 w-3"
                style={{ color: displayColor }}
              />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[11px] font-medium text-zinc-100">
                  {displayName}
                </span>
                <span className="flex flex-shrink-0 items-center gap-1 text-[9px]" style={{ color: status.color }}>
                  <span className="relative flex h-1.5 w-1.5">
                    {(session.status === "running" || session.status === "tool_calling") && (
                      <span
                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-30 motion-reduce:animate-none"
                        style={{ backgroundColor: status.color, animationDuration: "2s" }}
                      />
                    )}
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                  </span>
                  {status.label}
                </span>
                {synchronizedEligibility && (
                  <span
                    className={`flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-medium ${
                      synchronizedEligibility.state === "source" || synchronizedEligibility.state === "ready"
                        ? "bg-[oklch(20%_0.025_48)] text-[oklch(78%_0.10_48)]"
                        : synchronizedEligibility.state === "offline"
                          ? "bg-[oklch(18%_0.03_28)] text-[oklch(72%_0.10_28)]"
                          : "bg-[oklch(17%_0.007_260)] text-zinc-500"
                    }`}
                    title={synchronizedEligibility.label}
                  >
                    {synchronizedEligibility.state === "paused" || synchronizedEligibility.state === "editor-mismatch"
                      ? <AlertTriangle className="h-2.5 w-2.5" />
                      : <RadioTower className="h-2.5 w-2.5" />}
                    {synchronizedEligibility.label}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-zinc-600">
                <Folder className="h-2.5 w-2.5 flex-shrink-0" />
                <span className="max-w-[30ch] truncate font-mono">{session.cwd || "~"}</span>
                {session.gitBranch && (
                  <>
                    <span className="text-zinc-800">/</span>
                    <GitBranch className="h-2.5 w-2.5 flex-shrink-0" />
                    <span className="max-w-[16ch] truncate">{session.gitBranch}</span>
                  </>
                )}
              </div>
            </div>
            {session.status === "tool_calling" && toolDisplay && (
              <span className="hidden flex-shrink-0 items-center gap-1 text-[9px] text-zinc-500 lg:flex">
                <Wrench className="h-2.5 w-2.5" />
                {toolDisplay}
              </span>
            )}
            {needsInput && (
              <MessageSquare className="h-3 w-3 flex-shrink-0" style={{ color: status.color }} />
            )}
            {isDisconnected && (
              <WifiOff className="h-3 w-3 flex-shrink-0" style={{ color: status.color }} />
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-0.5">
            {isDisconnected && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void resumeSession(session.sessionId, nodeId);
                }}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[9px] text-[oklch(72%_0.12_28)] transition-colors hover:bg-[oklch(20%_0.04_28)]"
                title={session.resumable ? "Resume this conversation in place" : "Relaunch this session in place"}
              >
                <RotateCcw className="h-3 w-3" />
                {session.resumable ? "Resume" : "Relaunch"}
              </button>
            )}
            {workspace && (
              <>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void terminalWorkspace.splitPane(session.sessionId, "right");
                  }}
                  disabled={terminalWorkspace.busy}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30"
                  title="Split right (Cmd+D)"
                  aria-label={`Split ${displayName} right`}
                >
                  <Columns className="h-3 w-3" />
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void terminalWorkspace.splitPane(session.sessionId, "down");
                  }}
                  disabled={terminalWorkspace.busy}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30"
                  title="Split down (Cmd+Shift+D)"
                  aria-label={`Split ${displayName} down`}
                >
                  <Rows className="h-3 w-3" />
                </button>
              </>
            )}
            {count > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMaximize(nodeId);
                }}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  maximizedPane === nodeId
                    ? "bg-[oklch(22%_0.025_48)] text-[oklch(78%_0.10_48)]"
                    : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
                title={maximizedPane === nodeId ? "Restore" : "Maximize"}
              >
                <Maximize2 className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClose(nodeId);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title={workspace ? "Close pane; terminal keeps running (Cmd+W)" : "Remove from focus view"}
              aria-label={workspace ? `Close ${displayName} pane` : `Remove ${displayName} from focus view`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div
          className="flex-1 min-h-0 relative"
          style={{ backgroundColor: terminalPalette.background }}
        >
          {isDisconnected && (
            <div className="absolute inset-x-4 top-4 z-20 flex items-center justify-between rounded-md border border-[oklch(38%_0.07_28)] bg-[oklch(17%_0.03_28)] px-3 py-2 text-[11px] text-[oklch(78%_0.10_28)]">
              <span>
                {session.resumable
                  ? "This terminal is offline. Resume picks the conversation back up."
                  : "This terminal is offline. Its scrollback is still available."}
              </span>
              <span className="ml-3 flex items-center gap-1">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void resumeSession(session.sessionId, nodeId);
                  }}
                  className="rounded px-2 py-1 text-[10px] font-medium hover:bg-[oklch(22%_0.05_28)]"
                >
                  {session.resumable ? "Resume" : "Relaunch"}
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleNewSession(nodeId);
                  }}
                  className="rounded px-2 py-1 text-[10px] font-medium text-[oklch(65%_0.06_28)] hover:bg-[oklch(22%_0.05_28)]"
                >
                  New session
                </button>
              </span>
            </div>
          )}
          <Terminal
            key={`focus-${session.sessionId}`}
            sessionId={session.sessionId}
            color={displayColor}
            nodeId={nodeId}
            cwd={session.cwd}
            initialCols={session.terminalCols}
            initialRows={session.terminalRows}
            workbench
            onReady={(sendInput) => terminalInputs.current.set(session.sessionId, sendInput)}
            onPromptInputChange={handlePromptInputChange}
            onUserInput={handleSynchronizedUserInput}
            synchronizedPreview={synchronizedPreview}
            onOpenFile={(p) => setOpenedFile(nodeId, p)}
          />
          {blockViewOpen && isActive && (
            <TerminalBlockView
              sessionId={session.sessionId}
              sessionName={displayName}
              onClose={() => setBlockViewOpen(false)}
            />
          )}
          <AnimatePresence>
            {openedFiles[nodeId] && (
              <InPaneMarkdown
                key={openedFiles[nodeId]!}
                path={openedFiles[nodeId]!}
                onClose={() => setOpenedFile(nodeId, null)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  };

  const renderWorkspaceNode = (workspaceNode: TerminalWorkspacePaneNode): ReactNode => {
    if (workspaceNode.type === "pane") {
      const entry = sessionsBySessionId.get(workspaceNode.sessionId);
      return entry ? renderPane(entry) : (
        <div key={workspaceNode.id} className="flex h-full items-center justify-center bg-[oklch(9%_0.004_260)] text-[10px] text-zinc-700">
          Reconnecting terminal…
        </div>
      );
    }
    return (
      <ResizableSplit
        key={workspaceNode.id}
        direction={workspaceNode.direction === "horizontal" ? "row" : "col"}
        storageKey={`workspace:${workspaceNode.id}`}
        initialRatios={workspaceNode.sizes}
        onRatiosCommit={(sizes) => void terminalWorkspace.resizeSplit(workspaceNode.id, sizes)}
      >
        {workspaceNode.children.map(renderWorkspaceNode)}
      </ResizableSplit>
    );
  };

  // The server tree is authoritative once loaded. The original flat layout
  // remains as a startup fallback while the first snapshot is in flight.
  const sessionsKey = visibleSessions.map((s) => s.nodeId).join(",");
  let body: ReactNode;
  if (activeWorkspaceTab) {
    const zoomed = activeWorkspaceTab.zoomedSessionId
      ? sessionsBySessionId.get(activeWorkspaceTab.zoomedSessionId)
      : undefined;
    body = zoomed ? renderPane(zoomed) : renderWorkspaceNode(activeWorkspaceTab.root);
  } else if (visibleSessions.length === 1) {
    body = renderPane(visibleSessions[0]);
  } else if (effectiveLayout === "rows") {
    body = (
      <ResizableSplit
        direction="col"
        storageKey={`rows:${sessionsKey}`}
      >
        {visibleSessions.map(renderPane)}
      </ResizableSplit>
    );
  } else if (effectiveLayout === "grid") {
    const cols = Math.min(4, Math.ceil(Math.sqrt(visibleSessions.length)));
    const rows: (typeof visibleSessions)[] = [];
    for (let i = 0; i < visibleSessions.length; i += cols) {
      rows.push(visibleSessions.slice(i, i + cols));
    }
    body = (
      <ResizableSplit
        direction="col"
        storageKey={`grid-rows:${sessionsKey}`}
      >
        {rows.map((row, rowIdx) =>
          row.length === 1 ? (
            renderPane(row[0])
          ) : (
            <ResizableSplit
              key={rowIdx}
              direction="row"
              storageKey={`grid-row-${rowIdx}:${row.map((s) => s.nodeId).join(",")}`}
            >
              {row.map(renderPane)}
            </ResizableSplit>
          ),
        )}
      </ResizableSplit>
    );
  } else {
    // columns (default for >1)
    body = (
      <ResizableSplit
        direction="row"
        storageKey={`cols:${sessionsKey}`}
      >
        {visibleSessions.map(renderPane)}
      </ResizableSplit>
    );
  }

  const activeSession = activeFocusSession.session!;
  const activeSessionName = activeSession.customName || activeSession.agentName;
  const codeWorkspaceEntry = codeWorkspaceSessionId
    ? sessionsBySessionId.get(codeWorkspaceSessionId)
    : undefined;
  const activeStatus = agentStatusStyle(activeSession.status);
  const synchronizedSourceSessionId = synchronizedInputSourceId || activeWorkspaceTab?.activeSessionId || "";
  const synchronizedEligibilitySummary = synchronizedTargetSessionIds.map((sessionId) =>
    synchronizedPaneEligibility(sessionId, synchronizedSourceSessionId)
  );
  const synchronizedReadyCount = synchronizedEligibilitySummary.filter((item) =>
    item.state === "ready" || item.state === "source"
  ).length;
  const synchronizedPausedCount = Math.max(0, synchronizedTargetSessionIds.length - synchronizedReadyCount);
  const workbenchButton =
    "flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[10px] text-zinc-500 transition-colors hover:bg-[oklch(17%_0.007_260)] hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[oklch(72%_0.13_48)]";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 z-[60] flex flex-col bg-[oklch(7.5%_0.004_260)]"
    >
      <div className="titlebar-drag flex h-12 flex-shrink-0 items-center border-b border-[oklch(23%_0.007_260)] bg-[oklch(8.5%_0.004_260)] pl-[74px] pr-2">
        <div className="titlebar-no-drag flex h-full min-w-0 flex-1 items-center gap-1">
          <button
            onClick={() => {
              if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
              setViewMode("canvas");
            }}
            className={`${workbenchButton} mr-1 flex-shrink-0`}
            title="Return to canvas (Escape)"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Canvas</span>
          </button>

          <div className="mx-1 h-5 w-px flex-shrink-0 bg-[oklch(23%_0.007_260)]" />

          <div className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Terminal workspace tabs">
            {workspace ? workspace.tabs.map((tab, index) => {
              const sessionIds = collectWorkspaceSessionIds(tab.root);
              const firstSession = sessionsBySessionId.get(sessionIds[0])?.session;
              const tabName = tab.title || firstSession?.customName || firstSession?.agentName || `Tab ${index + 1}`;
              const selected = tab.id === workspace.activeTabId;
              const activeTabSession = sessionsBySessionId.get(tab.activeSessionId)?.session;
              const status = activeTabSession ? agentStatusStyle(activeTabSession.status) : AGENT_STATUS.disconnected;
              const tabSynchronized = synchronizedInputScope !== "none" &&
                sessionIds.some((sessionId) => synchronizedTargetSessionIds.includes(sessionId));
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={selected}
                  className={`group relative flex h-9 max-w-[230px] flex-shrink-0 items-center rounded-md transition-colors ${
                    selected
                      ? "bg-[oklch(17%_0.007_260)] text-zinc-100"
                      : "text-zinc-500 hover:bg-[oklch(14%_0.006_260)] hover:text-zinc-300"
                  }`}
                >
                  {editingTabId === tab.id ? (
                    <input
                      autoFocus
                      value={editingTabTitle}
                      onChange={(event) => setEditingTabTitle(event.target.value)}
                      onBlur={() => {
                        void terminalWorkspace.renameTab(tab.id, editingTabTitle);
                        setEditingTabId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          setEditingTabId(null);
                          event.preventDefault();
                        }
                      }}
                      maxLength={120}
                      className="mx-2 h-6 min-w-0 w-[150px] rounded border border-[oklch(45%_0.06_48)] bg-[oklch(9%_0.004_260)] px-1.5 text-[11px] text-zinc-100 outline-none"
                      aria-label="Rename workspace tab"
                    />
                  ) : (
                    <button
                      onClick={() => void terminalWorkspace.activateTab(tab.id)}
                      onDoubleClick={() => {
                        setEditingTabId(tab.id);
                        setEditingTabTitle(tabName);
                      }}
                      className="flex h-full min-w-0 items-center gap-2 pl-2.5 pr-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
                      title={`${tabName} · ${sessionIds.length} ${sessionIds.length === 1 ? "pane" : "panes"} · double-click to rename`}
                    >
                      <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                        {activeTabSession && (activeTabSession.status === "running" || activeTabSession.status === "tool_calling") && (
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-30 motion-reduce:animate-none" style={{ backgroundColor: status.color, animationDuration: "2s" }} />
                        )}
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                      </span>
                      <span className="truncate text-[11px] font-medium">{tabName}</span>
                      {sessionIds.length > 1 && <span className="text-[9px] tabular-nums text-zinc-600">{sessionIds.length}</span>}
                      {tabSynchronized && (
                        <RadioTower
                          className="h-3 w-3 flex-shrink-0 text-[oklch(76%_0.10_48)]"
                          aria-label={`${tabName} inputs synchronized`}
                        />
                      )}
                    </button>
                  )}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void terminalWorkspace.closeTab(tab.id);
                    }}
                    className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-700 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-300 group-hover:opacity-100 focus:opacity-100"
                    title="Close tab; terminals keep running"
                    aria-label={`Close ${tabName} tab`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {selected && <span className="absolute inset-x-2 bottom-0 h-px bg-[oklch(72%_0.13_48)]" />}
                </div>
              );
            }) : focusedSessions.map(({ nodeId, session, node }) => {
              if (!session) return null;
              const selected = nodeId === activePane;
              const status = agentStatusStyle(session.status);
              const color = getAgentAccentColor(session.agentId, session.customColor || session.color);
              const name = session.customName || session.agentName;
              const iconId = (node?.data?.icon as string) || "cpu";
              return (
                <button
                  key={nodeId}
                  onClick={() => {
                    setActivePane(nodeId);
                    if (maximizedPane) setMaximizedPane(nodeId);
                  }}
                  className={`group relative flex h-9 max-w-[220px] flex-shrink-0 items-center gap-2 rounded-md px-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)] ${
                    selected
                      ? "bg-[oklch(17%_0.007_260)] text-zinc-100"
                      : "text-zinc-500 hover:bg-[oklch(14%_0.006_260)] hover:text-zinc-300"
                  }`}
                  title={`${name} · ${status.label}`}
                >
                  <AgentIcon
                    agentId={session.agentId}
                    iconId={iconId}
                    className="h-3.5 w-3.5 flex-shrink-0"
                    style={{ color }}
                  />
                  <span className="truncate text-[11px] font-medium">{name}</span>
                  <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                    {(session.status === "running" || session.status === "tool_calling") && (
                      <span
                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-30 motion-reduce:animate-none"
                        style={{ backgroundColor: status.color, animationDuration: "2s" }}
                      />
                    )}
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                  </span>
                  {selected && (
                    <span
                      className="absolute inset-x-2 bottom-0 h-px"
                      style={{ backgroundColor: status.color }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div className="relative hidden flex-shrink-0">
            <button
              onClick={() => setSessionPickerOpen((open) => !open)}
              disabled={availableSessions.length === 0}
              className={`${workbenchButton} w-8 px-0 disabled:cursor-not-allowed disabled:opacity-30`}
              title={availableSessions.length === 0 ? "All sessions are already open" : workspace ? "Open retained session in a new tab" : "Add terminal session"}
              aria-label={workspace ? "Open retained session in a new tab" : "Add terminal session"}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            <AnimatePresence>
              {sessionPickerOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute left-0 top-10 z-[90] w-72 overflow-hidden rounded-lg border border-[oklch(27%_0.008_260)] bg-[oklch(10.5%_0.005_260)] shadow-2xl"
                >
                  <div className="border-b border-[oklch(23%_0.007_260)] px-3 py-2 text-[9px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                    {workspace ? "Open as workspace tab" : "Add to workbench"}
                  </div>
                  <div className="max-h-80 overflow-y-auto p-1">
                    {availableSessions.map(({ nodeId, session, node }) => {
                      const color = getAgentAccentColor(session.agentId, session.customColor || session.color);
                      const name = session.customName || session.agentName;
                      const iconId = (node?.data?.icon as string) || session.agentId;
                      const status = agentStatusStyle(session.status);
                      return (
                        <button
                          key={nodeId}
                          onClick={() => handleAddFocusedSession(nodeId)}
                          className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[oklch(17%_0.007_260)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
                        >
                          <span
                            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
                            style={{ backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}
                          >
                            <AgentIcon agentId={session.agentId} iconId={iconId} className="h-3.5 w-3.5" style={{ color }} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] text-zinc-200">{name}</span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[9px]" style={{ color: status.color }}>
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                              {status.label}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="titlebar-no-drag ml-2 flex flex-shrink-0 items-center gap-0.5">
          <button
            onClick={() => {
              if (codeWorkspaceSessionId) {
                if (codeWorkspaceSessionId === activeSession.sessionId) {
                  closeCodeWorkspace();
                  return;
                }
                if (!closeCodeWorkspace()) return;
              }
              if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
              if (launchLibraryOpen && !closeLaunchLibrary()) return;
              if (workspace) {
                if (activeWorkspaceTab?.zoomedSessionId !== activeSession.sessionId) {
                  void terminalWorkspace.zoomPane(activeSession.sessionId);
                }
              } else {
                setActivePane(activeFocusSession.nodeId);
                setMaximizedPane(activeFocusSession.nodeId);
              }
              setCodeWorkspaceSessionId(activeSession.sessionId);
              setCodeWorkspaceDirty(false);
              setWorkbenchPanel(null);
              setCommandSearchOpen(false);
              setBrowserPanelOpen(false);
            }}
            className={`${workbenchButton} ${codeWorkspaceSessionId ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Open code workspace (Cmd+Shift+E)"
            aria-pressed={Boolean(codeWorkspaceSessionId)}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Code</span>
          </button>
          <div className="hidden">
          <button
            onClick={() => {
              setBlockViewOpen((open) => !open);
              setCommandSearchOpen(false);
            }}
            className={`${workbenchButton} ${blockViewOpen ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Semantic command blocks (Cmd+Shift+M)"
            aria-pressed={blockViewOpen}
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Blocks</span>
          </button>
          <button
            onClick={() => {
              if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
              setCommandSearchOpen((open) => !open);
            }}
            className={`${workbenchButton} ${commandSearchOpen ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Open Command Center (Cmd+P)"
            aria-pressed={commandSearchOpen}
          >
            <Command className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Command Center</span>
          </button>
          <button
            onClick={() => {
              if (workflowLibraryOpen) closeWorkflowLibrary();
              else setWorkflowLibraryOpen(true);
              setWorkbenchPanel(null);
              setCommandSearchOpen(false);
              setLaunchLibraryOpen(false);
            }}
            className={`${workbenchButton} ${workflowLibraryOpen ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Open saved commands in Command Center (Cmd+Shift+R)"
            aria-pressed={workflowLibraryOpen}
          >
            <Workflow className="h-3.5 w-3.5" />
            <span className="hidden 2xl:inline">Saved</span>
          </button>
          <button
            onClick={() => toggleWorkbenchPanel("find")}
            className={`${workbenchButton} ${workbenchPanel === "find" ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Find in active terminal (Cmd+F)"
            aria-pressed={workbenchPanel === "find"}
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Find</span>
          </button>
          <button
            onClick={() => toggleWorkbenchPanel("history")}
            className={`${workbenchButton} ${workbenchPanel === "history" ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Command history (Cmd+Shift+H)"
            aria-pressed={workbenchPanel === "history"}
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">History</span>
          </button>
          <button
            onClick={() => toggleWorkbenchPanel("queue")}
            className={`${workbenchButton} ${workbenchPanel === "queue" ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
            title="Command queue (Cmd+J)"
            aria-pressed={workbenchPanel === "queue"}
          >
            <ListPlus className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Queue</span>
          </button>
          <button
            onClick={() => {
              if (!browserPanelOpen && codeWorkspaceSessionId && !closeCodeWorkspace()) return;
              setBrowserPanelOpen(!browserPanelOpen);
            }}
            className={`${workbenchButton} ${browserPanelOpen ? "bg-[oklch(17%_0.007_260)] text-zinc-200" : ""}`}
            title="Toggle web preview (Cmd+Shift+B)"
            aria-pressed={browserPanelOpen}
          >
            <Globe className="h-3.5 w-3.5" />
            <span className="hidden 2xl:inline">Preview</span>
          </button>

          {workspace && (
            <div className={`relative flex items-center rounded-md ${
              synchronizedInputScope !== "none"
                ? "bg-[oklch(20%_0.025_48)] ring-1 ring-inset ring-[oklch(42%_0.06_48)]"
                : ""
            }`}>
              <button
                onClick={() => synchronizedInputScope === "none"
                  ? startSynchronizedInput("current-tab")
                  : stopSynchronizedInput("Synchronization stopped.")}
                className={`${workbenchButton} ${
                  synchronizedInputScope !== "none" ? "text-[oklch(80%_0.10_48)] hover:bg-[oklch(24%_0.03_48)]" : ""
                }`}
                title={synchronizedInputScope === "none"
                  ? "Synchronize all panes in current tab (Option+Cmd+I)"
                  : "Stop synchronizing input (Option+Cmd+I)"}
                aria-pressed={synchronizedInputScope !== "none"}
              >
                <RadioTower className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">
                  {synchronizedInputScope === "none"
                    ? "Sync"
                    : `${synchronizedInputScope === "current-tab" ? "This tab" : "All tabs"} · ${synchronizedTargetSessionIds.length}`}
                </span>
              </button>
              <button
                onClick={() => setSynchronizedInputMenuOpen((open) => !open)}
                className={`flex h-8 w-6 items-center justify-center rounded-r-md transition-colors ${
                  synchronizedInputScope !== "none"
                    ? "text-[oklch(72%_0.08_48)] hover:bg-[oklch(24%_0.03_48)]"
                    : "text-zinc-600 hover:bg-[oklch(17%_0.007_260)] hover:text-zinc-300"
                }`}
                title="Choose synchronized input scope"
                aria-label="Choose synchronized input scope"
                aria-haspopup="menu"
                aria-expanded={synchronizedInputMenuOpen}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              {synchronizedInputMenuOpen && (
                <div
                  className="absolute right-0 top-9 z-[100] w-72 overflow-hidden rounded-lg border border-[oklch(28%_0.01_260)] bg-[oklch(10.5%_0.005_260)] p-1 shadow-2xl"
                  role="menu"
                  aria-label="Synchronized input scope"
                >
                  <div className="px-2.5 pb-1.5 pt-1 text-[8px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                    Synchronize command input
                  </div>
                  {([
                    ["current-tab", "Current tab", "Mirror the command to every ready pane in this tab."],
                    ["all-tabs", "All tabs", "Mirror the command across every ready workspace tab."],
                  ] as const).map(([scope, label, description]) => (
                    <button
                      key={scope}
                      role="menuitemradio"
                      aria-checked={synchronizedInputScope === scope}
                      onClick={() => startSynchronizedInput(scope)}
                      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[oklch(17%_0.007_260)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
                    >
                      <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
                        {synchronizedInputScope === scope && <Check className="h-3.5 w-3.5 text-[oklch(78%_0.10_48)]" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[10px] font-medium text-zinc-200">{label}</span>
                        <span className="mt-0.5 block text-[9px] leading-4 text-zinc-600">{description}</span>
                      </span>
                    </button>
                  ))}
                  {synchronizedInputScope !== "none" && (
                    <>
                      <div className="my-1 h-px bg-[oklch(23%_0.007_260)]" />
                      <button
                        role="menuitem"
                        onClick={() => stopSynchronizedInput("Synchronization stopped.")}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[10px] text-[oklch(72%_0.10_28)] transition-colors hover:bg-[oklch(18%_0.03_28)]"
                      >
                        <span className="h-4 w-4" /> Stop synchronizing
                      </button>
                    </>
                  )}
                  <div className="px-2.5 pb-1.5 pt-2 text-[8px] text-zinc-700">⌥⌘I toggles current-tab synchronization</div>
                </div>
              )}
            </div>
          )}

          <div className="mx-1 h-5 w-px bg-[oklch(23%_0.007_260)]" />

          {workspace && (
            <>
              <button
                onClick={() => void terminalWorkspace.undoClose()}
                disabled={workspace.closedPaneCount === 0 || terminalWorkspace.busy}
                className={`${workbenchButton} w-8 px-0 disabled:cursor-not-allowed disabled:opacity-25`}
                title={workspace.closedPaneCount > 0 ? `Reopen closed pane or tab (Cmd+Shift+T) · ${workspace.closedPaneCount} available` : "No closed panes to reopen"}
                aria-label="Reopen closed pane or tab"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => {
                  if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
                  if (launchLibraryOpen) closeLaunchLibrary();
                  else setLaunchLibraryOpen(true);
                }}
                className={`${workbenchButton} ${launchLibraryOpen ? "bg-[oklch(20%_0.02_48)] text-[oklch(80%_0.10_48)]" : ""}`}
                title="Saved layouts (Ctrl+Cmd+L)"
                aria-pressed={launchLibraryOpen}
              >
                <Layers3 className="h-3.5 w-3.5" />
                <span className="hidden 2xl:inline">Launches</span>
              </button>
              {terminalWorkspace.error && (
                <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[oklch(70%_0.15_28)]" title={terminalWorkspace.error} />
              )}
            </>
          )}

          {!workspace && count > 1 && !maximizedPane && (
            <div className="flex items-center gap-0.5 rounded-md bg-[oklch(12%_0.005_260)] p-0.5" aria-label="Terminal layout">
              <button
                onClick={() => setLayout("auto")}
                className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                  layout === "auto" ? "bg-[oklch(21%_0.008_260)] text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Auto layout"
              >
                <Square className="h-3 w-3" />
              </button>
              <button
                onClick={() => setLayout("columns")}
                className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                  layout === "columns" ? "bg-[oklch(21%_0.008_260)] text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Side by side"
              >
                <Columns className="h-3 w-3" />
              </button>
              <button
                onClick={() => setLayout("rows")}
                className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                  layout === "rows" ? "bg-[oklch(21%_0.008_260)] text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Stacked"
              >
                <Rows className="h-3 w-3" />
              </button>
              {count >= 3 && (
                <button
                  onClick={() => setLayout("grid")}
                  className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                    layout === "grid" ? "bg-[oklch(21%_0.008_260)] text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
                  }`}
                  title="Grid"
                >
                  <Grid2X2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          </div>
        </div>
      </div>

      <TerminalCommandSearch
        open={commandSearchOpen || workflowLibraryOpen}
        view={workflowLibraryOpen ? "workflows" : "search"}
        sessionId={activeSession.sessionId}
        sessionName={activeSessionName}
        cwd={activeSession.cwd || ""}
        onClose={() => {
          if (workflowLibraryOpen) closeWorkflowLibrary();
          else setCommandSearchOpen(false);
        }}
        onInsert={(command) => sendToTerminal(activeSession.sessionId, command)}
        onExecute={(command, sensitive) => executeOrQueueCommand(activeSession.sessionId, command, sensitive)}
        onSelectSession={(nodeId) => {
          const selectedSession = sessions.get(nodeId);
          if (workspace && selectedSession) {
            void terminalWorkspace.focusPane(selectedSession.sessionId);
            return;
          }
          if (!focusedSessionIds.includes(nodeId)) addFocusedSession(nodeId);
          setActivePane(nodeId);
          if (maximizedPane) setMaximizedPane(nodeId);
        }}
        onAction={(action) => {
          if (action === "new-session") handleNewSession(activeFocusSession.nodeId);
          else if (action === "search-history") setWorkbenchPanel("history");
          else if (action === "open-workflows") {
            if (launchLibraryOpen && !closeLaunchLibrary()) return;
            setWorkflowLibraryOpen(true);
            setWorkbenchPanel(null);
          }
          else if (action === "open-launch-configurations") {
            if (workflowLibraryOpen && !closeWorkflowLibrary()) return;
            setLaunchLibraryOpen(true);
            setWorkbenchPanel(null);
          }
          else if (action === "synchronize-current-tab") startSynchronizedInput("current-tab");
          else if (action === "synchronize-all-tabs") startSynchronizedInput("all-tabs");
          else if (action === "stop-synchronizing") stopSynchronizedInput("Synchronization stopped.");
          else if (action === "toggle-focus") setViewMode("canvas");
        }}
        onOpenSavedCommands={() => {
          setCommandSearchOpen(false);
          setWorkflowLibraryOpen(true);
          setWorkbenchPanel(null);
          setLaunchLibraryOpen(false);
        }}
        onBackToSearch={() => {
          if (!closeWorkflowLibrary()) return;
          setCommandSearchOpen(true);
        }}
        onWorkflowDirtyChange={setWorkflowLibraryDirty}
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-[oklch(24%_0.007_260)]">{body}</div>
        <AnimatePresence initial={false}>
          {launchLibraryOpen && activeWorkspaceTab && (
            <motion.div
              key="launch-library"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "min(860px, 78vw)", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 flex-shrink-0 overflow-hidden"
            >
              <TerminalLaunchLibrary
                open
                busy={terminalWorkspace.busy}
                currentTabName={activeWorkspaceTab.title || activeSessionName}
                currentCwd={activeSession.cwd || ""}
                configurations={terminalWorkspace.launchConfigurations}
                onClose={() => { closeLaunchLibrary(); }}
                onDirtyChange={setLaunchLibraryDirty}
                onSaveCurrent={saveActiveTabAsLaunch}
                onCreate={terminalWorkspace.createLaunchConfiguration}
                onUpdate={terminalWorkspace.updateLaunchConfiguration}
                onLaunch={terminalWorkspace.launchConfiguration}
                onDelete={terminalWorkspace.deleteLaunchConfiguration}
                onImport={terminalWorkspace.importLaunchConfigurations}
              />
            </motion.div>
          )}
          {!workflowLibraryOpen && workbenchPanel && !codeWorkspaceEntry && (
            <motion.div
              key={`${activeSession.sessionId}-${workbenchPanel}`}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "min(360px, 100vw)", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 flex-shrink-0 overflow-hidden"
            >
              <TerminalWorkbenchPanel
                mode={workbenchPanel}
                sessionId={activeSession.sessionId}
                sessionName={activeSessionName}
                onClose={() => setWorkbenchPanel(null)}
                onModeChange={setWorkbenchPanel}
              />
            </motion.div>
          )}
          {codeWorkspaceEntry?.session && (
            <motion.div
              key={`code-workspace-${codeWorkspaceEntry.session.sessionId}`}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "min(860px, 68vw)", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 flex-shrink-0 overflow-hidden"
            >
              <Suspense
                fallback={(
                  <div className="flex h-full w-full items-center justify-center border-l border-[oklch(23%_0.007_260)] bg-[oklch(9%_0.004_260)] text-[10px] text-zinc-600">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Starting code workspace…
                  </div>
                )}
              >
                <CodeWorkspace
                  sessionId={codeWorkspaceEntry.session.sessionId}
                  sessionName={codeWorkspaceEntry.session.customName || codeWorkspaceEntry.session.agentName}
                  cwd={codeWorkspaceEntry.session.cwd || ""}
                  onDirtyChange={setCodeWorkspaceDirty}
                />
              </Suspense>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex h-6 flex-shrink-0 items-center justify-between border-t border-[oklch(21%_0.007_260)] bg-[oklch(8.5%_0.004_260)] px-3 text-[9px] text-zinc-600">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5" style={{ color: activeStatus.color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: activeStatus.color }} />
            {activeStatus.label}
          </span>
          {synchronizedInputScope === "none" && synchronizedInputMessage && (
            <span className="hidden max-w-[42ch] truncate text-[oklch(72%_0.10_28)] lg:inline" role="status">
              {synchronizedInputMessage}
            </span>
          )}
          <span className="hidden min-w-0 items-center gap-1.5 sm:flex">
            <Folder className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate font-mono">{activeSession.cwd || "~"}</span>
          </span>
          {synchronizedInputScope !== "none" && (
            <span className="flex items-center gap-1.5 text-[oklch(76%_0.09_48)]" role="status">
              <RadioTower className={`h-2.5 w-2.5 ${synchronizedInputDispatching ? "animate-pulse motion-reduce:animate-none" : ""}`} />
              <span>{synchronizedInputScope === "current-tab" ? "Current tab" : "All tabs"}</span>
              <span className="text-[oklch(60%_0.05_48)]">·</span>
              <span>{synchronizedReadyCount} ready</span>
              {synchronizedPausedCount > 0 && <span className="text-zinc-600">· {synchronizedPausedCount} paused</span>}
              {synchronizedInputMessage && <span className="hidden max-w-[34ch] truncate text-zinc-600 xl:inline">· {synchronizedInputMessage}</span>}
              <button
                onClick={() => stopSynchronizedInput("Synchronization stopped.")}
                className="rounded px-1 py-0.5 text-[8px] font-medium text-[oklch(78%_0.10_48)] hover:bg-[oklch(20%_0.025_48)]"
              >
                Stop
              </button>
            </span>
          )}
          {activeSession.gitBranch && (
            <span className="hidden items-center gap-1.5 lg:flex">
              <GitBranch className="h-2.5 w-2.5" />
              {activeSession.gitBranch}
            </span>
          )}
        </div>
        <div className="ml-3 flex flex-shrink-0 items-center gap-3">
          {workspace && <span>⌘D Split</span>}
          {workspace && <span>⌘⇧D Split down</span>}
          {workspace && <span>⌥⌘I Sync</span>}
          {workspace && workspace.closedPaneCount > 0 && <span>⌘⇧T Reopen</span>}
          <span>⌘⇧M Blocks</span>
          <span className="hidden xl:inline">⌘⇧E Code</span>
          <span className="hidden xl:inline">{codeWorkspaceSessionId ? "⌘P Files" : "⌘P Command Center"}</span>
          <span className="hidden 2xl:inline">⌘⇧R Saved commands</span>
          <span className="hidden 2xl:inline">⌘F Find</span>
          <span className="hidden 2xl:inline">⌘J Queue</span>
          <span>Esc Canvas</span>
        </div>
      </div>
    </motion.div>
  );
}
