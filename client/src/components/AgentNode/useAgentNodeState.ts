import { useState, useEffect } from "react";
import { useStore, AgentSession } from "../../stores/useStore";
import { destroyCachedTerminal } from "../Terminal";

interface AgentNodeData {
  sessionId: string;
}

export function useAgentNodeState(
  id: string,
  nodeData: AgentNodeData,
  session: AgentSession | undefined
) {
  const {
    removeNode,
    removeSession,
    setSelectedNodeId,
    setSidebarOpen,
    setDeleteToast,
    openMoveSheet,
  } = useStore();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [moveActionBusy, setMoveActionBusy] = useState(false);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".context-menu-container")) {
        return;
      }
      setContextMenu(null);
    };
    if (contextMenu) {
      setTimeout(() => {
        window.addEventListener("click", handleClick);
      }, 0);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleDelete = async () => {
    const sessionId = session?.sessionId || nodeData.sessionId;
    const sessionName = session?.customName || session?.agentName || "Session";

    // Confirmation dialog
    const confirmed = window.confirm(`Delete "${sessionName}"? You'll have 5 seconds to undo.`);
    if (!confirmed) return;

    // Soft-delete on the server
    if (sessionId) {
      await fetch(`/api/sessions/${sessionId}/soft-delete`, { method: "POST" });
    }

    // Clean up cached terminal instance
    if (sessionId) {
      destroyCachedTerminal(sessionId);
    }

    // Remove from UI immediately
    removeSession(id);
    removeNode(id);
    setSelectedNodeId(null);
    setSidebarOpen(false);

    // Show undo toast
    const timeout = setTimeout(() => {
      setDeleteToast(null);
    }, 5000);

    setDeleteToast({
      sessionId: sessionId || "",
      nodeId: id,
      sessionName,
      timeout,
    });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  // Local sessions move out; sessions on a node come home. The sheet plans
  // against the server and refuses anything the state does not allow.
  const handleMove = () => {
    openMoveSheet(id, session?.devboxId ? "home" : "out");
  };

  const postMoveAction = async (action: "retry" | "cancel") => {
    const sessionId = session?.sessionId || nodeData.sessionId;
    if (!sessionId || moveActionBusy) return;
    setMoveActionBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/move/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not ${action} the move`);
    } catch (error: any) {
      window.alert(error?.message || `Could not ${action} the move`);
    } finally {
      setMoveActionBusy(false);
    }
  };

  const handleRetryMove = () => void postMoveAction("retry");
  const handleCancelMove = () => void postMoveAction("cancel");

  return {
    contextMenu,
    handleContextMenu,
    handleDelete,
    closeContextMenu,
    handleMove,
    handleRetryMove,
    handleCancelMove,
    moveActionBusy,
  };
}
