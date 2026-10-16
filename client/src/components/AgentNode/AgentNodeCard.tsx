import { useEffect, useState } from "react";
import { GitBranch, Folder, Wrench, Layers, Loader2, RotateCcw, FileDiff, Server, AlertTriangle } from "lucide-react";
import { AgentStatus, type AgentChangeSummary, type CheckpointSummary } from "../../stores/useStore";
import { agentStatusStyle } from "../../theme/agentStatus";
import { MOVE_STEP_LABELS, type MoveState } from "../../types/compute";
import { AgentIcon } from "../AgentIcon";

// How long a card has to sit waiting before it starts pulsing. Short enough
// that you notice an agent you walked away from, long enough that a prompt you
// answer straight away never pulses at all.
const SUSTAINED_ATTENTION_MS = 20_000;

/**
 * True once the card has been asking for input long enough to be worth
 * catching your eye. Arms a single timer for the remaining wait rather than
 * ticking, so a canvas of idle agents costs nothing.
 */
function useSustainedAttention(active: boolean, since: number | undefined): boolean {
  const [sustained, setSustained] = useState(false);

  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const waitedFor = Date.now() - (since ?? Date.now());
    if (waitedFor >= SUSTAINED_ATTENTION_MS) {
      setSustained(true);
      return;
    }
    setSustained(false);
    const timer = setTimeout(() => setSustained(true), SUSTAINED_ATTENTION_MS - waitedFor);
    return () => clearTimeout(timer);
  }, [active, since]);

  return sustained;
}

// Tool name display mapping
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
  TodoWrite: "Planning",
  AskUserQuestion: "Asking",
};

interface AgentNodeCardProps {
  selected: boolean;
  selectionModeActive?: boolean;
  displayColor: string;
  displayName: string;
  agentId: string;
  status: AgentStatus;
  statusChangedAt?: number;
  currentTool?: string;
  cwd?: string;
  originalCwd?: string; // Mother repo path when using worktrees
  gitBranch?: string;
  ticketId?: string;
  ticketTitle?: string;
  worktreePaths?: Record<string, string>;
  launchCheckpoint?: CheckpointSummary;
  changeSummary?: AgentChangeSummary;
  isRestoringCheckpoint?: boolean;
  onRestoreLaunchCheckpoint?: () => void;
  onReviewChanges?: () => void;
  // Remote placement and in-flight move (one extra row at most)
  devboxId?: string;
  devboxName?: string;
  remotePath?: string;
  move?: MoveState;
  /** Destination name while moving out, before the session carries devboxName. */
  moveNodeName?: string;
  moveActionBusy?: boolean;
  onRetryMove?: () => void;
  onCancelMove?: () => void;
}

export function AgentNodeCard({
  selected,
  selectionModeActive = false,
  displayColor,
  displayName,
  agentId,
  status,
  statusChangedAt,
  currentTool,
  cwd,
  originalCwd,
  gitBranch,
  ticketId,
  ticketTitle,
  worktreePaths,
  launchCheckpoint,
  changeSummary,
  isRestoringCheckpoint = false,
  onRestoreLaunchCheckpoint,
  onReviewChanges,
  devboxId,
  devboxName,
  remotePath,
  move,
  moveNodeName,
  moveActionBusy = false,
  onRetryMove,
  onCancelMove,
}: AgentNodeCardProps) {
  const statusInfo = agentStatusStyle(status);
  const errorStyle = agentStatusStyle("error");
  const moveFailed = move?.state === "error";
  const moveActive = !!move && !moveFailed && move.state !== "done";
  const moveLabel = move
    ? move.direction === "home"
      ? `Bringing back · ${MOVE_STEP_LABELS[move.state]}`
      : `Moving to ${moveNodeName || devboxName || "node"} · ${MOVE_STEP_LABELS[move.state]}`
    : null;
  const isActive = statusInfo.isActive;
  const isToolCalling = status === "tool_calling";
  const needsAttention = statusInfo.needsAttention;
  const awaitingUser = status === "waiting_input";
  const pulsing = useSustainedAttention(awaitingUser, statusChangedAt);

  // Extract directory name - use originalCwd (mother repo) if available, otherwise cwd
  const displayCwd = originalCwd || cwd;
  const dirName = displayCwd ? displayCwd.split("/").pop() || displayCwd : null;

  // Get display name for current tool
  const toolDisplay = currentTool ? (toolDisplayNames[currentTool] || currentTool) : null;
  const changedFileCount = changeSummary?.changedFileCount ?? 0;

  const inSelectionSet = selectionModeActive && selected;

  return (
    <div
      className={`relative w-[220px] rounded-lg border transition-colors duration-150 cursor-pointer ${
        inSelectionSet ? "ring-2 ring-blue-400/50" : selected ? "ring-1 ring-zinc-200/25" : ""
      }`}
      style={{
        backgroundColor: "#171818",
        borderColor: inSelectionSet
          ? "#60A5FA"
          : needsAttention
            ? statusInfo.borderStrong
            : selected
              ? "#52525b"
              : isActive
                ? statusInfo.border
                : "#2a2d2c",
        boxShadow: selected ? "0 8px 22px rgba(0, 0, 0, 0.35)" : "0 2px 8px rgba(0, 0, 0, 0.26)",
      }}
    >
      {pulsing && (
        <span
          aria-hidden
          className="agent-attention-pulse pointer-events-none absolute -inset-px rounded-lg"
          style={{ boxShadow: `0 0 0 2px ${statusInfo.color}, 0 0 16px 1px ${statusInfo.color}` }}
        />
      )}
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div
            className="relative w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${displayColor}18` }}
          >
            <AgentIcon agentId={agentId} className="h-[18px] w-[18px]" style={{ color: displayColor }} />
            <span
              className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border border-canvas-dark"
              style={{ backgroundColor: displayColor }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-sm font-medium leading-tight text-zinc-100">
                {displayName}
              </h3>
              <span className="flex flex-shrink-0 items-center gap-1 text-[10px]" style={{ color: statusInfo.color }}>
                <span
                  className={`w-1.5 h-1.5 rounded-full${pulsing ? " agent-attention-dot" : ""}`}
                  style={{ backgroundColor: statusInfo.color }}
                />
                {statusInfo.label}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-500">
              {status === "creating" && <Loader2 className="w-3 h-3 animate-spin" style={{ color: statusInfo.color }} />}
              {isToolCalling && toolDisplay ? (
                <>
                  <Wrench className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{toolDisplay}</span>
                </>
              ) : (
                <span className="truncate">{agentId}</span>
              )}
            </div>
          </div>
        </div>

        {/* Ticket info */}
        {ticketId && (
          <div className="mt-2.5 rounded-md border border-zinc-700/70 bg-zinc-900/45 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono font-semibold text-zinc-300">{ticketId}</span>
            </div>
            {ticketTitle && (
              <p className="text-[10px] text-zinc-500 truncate mt-0.5">{ticketTitle}</p>
            )}
          </div>
        )}

        {/* Repo & Branch */}
        {(dirName || gitBranch || (worktreePaths && Object.keys(worktreePaths).length > 1)) && (
          <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] text-zinc-500">
            {dirName && (
              <div className="flex min-w-0 items-center gap-1">
                <Folder className="w-3 h-3 flex-shrink-0" />
                <span className="font-mono truncate">{dirName}</span>
              </div>
            )}
            {gitBranch && (
              <div className="flex min-w-0 items-center gap-1">
                <GitBranch className="w-3 h-3 flex-shrink-0" />
                <span className="font-mono truncate">{gitBranch}</span>
              </div>
            )}
            {worktreePaths && Object.keys(worktreePaths).length > 1 && (
              <div className="flex flex-shrink-0 items-center gap-1" title={Object.entries(worktreePaths).map(([n, p]) => `${n}: ${p}`).join('\n')}>
                <Layers className="w-3 h-3 flex-shrink-0" />
                <span>{Object.keys(worktreePaths).length} repos</span>
              </div>
            )}
          </div>
        )}

        {/* Remote placement / move progress: one row, most urgent state wins */}
        {moveFailed && move ? (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px]" style={{ color: errorStyle.color }}>
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={move.error || "Move failed"}>
              {move.error || "Move failed"}
            </span>
            {onRetryMove && (
              <button
                type="button"
                disabled={moveActionBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  onRetryMove();
                }}
                className="flex-shrink-0 rounded border border-zinc-700/80 bg-zinc-900/45 px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                title="Retry the move from the failed step"
              >
                Retry
              </button>
            )}
            {onCancelMove && (
              <button
                type="button"
                disabled={moveActionBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelMove();
                }}
                className="flex-shrink-0 rounded border border-zinc-700/80 bg-zinc-900/45 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                title="Cancel the failed move; local files are untouched"
              >
                Cancel
              </button>
            )}
          </div>
        ) : moveActive && moveLabel ? (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400" aria-live="polite">
            <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin text-zinc-500" />
            <span className="truncate" title={moveLabel}>{moveLabel}</span>
          </div>
        ) : devboxId ? (
          <div
            className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400"
            title={remotePath ? `${devboxName || "node"}:${remotePath}` : devboxName || "node"}
          >
            <Server className="w-3 h-3 flex-shrink-0 text-zinc-500" />
            <span className="flex-shrink-0 truncate">{devboxName || "node"}</span>
            {remotePath && <span className="min-w-0 truncate font-mono text-zinc-500">{remotePath}</span>}
          </div>
        ) : null}

        {(changedFileCount > 0 || launchCheckpoint) && (
          <div className="mt-2 flex items-center gap-1.5">
            {changedFileCount > 0 && changeSummary && onReviewChanges && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onReviewChanges();
                }}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-zinc-700/80 bg-zinc-900/45 px-2 py-1.5 text-left text-[10px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
                title={changeSummary.files.map((file) => file.path).join("\n")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileDiff className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{changedFileCount} changed</span>
                </span>
                <span className="flex flex-shrink-0 items-center gap-1 font-mono text-zinc-500">
                  +{changeSummary.added}/-{changeSummary.removed}
                </span>
              </button>
            )}

            {launchCheckpoint && onRestoreLaunchCheckpoint && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRestoreLaunchCheckpoint();
                }}
                disabled={isRestoringCheckpoint}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900/45 text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                title="Restore the repo to the checkpoint saved before this session started"
              >
                {isRestoringCheckpoint ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
