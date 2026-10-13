import { Folder, Grid3X3, Maximize2, MousePointer2, Network, Search, Settings } from "lucide-react";
import { useStore } from "../stores/useStore";
import { useCoordinatorAgentStore } from "../stores/useCoordinatorAgentStore";

export function Header() {
  const setCoordinatorOpen = useCoordinatorAgentStore((state) => state.setPanelOpen);
  const coordinatorOpen = useCoordinatorAgentStore((state) => state.panelOpen);
  const {
    sessions,
    launchCwd,
    setCommandPaletteOpen,
    addFocusedSession,
    focusedSessionIds,
    selectedNodeId,
    setSidebarOpen,
    setViewMode,
    viewMode,
    selectionModeActive,
    setSelectionModeActive,
    setSettingsOpen,
  } = useStore();

  const selectedSession = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const canOpenFocusMode = !!selectedSession || focusedSessionIds.length > 0;

  const openFocusMode = () => {
    if (!canOpenFocusMode) return;
    if (selectedNodeId && selectedSession) addFocusedSession(selectedNodeId);
    setSidebarOpen(false);
    setViewMode("focus");
  };

  const toggleOverview = () => {
    if (sessions.size === 0) return;
    setSidebarOpen(false);
    setViewMode(viewMode === "overview" ? "canvas" : "overview");
  };

  const commandButton =
    "flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-active hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-500";

  return (
    <header className="titlebar-drag flex h-14 items-center justify-between border-b border-border bg-canvas-dark px-4">
      <div className="flex min-w-0 items-center gap-2 pl-16">
        <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-600" />
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="max-w-[360px] truncate font-mono">{launchCwd || "~"}</span>
        </div>
      </div>

      <div className="titlebar-no-drag flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCoordinatorOpen(!coordinatorOpen)}
          className={`${commandButton} ${
            coordinatorOpen ? "bg-surface-active text-zinc-100" : ""
          }`}
          title={coordinatorOpen ? "Close workspace coordinator" : "Open workspace coordinator"}
          aria-label="Open workspace coordinator"
          aria-pressed={coordinatorOpen}
        >
          <Network className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleOverview}
          disabled={sessions.size === 0}
          className={`${commandButton} ${
            viewMode === "overview" ? "bg-surface-active text-zinc-100" : ""
          }`}
          title={sessions.size > 0 ? "Session overview (Cmd+Shift+O)" : "Start a session first"}
          aria-label="Open session overview"
          aria-pressed={viewMode === "overview"}
        >
          <Grid3X3 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setSelectionModeActive(!selectionModeActive)}
          disabled={viewMode !== "canvas"}
          className={`${commandButton} ${
            selectionModeActive ? "bg-surface-active text-zinc-100" : ""
          }`}
          title={
            viewMode !== "canvas"
              ? "Selection mode is available on the canvas"
              : selectionModeActive
                ? "Exit selection mode (Esc)"
                : "Selection mode — click or drag a box to select multiple sessions"
          }
          aria-label="Selection mode"
        >
          <MousePointer2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className={commandButton}
          title="Search (Cmd+K)"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={openFocusMode}
          disabled={!canOpenFocusMode}
          className={commandButton}
          title={canOpenFocusMode ? "Open focused session" : "Choose a session first"}
          aria-label="Open focused session"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={commandButton}
          title="Settings (Cmd+,)"
          aria-label="Open settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
