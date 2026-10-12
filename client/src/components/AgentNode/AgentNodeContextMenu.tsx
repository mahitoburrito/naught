import { createPortal } from "react-dom";
import { ArrowUpRight, Home, Trash2 } from "lucide-react";

interface AgentNodeContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
  /** Open the move sheet. Label follows where the session runs. */
  onMove?: () => void;
  /** The session runs on a node, so the entry reads "Bring back". */
  isRemote?: boolean;
  /** A move is in flight; the entry stays visible but inert. */
  moveDisabled?: boolean;
}

export function AgentNodeContextMenu({
  position,
  onClose,
  onDelete,
  onMove,
  isRemote = false,
  moveDisabled = false,
}: AgentNodeContextMenuProps) {
  const MoveIcon = isRemote ? Home : ArrowUpRight;
  return createPortal(
    <div
      role="menu"
      className="context-menu-container fixed z-[9999] min-w-[160px] rounded-lg border shadow-xl py-1"
      style={{
        left: position.x,
        top: position.y,
        backgroundColor: "#262626",
        borderColor: "#333",
      }}
    >
      {onMove && (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={moveDisabled}
            onClick={() => {
              onMove();
              onClose();
            }}
            title={moveDisabled ? "A move is already in progress" : undefined}
            className="w-full px-3 py-2 text-left text-xs text-zinc-200 hover:bg-white/5 flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <MoveIcon className="w-3.5 h-3.5" />
            {isRemote ? "Bring back" : "Move to node…"}
          </button>
          <div className="my-1 border-t" style={{ borderColor: "#333" }} aria-hidden />
        </>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-white/5 flex items-center gap-2"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete
      </button>
    </div>,
    document.body
  );
}
