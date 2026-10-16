import { useCallback, useState } from "react";
import { NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import { Check, FilePlus, Loader2 } from "lucide-react";
import { useStore, AgentStatus } from "../../stores/useStore";
import { AgentNodeCard } from "./AgentNodeCard";
import { AgentNodeContextMenu } from "./AgentNodeContextMenu";
import { useAgentNodeState } from "./useAgentNodeState";
import { getAgentAccentColor } from "../AgentIcon";
import { useComputeNodeName } from "../../hooks/useComputeNodes";

interface AgentNodeData {
  label: string;
  agentId: string;
  color: string;
  icon: string;
  sessionId: string;
}

export const AgentNode = ({ id, data, selected }: NodeProps) => {
  const nodeData = data as unknown as AgentNodeData;

  // Subscribe directly to status and currentTool as primitive values - this guarantees re-render on change
  const status: AgentStatus = useStore((state) => state.sessions.get(id)?.status) || "idle";
  const currentTool = useStore((state) => state.sessions.get(id)?.currentTool);

  // Get the full session for other data
  const session = useStore((state) => state.sessions.get(id));

  const {
    contextMenu,
    handleContextMenu,
    handleDelete,
    closeContextMenu,
    handleMove,
    handleRetryMove,
    handleCancelMove,
    moveActionBusy,
  } = useAgentNodeState(id, nodeData, session);

  // While moving out the session does not carry devboxName yet; the shared
  // nodes poller knows the destination's name from its id.
  const moveActive = !!session?.move && session.move.state !== "done" && session.move.state !== "error";
  const moveNodeName = useComputeNodeName(moveActive ? session?.move?.nodeId : undefined);

  const addFocusedSession = useStore((state) => state.addFocusedSession);
  const setViewMode = useStore((state) => state.setViewMode);
  const setDiffRepoPath = useStore((state) => state.setDiffRepoPath);
  const focusedSessionIds = useStore((state) => state.focusedSessionIds);
  const selectionModeActive = useStore((state) => state.selectionModeActive);
  const [isRestoringCheckpoint, setIsRestoringCheckpoint] = useState(false);
  const displayColor = getAgentAccentColor(
    session?.agentId || nodeData.agentId,
    session?.customColor || session?.color || nodeData.color,
  );
  const displayName = session?.customName || session?.agentName || nodeData.label || "Agent";

  const handleDoubleClick = useCallback(() => {
    if (useStore.getState().selectionModeActive) return;
    if (!focusedSessionIds.includes(id)) {
      addFocusedSession(id);
    }
    setViewMode("focus");
  }, [id, focusedSessionIds, addFocusedSession, setViewMode]);

  const handleRestoreLaunchCheckpoint = useCallback(async () => {
    const checkpoint = session?.launchCheckpoint;
    if (!checkpoint || isRestoringCheckpoint) return;

    const confirmed = window.confirm(
      `Restore ${displayName} to its start checkpoint? Current uncommitted changes in that repo will be discarded.`,
    );
    if (!confirmed) return;

    setIsRestoringCheckpoint(true);
    try {
      const res = await fetch(`/api/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: checkpoint.repoRoot || session?.cwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to restore checkpoint");
      }
      setDiffRepoPath(checkpoint.repoRoot || session?.cwd || null);
      setViewMode("diff");
    } catch (error: any) {
      window.alert(error?.message || "Failed to restore checkpoint");
    } finally {
      setIsRestoringCheckpoint(false);
    }
  }, [displayName, isRestoringCheckpoint, session?.cwd, session?.launchCheckpoint, setDiffRepoPath, setViewMode]);

  const handleReviewChanges = useCallback(() => {
    const repo = session?.changeSummary?.repoRoot || session?.cwd;
    if (!repo) return;
    setDiffRepoPath(repo);
    setViewMode("diff");
  }, [session?.changeSummary?.repoRoot, session?.cwd, setDiffRepoPath, setViewMode]);

  // Drag-and-drop file upload
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploadState, setUploadState] = useState<{
    phase: "idle" | "uploading" | "done" | "error";
    message?: string;
  }>({ phase: "idle" });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!session?.sessionId) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(true);
  }, [session?.sessionId]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingFile(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);

    if (!session?.sessionId) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploadState({ phase: "uploading", message: `Uploading ${files.length} file${files.length === 1 ? "" : "s"}...` });

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }

      const res = await fetch(`/api/sessions/${session.sessionId}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setUploadState({ phase: "error", message: err.error || "Upload failed" });
      } else {
        const body = await res.json();
        const skippedCount = Array.isArray(body.skipped) ? body.skipped.length : 0;
        const savedCount = Array.isArray(body.saved) ? body.saved.length : 0;
        const msg = skippedCount > 0
          ? `Added ${savedCount}, skipped ${skippedCount}`
          : `Added ${savedCount} file${savedCount === 1 ? "" : "s"}`;
        setUploadState({ phase: "done", message: msg });
      }
    } catch (err: any) {
      setUploadState({ phase: "error", message: err?.message || "Upload failed" });
    } finally {
      setTimeout(() => setUploadState({ phase: "idle" }), 2500);
    }
  }, [session?.sessionId]);

  return (
    <>
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative"
      >
        {selectionModeActive && (
          <div
            className={`pointer-events-none absolute -left-1.5 -top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border ${
              selected
                ? "border-blue-300 bg-blue-500 text-white"
                : "border-zinc-600 bg-zinc-800/90 text-transparent"
            }`}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </div>
        )}

        <AgentNodeCard
          selected={selected}
          selectionModeActive={selectionModeActive}
          displayColor={displayColor}
          displayName={displayName}
          agentId={nodeData.agentId}
          status={status}
          statusChangedAt={session?.statusChangedAt}
          currentTool={currentTool}
          cwd={session?.cwd}
          originalCwd={session?.originalCwd}
          gitBranch={session?.gitBranch}
          ticketId={session?.ticketId}
          ticketTitle={session?.ticketTitle}
          worktreePaths={session?.worktreePaths}
          launchCheckpoint={session?.launchCheckpoint}
          changeSummary={session?.changeSummary}
          isRestoringCheckpoint={isRestoringCheckpoint}
          onRestoreLaunchCheckpoint={handleRestoreLaunchCheckpoint}
          onReviewChanges={handleReviewChanges}
          devboxId={session?.devboxId}
          devboxName={session?.devboxName}
          remotePath={session?.remotePath}
          move={session?.move}
          moveNodeName={moveNodeName}
          moveActionBusy={moveActionBusy}
          onRetryMove={handleRetryMove}
          onCancelMove={handleCancelMove}
        />

        {isDraggingFile && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-blue-500/15 border-2 border-dashed border-blue-400/70 backdrop-blur-[1px] pointer-events-none">
            <div className="text-center px-2">
              <FilePlus className="w-6 h-6 text-blue-300 mx-auto mb-1" />
              <p className="text-[11px] text-blue-200 font-medium">Drop files to attach</p>
            </div>
          </div>
        )}

        {uploadState.phase !== "idle" && (
          <div
            className={`absolute bottom-1 left-1 right-1 z-20 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium pointer-events-none ${
              uploadState.phase === "uploading"
                ? "bg-blue-500/20 text-blue-200"
                : uploadState.phase === "done"
                  ? "bg-green-500/20 text-green-200"
                  : "bg-red-500/20 text-red-200"
            }`}
          >
            {uploadState.phase === "uploading" ? (
              <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
            ) : (
              <FilePlus className="w-3 h-3 flex-shrink-0" />
            )}
            <span className="truncate">{uploadState.message}</span>
          </div>
        )}
      </motion.div>

      {contextMenu && (
        <AgentNodeContextMenu
          position={contextMenu}
          onClose={closeContextMenu}
          onDelete={handleDelete}
          onMove={session ? handleMove : undefined}
          isRemote={!!session?.devboxId}
          moveDisabled={moveActive}
        />
      )}
    </>
  );
};
