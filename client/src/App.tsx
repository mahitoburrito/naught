import { useEffect, useCallback, useRef, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useStoreApi,
  BackgroundVariant,
  ReactFlowProvider,
  NodeChange,
  SelectionMode,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus } from "lucide-react";

import { useStore, type AgentSession } from "./stores/useStore";
import { getWorkspaceBackground } from "./theme/appearance";
import { AgentNode } from "./components/AgentNode/index";
import { CategoryNode } from "./components/CategoryNode";
import { Sidebar } from "./components/Sidebar";
import { SessionListPanel } from "./components/SessionListPanel";
import { FocusMode } from "./components/FocusMode";
import { SessionOverview } from "./components/SessionOverview";
import { MarkdownView } from "./components/MarkdownView";
import { DiffView } from "./components/DiffView";
import { BrowserView } from "./components/BrowserView";
import { NewSessionModal } from "./components/NewSessionModal";
import { AgentProfileLibrary } from "./components/AgentProfileLibrary";
import { Header } from "./components/Header";
import { CanvasControls } from "./components/CanvasControls";
import { SelectionActionBar } from "./components/SelectionActionBar";
import { UndoDeleteToast } from "./components/UndoDeleteToast";
import { AgentActivityCenter } from "./components/AgentActivityCenter";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { ApprovalSheet } from "./components/compute/ApprovalSheet";
import { MoveSheet } from "./components/move/MoveSheet";
import type { MoveState } from "./types/compute";
import { installRightDockExclusion } from "./stores/rightDock";
import { getAgentAccentColor } from "./components/AgentIcon";
import { CoordinatorPanel } from "./components/CoordinatorPanel";
import { CoordinatorInteractionDialog } from "./components/CoordinatorInteractionDialog";
import { useCoordinatorAgentIPC } from "./hooks/useCoordinatorAgentIPC";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { destroyCachedTerminal } from "./components/Terminal";
import { bulkDeleteSessions } from "./utils/bulkDeleteSessions";

const nodeTypes = {
  agent: AgentNode,
  category: CategoryNode,
};

// Remember the last repo we auto-opened so a single finish event doesn't keep
// re-triggering while the user is already looking at that repo's diff.
let lastAutoOpenedRepo: string | null = null;

// A move advances through several steps between polls; compare the fields a
// card renders rather than the whole object so a quiet session never re-renders.
function moveStateChanged(current: MoveState | undefined, next: MoveState | undefined): boolean {
  if (!current || !next) return !!current !== !!next;
  return (
    current.state !== next.state ||
    current.updatedAt !== next.updatedAt ||
    current.error !== next.error ||
    current.nodeId !== next.nodeId ||
    current.direction !== next.direction
  );
}

// When an agent finishes, surface the diff viewer if its repo has uncommitted
// changes — but never yank the user out of a view they deliberately opened.
async function maybeAutoOpenDiff(repo: string | undefined) {
  if (!repo) return;
  const {
    diffAutoOpen,
    viewMode,
    setDiffRepoPath,
    setViewMode,
  } = useStore.getState();

  if (!diffAutoOpen) return;
  // Only auto-open from the canvas; respect focus/markdown/diff views.
  if (viewMode !== "canvas") return;
  // Already showing this repo — don't re-trigger.
  if (lastAutoOpenedRepo === repo) return;

  try {
    const res = await fetch(`/api/diff/files?path=${encodeURIComponent(repo)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.error || !Array.isArray(data.files) || data.files.length === 0) return;

    // Re-check the view in case the user navigated during the fetch.
    if (useStore.getState().viewMode !== "canvas") return;
    lastAutoOpenedRepo = repo;
    setDiffRepoPath(repo);
    setViewMode("diff");
  } catch {
    // Network/path error — silently skip auto-open.
  }
}

function restoreServerSessionToCanvas(sessionData: any) {
  if (!sessionData?.nodeId || !sessionData?.sessionId) return;

  const {
    sessions,
    nodes,
    agents,
    addSession,
    addNode,
  } = useStore.getState();

  if (sessions.has(sessionData.nodeId)) return;

  const agent = agents.find((item) => item.id === sessionData.agentId);
  const color = getAgentAccentColor(
    sessionData.agentId,
    sessionData.customColor || agent?.color,
  );
  const restoredSession: AgentSession = {
    id: sessionData.nodeId,
    sessionId: sessionData.sessionId,
    agentId: sessionData.agentId,
    agentName: sessionData.agentName,
    command: sessionData.command,
    color,
    createdAt: sessionData.createdAt,
    cwd: sessionData.cwd,
    originalCwd: sessionData.originalCwd,
    gitBranch: sessionData.gitBranch,
    status: sessionData.status || "idle",
    statusChangedAt: sessionData.statusChangedAt,
    customName: sessionData.customName,
    customColor: sessionData.customColor,
    notes: sessionData.notes,
    isRestored: sessionData.isRestored,
    ticketId: sessionData.ticketId,
    ticketTitle: sessionData.ticketTitle,
    worktreePaths: sessionData.worktreePaths,
    launchCheckpoint: sessionData.launchCheckpoint,
    changeSummary: sessionData.changeSummary,
    agentProfileId: sessionData.agentProfileId,
    agentProfileVersion: sessionData.agentProfileVersion,
    agentPermissionPolicy: sessionData.agentPermissionPolicy,
    agentModel: sessionData.agentModel,
    terminalCols: sessionData.terminalCols,
    terminalRows: sessionData.terminalRows,
    devboxId: sessionData.devboxId || undefined,
    devboxName: sessionData.devboxName || undefined,
    remotePath: sessionData.remotePath || undefined,
    move: sessionData.move || undefined,
  };

  addSession(sessionData.nodeId, restoredSession);

  if (nodes.some((node) => node.id === sessionData.nodeId)) return;
  const index = nodes.length;
  addNode({
    id: sessionData.nodeId,
    type: "agent",
    position: {
      x: 120 + (index % 5) * 240,
      y: 120 + Math.floor(index / 5) * 160,
    },
    data: {
      label: sessionData.customName || sessionData.agentName,
      agentId: sessionData.agentId,
      color,
      icon: agent?.icon || "cpu",
      sessionId: sessionData.sessionId,
    },
  });
}

function AppContent() {
  const {
    nodes: storeNodes,
    setNodes: setStoreNodes,
    setAgents,
    setLaunchCwd,
    setTerminalOsc52ClipboardAccess,
    setSelectedNodeId,
    setSidebarOpen,
    updateSession,
    agents,
    addAgentModalOpen,
    setAddAgentModalOpen,
    newSessionModalOpen,
    setNewSessionModalOpen,
    newSessionForNodeId,
    setNewSessionForNodeId,
    sessions,
    sessionListOpen,
    viewMode,
    browserPanelOpen,
    browserPanelWidth,
    workspaceBackground,
    agentProfilesOpen,
    setAgentProfilesOpen,
    selectionModeActive,
    settingsOpen,
    setSettingsOpen,
  } = useStore();

  const [nodes, setNodes, onNodesChange] = useNodesState(storeNodes);
  const rfStore = useStoreApi();
  const workspace = getWorkspaceBackground(workspaceBackground);
  const positionUpdateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRestoredRef = useRef(false);
  const browserDockOpen = viewMode === "focus" && browserPanelOpen;

  // Initialize coordinator agent IPC listeners
  useCoordinatorAgentIPC();

  // Initialize keyboard shortcuts
  useKeyboardShortcuts();

  // Record session status changes for the quiet header activity bell.
  useDesktopNotifications();

  const refreshAgents = useCallback(async () => {
    const response = await fetch("/api/agents");
    if (!response.ok) throw new Error("Failed to refresh agent profiles");
    setAgents(await response.json());
  }, [setAgents]);

  // The sidebar and the coordinator share the inner right dock; keep exactly
  // one of them open. See stores/rightDock.ts.
  useEffect(() => installRightDockExclusion(), []);

  // Sync nodes with store
  useEffect(() => {
    setStoreNodes(nodes);
  }, [nodes, setStoreNodes]);

  // Mirror React Flow's selected flags into the store so the header and
  // selection action bar can react to the multi-selection.
  useEffect(() => {
    const ids = nodes.filter((n) => n.type === "agent" && n.selected).map((n) => n.id);
    const prev = useStore.getState().multiSelectedNodeIds;
    if (ids.length !== prev.length || ids.some((id, index) => id !== prev[index])) {
      useStore.getState().setMultiSelectedNodeIds(ids);
    }
  }, [nodes]);

  useEffect(() => {
    if (storeNodes.length > 0 || hasRestoredRef.current) {
      setNodes(storeNodes);
    }
  }, [storeNodes, setNodes]);

  // Fetch config, agents, and restore state on mount
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config) => {
        setLaunchCwd(config.launchCwd);
        setTerminalOsc52ClipboardAccess(
          config.terminalOsc52ClipboardAccess === "write_only" ||
            config.terminalOsc52ClipboardAccess === "read_write"
            ? config.terminalOsc52ClipboardAccess
            : "deny",
        );
      })
      .catch(console.error);

    fetch("/api/agents")
      .then((res) => res.json())
      .then((agents) => setAgents(agents))
      .catch(console.error);
  }, [setAgents, setLaunchCwd, setTerminalOsc52ClipboardAccess]);

  // Poll for status updates every second to catch any missed WebSocket messages
  useEffect(() => {
    const pollStatus = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const sessionsData = await res.json();
          const currentSessions = useStore.getState().sessions;
          const serverNodeIds = new Set(
            sessionsData
              .map((sessionData: any) => sessionData.nodeId)
              .filter((nodeId: unknown): nodeId is string => typeof nodeId === "string"),
          );

          if (hasRestoredRef.current) {
            for (const [nodeId, session] of currentSessions) {
              if (serverNodeIds.has(nodeId)) continue;

              const state = useStore.getState();
              destroyCachedTerminal(session.sessionId);
              state.removeSession(nodeId);
              state.removeNode(nodeId);
              if (state.selectedNodeId === nodeId) {
                state.setSelectedNodeId(null);
                state.setSidebarOpen(false);
              }
            }
          }

          // Node ids in the active undo toast were just locally deleted — a
          // poll response dispatched before their soft-deletes landed can
          // still list them and would resurrect the cards for a second.
          const activeToast = useStore.getState().deleteToast;
          const recentlyDeletedNodeIds = new Set(
            activeToast
              ? [activeToast.nodeId, ...(activeToast.items?.map((item) => item.nodeId) ?? [])]
              : [],
          );

          for (const sessionData of sessionsData) {
            if (sessionData.nodeId && sessionData.status) {
              const existing = currentSessions.get(sessionData.nodeId);
              if (!existing && hasRestoredRef.current) {
                if (recentlyDeletedNodeIds.has(sessionData.nodeId)) continue;
                restoreServerSessionToCanvas(sessionData);
                continue;
              }
              if (existing) {
                const sessionUpdates: Partial<AgentSession> = {};
                // The poll response was serialized before it got here, so a
                // websocket status that landed mid-flight is newer than this.
                // Without the timestamp check the poll rolls it back for up to
                // a second, which reads as the card flickering.
                const polledAt = typeof sessionData.statusChangedAt === "number"
                  ? sessionData.statusChangedAt
                  : 0;
                const isStale = polledAt > 0 && polledAt < (existing.statusChangedAt ?? 0);

                if (!isStale && existing.status !== sessionData.status) {
                  sessionUpdates.status = sessionData.status;
                  console.log(`[poll] Updating ${sessionData.nodeId} status: ${existing.status} -> ${sessionData.status}`);
                }
                if (polledAt > 0 && !isStale && existing.statusChangedAt !== polledAt) {
                  sessionUpdates.statusChangedAt = polledAt;
                }
                // Only the websocket used to carry this, so a card whose
                // terminal was never mounted stayed flagged as restored.
                if (existing.isRestored !== sessionData.isRestored) {
                  sessionUpdates.isRestored = sessionData.isRestored;
                }
                if (existing.terminalCols !== sessionData.terminalCols) {
                  sessionUpdates.terminalCols = sessionData.terminalCols;
                }
                if (existing.terminalRows !== sessionData.terminalRows) {
                  sessionUpdates.terminalRows = sessionData.terminalRows;
                }
                // Remote placement changes during a move (devbox set on
                // relaunch, cleared on bring-back) and the move itself steps
                // forward between polls; keep the card current on every tick.
                const nextDevboxId = sessionData.devboxId || undefined;
                const nextDevboxName = sessionData.devboxName || undefined;
                const nextRemotePath = sessionData.remotePath || undefined;
                if (existing.devboxId !== nextDevboxId) sessionUpdates.devboxId = nextDevboxId;
                if (existing.devboxName !== nextDevboxName) sessionUpdates.devboxName = nextDevboxName;
                if (existing.remotePath !== nextRemotePath) sessionUpdates.remotePath = nextRemotePath;
                const nextMove = (sessionData.move || undefined) as MoveState | undefined;
                if (moveStateChanged(existing.move, nextMove)) sessionUpdates.move = nextMove;
                // A bring-back into a fresh worktree gives the session a new cwd.
                if (typeof sessionData.cwd === "string" && sessionData.cwd && existing.cwd !== sessionData.cwd) {
                  sessionUpdates.cwd = sessionData.cwd;
                }
                if (existing.customName !== sessionData.customName) {
                  sessionUpdates.customName = sessionData.customName;
                  const title = sessionData.customName || existing.agentName;
                  const node = useStore.getState().nodes.find((item) => item.id === sessionData.nodeId);
                  if (node) {
                    useStore.getState().updateNode(sessionData.nodeId, {
                      data: { ...node.data, label: title },
                    });
                  }
                }

                if (Object.keys(sessionUpdates).length > 0) {
                  updateSession(sessionData.nodeId, sessionUpdates);
                }

                if (existing.status !== sessionData.status) {
                // An agent just finished working (active -> idle). If its repo
                // has uncommitted changes, surface the diff viewer automatically.
                const wasActive =
                  existing.status === "running" || existing.status === "tool_calling";
                if (wasActive && sessionData.status === "idle") {
                  maybeAutoOpenDiff(existing.originalCwd || existing.cwd);
                }
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };

    // Poll immediately and then every second
    pollStatus();
    const interval = setInterval(pollStatus, 1000);
    return () => clearInterval(interval);
  }, [updateSession]);

  // Poll repo change summaries so each agent card can show a source-control badge.
  useEffect(() => {
    const pollChangeSummaries = async () => {
      const currentSessions = useStore.getState().sessions;
      if (currentSessions.size === 0) return;

      try {
        const res = await fetch("/api/sessions/changes");
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.summaries)) return;

        const summariesByNode = new Map<string, any>(
          data.summaries.map((summary: any) => [summary.nodeId, summary]),
        );
        for (const [nodeId, session] of currentSessions) {
          const nextSummary = summariesByNode.get(nodeId);
          const currentCount = session.changeSummary?.changedFileCount ?? 0;
          const nextCount = nextSummary?.changedFileCount ?? 0;
          const currentShape = `${currentCount}:${session.changeSummary?.added ?? 0}:${session.changeSummary?.removed ?? 0}`;
          const nextShape = `${nextCount}:${nextSummary?.added ?? 0}:${nextSummary?.removed ?? 0}`;

          if (currentShape !== nextShape || session.changeSummary?.repoRoot !== nextSummary?.repoRoot) {
            updateSession(nodeId, { changeSummary: nextSummary });
          }
        }
      } catch {
        // Ignore transient git/server errors.
      }
    };

    pollChangeSummaries();
    const interval = setInterval(pollChangeSummaries, 5000);
    return () => clearInterval(interval);
  }, [sessions.size, updateSession]);

  // Once the user leaves the diff view, clear the auto-open guard so a later
  // agent finish on the same repo can surface the diff again.
  useEffect(() => {
    if (viewMode !== "diff") {
      lastAutoOpenedRepo = null;
    }
  }, [viewMode]);

  // Restore sessions and categories after agents are loaded
  useEffect(() => {
    if (agents.length === 0 || hasRestoredRef.current) return;

    Promise.all([
      fetch("/api/sessions").then((res) => res.json()),
      fetch("/api/state").then((res) => res.json()),
      fetch("/api/categories").then((res) => res.json()),
    ])
      .then(([sessions, { nodes: savedNodes }, categories]) => {
        const restoredNodes: any[] = [];

        // Restore categories first (they should be behind agents)
        categories.forEach((cat: any) => {
          restoredNodes.push({
            id: cat.id,
            type: "category",
            position: cat.position,
            style: { width: cat.width, height: cat.height },
            data: {
              label: cat.label,
              color: cat.color,
            },
            zIndex: -1, // Behind agent nodes
          });
        });

        // Restore agent sessions
        const { addSession: storeAddSession, setNodes: storeSetNodes } = useStore.getState();

        sessions.forEach((session: any, index: number) => {
          const saved = savedNodes?.find((n: any) => n.sessionId === session.sessionId);
          const agent = agents.find((a) => a.id === session.agentId);
          const position = saved?.position?.x
            ? saved.position
            : {
                x: 100 + (index % 5) * 220,
                y: 100 + Math.floor(index / 5) * 150,
              };

          storeAddSession(session.nodeId, {
            id: session.nodeId,
            sessionId: session.sessionId,
            agentId: session.agentId,
            agentName: session.agentName,
            command: session.command,
            color: getAgentAccentColor(session.agentId, session.customColor || agent?.color),
            createdAt: session.createdAt,
            cwd: session.cwd,
            originalCwd: session.originalCwd,
            gitBranch: session.gitBranch,
            status: session.status || "idle",
            statusChangedAt: session.statusChangedAt,
            customName: session.customName,
            customColor: session.customColor,
            notes: session.notes,
            isRestored: session.isRestored,
            ticketId: session.ticketId,
            ticketTitle: session.ticketTitle,
            worktreePaths: session.worktreePaths,
            launchCheckpoint: session.launchCheckpoint,
            changeSummary: session.changeSummary,
            terminalCols: session.terminalCols,
            terminalRows: session.terminalRows,
          });

          restoredNodes.push({
            id: session.nodeId,
            type: "agent",
            position,
            data: {
              label: session.customName || session.agentName,
              agentId: session.agentId,
              color: getAgentAccentColor(session.agentId, session.customColor || agent?.color),
              icon: agent?.icon || "cpu",
              sessionId: session.sessionId,
            },
          });
        });

        hasRestoredRef.current = true;
        setNodes(restoredNodes);
        storeSetNodes(restoredNodes);
      })
      .catch(console.error);
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps — store functions are stable via getState

  // Helper to save all positions - accepts nodes directly to avoid sync issues
  const saveAllPositions = useCallback((nodesToSave?: typeof nodes) => {
    const currentNodes = nodesToSave || useStore.getState().nodes;
    if (currentNodes.length === 0) return;

    const positions: Record<string, { x: number; y: number }> = {};
    const GRID_SIZE = 24;
    currentNodes.forEach((node) => {
      // Only save agent positions to state/positions
      if (node.type === "agent") {
        positions[node.id] = {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        };
      }
      // Save category positions/sizes separately
      if (node.type === "category") {
        // Get dimensions - could be in style, measured, or width/height
        const width = node.measured?.width || node.width || (typeof node.style?.width === 'number' ? node.style.width : parseInt(node.style?.width as string) || 250);
        const height = node.measured?.height || node.height || (typeof node.style?.height === 'number' ? node.style.height : parseInt(node.style?.height as string) || 200);

        fetch(`/api/categories/${node.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position: {
              x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
              y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
            },
            width,
            height,
          }),
        }).catch(console.error);
      }
    });
    if (Object.keys(positions).length > 0) {
      fetch("/api/state/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      }).catch(console.error);
    }
  }, [nodes]);

  // Save positions on window close/refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveAllPositions();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveAllPositions]);

  // Save positions when nodes are moved or resized
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Intercept keyboard delete — one confirm for the whole batch, soft-delete
    // on the server, then let the store sync remove the nodes from the canvas.
    // Non-session nodes (categories) are never removed via the delete key:
    // React Flow would only drop them client-side and they'd reappear on reload.
    const removeChanges = changes.filter(
      (change): change is Extract<NodeChange, { type: "remove" }> => change.type === "remove",
    );
    if (removeChanges.length > 0) {
      changes = changes.filter((c) => c.type !== "remove");
      const { sessions: currentSessions, nodes: currentStoreNodes } = useStore.getState();
      const sessionNodeIds: string[] = [];
      for (const change of removeChanges) {
        if (currentSessions.has(change.id)) {
          sessionNodeIds.push(change.id);
          continue;
        }
        // Agent nodes with no backing session (stale restore rows) have
        // nothing to soft-delete server-side — remove them client-side so
        // they aren't permanently stuck on the canvas.
        const node = currentStoreNodes.find((n) => n.id === change.id);
        if (node?.type === "agent") {
          changes = [...changes, change];
        }
      }
      if (sessionNodeIds.length > 0) {
        void bulkDeleteSessions(sessionNodeIds);
      }
    }

    onNodesChange(changes);

    const positionChanges = changes.filter(
      (c) => c.type === "position" && "dragging" in c && c.dragging === false
    );
    // Check for dimension changes - resizing property might be true, false, or undefined
    const dimensionChanges = changes.filter(
      (c) => c.type === "dimensions" && (!("resizing" in c) || c.resizing === false)
    );

    if (positionChanges.length > 0 || dimensionChanges.length > 0) {
      if (positionUpdateTimeout.current) {
        clearTimeout(positionUpdateTimeout.current);
      }
      // Compute updated nodes immediately to avoid sync delay issues
      const updatedNodes = applyNodeChanges(changes, nodes);
      positionUpdateTimeout.current = setTimeout(() => {
        saveAllPositions(updatedNodes);
      }, 300);
    }
  }, [onNodesChange, saveAllPositions, nodes]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: any) => {
      // Selection mode: a plain click toggles the session in/out of the set.
      // Selection must go through React Flow's own API — its internal store
      // applies click-selection itself, and prop-level `selected` flags on
      // unchanged node objects are ignored (checkEquality), so writing flags
      // into our nodes state directly would silently diverge from what React
      // Flow uses for group dragging.
      if (useStore.getState().selectionModeActive) {
        if (node.type !== "agent") return;
        // multiSelectedNodeIds still holds the pre-click set here: the mirror
        // effect that syncs React Flow's selection into the store hasn't
        // flushed within this DOM event. If React ever flushes effects
        // mid-click (or xyflow moves click-selection to pointerdown), this
        // toggle would compute from a collapsed set — re-verify on upgrades.
        const current = useStore.getState().multiSelectedNodeIds;
        const desired = current.includes(node.id)
          ? current.filter((id) => id !== node.id)
          : [...current, node.id];
        rfStore.getState().addSelectedNodes(desired);
        return;
      }
      // Only open sidebar for agent nodes
      if (node.type === "agent") {
        setSelectedNodeId(node.id);
        setSidebarOpen(true);
      }
    },
    [rfStore, setSelectedNodeId, setSidebarOpen]
  );

  const onPaneClick = useCallback(() => {
    // Selection mode: React Flow natively clears the selection on pane click
    if (useStore.getState().selectionModeActive) return;
    setSelectedNodeId(null);
    setSidebarOpen(false);
  }, [setSelectedNodeId, setSidebarOpen]);

  // In selection mode, dragging an unselected card makes React Flow clear the
  // whole selection at drag start (selectNodesOnDrag=false path). Stash the set
  // and restore it after the drag so nudging a stray card doesn't wipe it.
  const stashedSelectionRef = useRef<string[] | null>(null);

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: any) => {
    const { selectionModeActive: mode, multiSelectedNodeIds: ids } = useStore.getState();
    if (mode && ids.length > 0 && !ids.includes(node.id)) {
      stashedSelectionRef.current = ids;
    }
  }, []);

  const onNodeDragStop = useCallback(() => {
    if (stashedSelectionRef.current) {
      const ids = stashedSelectionRef.current;
      stashedSelectionRef.current = null;
      rfStore.getState().addSelectedNodes(ids);
    }
  }, [rfStore]);

  const isEmpty = nodes.length === 0;

  return (
    <div
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col"
      style={{
        background: workspace.canvas,
        "--workspace-bg": workspace.canvas,
        "--workspace-bg-dark": workspace.canvasDark,
        "--workspace-dots": workspace.dots,
        "--workspace-controls": workspace.controls,
        "--workspace-border": workspace.border,
      } as CSSProperties}
    >
      {viewMode !== "focus" && <Header />}

      <div className="flex-1 relative min-h-0">
        <div
          className="absolute inset-y-0 left-0 min-w-0 transition-[right] duration-300"
          style={{ right: browserDockOpen ? browserPanelWidth : 0 }}
        >
          <div className="contents" aria-hidden={viewMode === "focus"}>
            {/* Session List Panel (left sidebar) */}
            <SessionListPanel />

            {/* Canvas area — shifts right when session list is open */}
            <div
              className="absolute inset-0 transition-all duration-300"
              style={{ left: sessionListOpen ? 280 : 0, background: workspace.canvas }}
            >
            <ReactFlow
              nodes={nodes}
              edges={[]}
              onNodesChange={handleNodesChange}
              onNodeClick={onNodeClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={onPaneClick}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              minZoom={0.3}
              maxZoom={2}
              nodesDraggable
              nodesConnectable={false}
              snapToGrid
              snapGrid={[24, 24]}
              className={selectionModeActive ? "selection-mode" : undefined}
              selectionOnDrag={selectionModeActive}
              // In selection mode React Flow must not reselect-on-drag: it would
              // internally deselect the rest of the set at drag start and break
              // moving the selection as a group.
              selectNodesOnDrag={!selectionModeActive}
              panOnDrag={selectionModeActive ? [1, 2] : true}
              selectionMode={SelectionMode.Partial}
              deleteKeyCode={["Backspace", "Delete"]}
              style={{ background: workspace.canvas }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color={workspace.dots}
              />
              <Controls
                showInteractive={false}
                position="bottom-left"
              />
              <CanvasControls />
            </ReactFlow>

            {/* Empty state */}
            {isEmpty && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center pointer-events-auto">
                  <div className="w-16 h-16 rounded-2xl bg-surface border border-border flex items-center justify-center mx-auto mb-4">
                    <Plus className="w-8 h-8 text-zinc-600" />
                  </div>
                  <h2 className="text-lg font-medium text-zinc-300 mb-2">No agents yet</h2>
                  <p className="text-sm text-zinc-500 mb-4 max-w-xs">
                    Spawn your first AI agent to get started
                  </p>
                  <button
                    onClick={() => setAddAgentModalOpen(true)}
                    className="px-4 py-2 rounded-lg bg-white text-canvas font-medium text-sm hover:bg-zinc-100 transition-colors"
                  >
                    Create Agent
                  </button>
                </div>
              </div>
            )}
            </div>
          </div>

          {/* Focus Mode overlay */}
          <FocusMode />

          {/* Live terminal grid; separate from the advanced focus workspace. */}
          <SessionOverview />

          {/* Markdown viewer overlay */}
          <MarkdownView />

          {/* Diff viewer overlay */}
          <DiffView />

          <Sidebar />
          <CoordinatorPanel />
        </div>

        {/* Embedded browser dock, scoped to focus mode so the canvas never gets squeezed. */}
        {viewMode === "focus" && <BrowserView />}
      </div>

      <NewSessionModal
        open={addAgentModalOpen || newSessionModalOpen}
        onClose={() => {
          setAddAgentModalOpen(false);
          setNewSessionModalOpen(false);
          setNewSessionForNodeId(null);
        }}
        existingSession={newSessionForNodeId ? sessions.get(newSessionForNodeId) : undefined}
        existingNodeId={newSessionForNodeId || undefined}
      />

      {agentProfilesOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={() => setAgentProfilesOpen(false)}
          />
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
            <div className="pointer-events-auto">
              <AgentProfileLibrary
                onClose={() => setAgentProfilesOpen(false)}
                onProfilesChanged={refreshAgents}
              />
            </div>
          </div>
        </>
      )}

      <SelectionActionBar />
      <UndoDeleteToast />
      <AgentActivityCenter />
      <CommandPalette />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ApprovalSheet />
      <MoveSheet />
      <CoordinatorInteractionDialog />
    </div>
  );
}

function App() {
  return (
    <ReactFlowProvider>
      <AppContent />
    </ReactFlowProvider>
  );
}

export default App;
