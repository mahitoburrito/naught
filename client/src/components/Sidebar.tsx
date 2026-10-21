import { useState, useEffect, useRef, useCallback } from "react";
import { resumeSession } from "../utils/resumeSession";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Terminal as TerminalIcon,
  Clock,
  Folder,
  Edit3,
  RotateCcw,
  Play,
  Sparkles,
  Code,
  Cpu,
  Zap,
  Rocket,
  Bot,
  Brain,
  Wand2,
  GitBranch,
  Paperclip,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { useStore } from "../stores/useStore";
import { getTerminalTheme } from "../theme/appearance";
import { AGENT_STATUS, agentStatusStyle } from "../theme/agentStatus";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { Terminal } from "./Terminal";
import { InPaneMarkdown } from "./InPaneMarkdown";

const presetColors = [
  "#D97652", "#22C55E", "#3B82F6", "#8B5CF6", "#EC4899", "#EF4444", "#FBBF24", "#14B8A6"
];

const iconOptions = [
  { id: "sparkles", icon: Sparkles, label: "Sparkles" },
  { id: "code", icon: Code, label: "Code" },
  { id: "cpu", icon: Cpu, label: "CPU" },
  { id: "zap", icon: Zap, label: "Zap" },
  { id: "rocket", icon: Rocket, label: "Rocket" },
  { id: "bot", icon: Bot, label: "Bot" },
  { id: "brain", icon: Brain, label: "Brain" },
  { id: "wand2", icon: Wand2, label: "Wand" },
];

export function Sidebar() {
  const {
    sidebarOpen,
    setSidebarOpen,
    viewMode,
    selectedNodeId,
    sessions,
    setSelectedNodeId,
    updateSession,
    updateNode,
    nodes,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
    terminalTheme,
    browserPanelOpen,
    browserPanelWidth,
  } = useStore();

  const session = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const node = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  useEffect(() => {
    if (viewMode === "focus" && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, setSidebarOpen, viewMode]);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [terminalKey, setTerminalKey] = useState(0);
  const [openedFile, setOpenedFile] = useState<string | null>(null);

  // File attachment state
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<{
    paths: string[];
    skippedCount: number;
    error?: string;
  } | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const sendInputRef = useRef<((text: string) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(text);
      setTimeout(() => setCopiedPath((p) => (p === text ? null : p)), 1500);
    } catch {
      // ignore
    }
  }, []);

  // Resize state
  const [sidebarWidth, setSidebarWidth] = useState(512);
  const isResizing = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      setSidebarWidth(Math.max(384, Math.min(newWidth, window.innerWidth * 0.8)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // Reset edit state when session changes (but NOT when nodes change)
  useEffect(() => {
    if (session) {
      setEditName(session.customName || session.agentName);
      setEditNotes(session.notes || "");
      setEditColor(session.customColor || session.color);
      const currentNode = nodes.find(n => n.id === selectedNodeId);
      const nodeIcon = currentNode?.data?.icon;
      setEditIcon(typeof nodeIcon === 'string' ? nodeIcon : "cpu");
    }
    setIsEditing(false);
    setLastUpload(null);
    setOpenedFile(null);
    sendInputRef.current = null;
    // Force terminal recreation when session changes
    setTerminalKey(k => k + 1);
  }, [session?.sessionId]); // Removed nodes and selectedNodeId to prevent closing on updates

  const handleClose = () => {
    setSidebarOpen(false);
    setSelectedNodeId(null);
    setIsEditing(false);
  };

  const [resumeError, setResumeError] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const handleResume = async () => {
    if (!session || !selectedNodeId) return;
    setIsResuming(true);
    setResumeError(null);
    const result = await resumeSession(session.sessionId, selectedNodeId);
    setIsResuming(false);
    if (!result.ok) setResumeError(result.error || "Could not resume this session");
  };

  const handleNewSession = () => {
    if (selectedNodeId) {
      setNewSessionForNodeId(selectedNodeId);
      setNewSessionModalOpen(true);
    }
  };

  const handleTerminalReady = useCallback((sendInput: (text: string) => void) => {
    sendInputRef.current = sendInput;
  }, []);

  const handleFileUpload = useCallback(async (files: File[]) => {
    if (!session || files.length === 0) return;

    setIsUploading(true);
    setLastUpload(null);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }

      const res = await fetch(`/api/sessions/${session.sessionId}/upload`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const body = await res.json();
        const saved: string[] = Array.isArray(body.saved) ? body.saved : [];
        const skippedCount = Array.isArray(body.skipped) ? body.skipped.length : 0;
        if (saved.length > 0 || skippedCount > 0) {
          setLastUpload({ paths: saved, skippedCount });
          // If a single file was saved, auto-copy its path so the user can
          // paste it elsewhere immediately.
          if (saved.length === 1) {
            void copyToClipboard(saved[0]);
          }
        }
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setLastUpload({ paths: [], skippedCount: 0, error: err.error || "Upload failed" });
      }
    } catch (e) {
      console.error("File upload failed:", e);
      setLastUpload({ paths: [], skippedCount: 0, error: "Upload failed" });
    } finally {
      setIsUploading(false);
    }
  }, [session, copyToClipboard]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileUpload(files);
    }
  }, [handleFileUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingFile(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only hide if we're leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingFile(false);
    }
  }, []);

  const displayColor = getAgentAccentColor(
    session?.agentId,
    editColor || session?.customColor || session?.color || undefined,
  );
  const statusInfo = agentStatusStyle(session?.status);
  const isDisconnected = session?.status === "disconnected";
  const terminalPalette = getTerminalTheme(terminalTheme);
  const headerIconId = (node?.data?.icon as string) || session?.agentId;
  const browserDockOpen = viewMode === "focus" && browserPanelOpen;

  return (
    <AnimatePresence>
      {sidebarOpen && session && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 40 }}
          className="fixed right-0 top-14 bottom-0 z-50 flex flex-col bg-canvas-dark border-l border-border"
          style={{
            width: sidebarWidth,
            right: browserDockOpen ? browserPanelWidth : 0,
          }}
        >
          {/* Resize handle */}
          <div
            onMouseDown={handleMouseDown}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/40 transition-colors z-10"
          />
          {/* Header */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-border">
            <div className="flex items-center gap-3">
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border"
                style={{
                  backgroundColor: `${displayColor}16`,
                  borderColor: `${displayColor}40`,
                }}
              >
                <AgentIcon
                  agentId={session.agentId}
                  iconId={headerIconId}
                  className="h-5 w-5"
                  style={{ color: displayColor }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-medium text-white truncate">
                  {session.customName || session.agentName}
                </h2>
                <div className="flex items-center gap-2 mt-0.5">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: statusInfo.color,
                      boxShadow: `0 0 0 3px ${statusInfo.bg}`,
                    }}
                  />
                  <span className="text-[10px]" style={{ color: statusInfo.color }}>
                    {statusInfo.label}
                  </span>
                </div>
              </div>
              
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
                    isEditing 
                      ? "text-white bg-surface-active" 
                      : "text-zinc-500 hover:text-white hover:bg-surface-active"
                  }`}
                >
                  <Edit3 className="w-4 h-4" />
                </button>
                <button
                  onClick={handleClose}
                  className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Disconnected banner */}
          {isDisconnected && (
            <div
              className="flex-shrink-0 px-4 py-3 border-b"
              style={{
                backgroundColor: AGENT_STATUS.disconnected.bg,
                borderBottomColor: AGENT_STATUS.disconnected.border,
              }}
            >
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium" style={{ color: AGENT_STATUS.disconnected.color }}>
                    Session {AGENT_STATUS.disconnected.label}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {session.resumable
                      ? "The agent was stopped. Resume picks the conversation back up where it left off."
                      : "The agent was stopped. Relaunch it here, or start a new session."}
                  </p>
                  {resumeError && <p className="text-xs text-red-400 mt-1">{resumeError}</p>}
                </div>
                <button
                  onClick={handleResume}
                  disabled={isResuming}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md border text-sm font-medium text-zinc-100 transition-colors hover:brightness-125 disabled:opacity-60"
                  style={{
                    backgroundColor: AGENT_STATUS.disconnected.bg,
                    borderColor: AGENT_STATUS.disconnected.border,
                  }}
                >
                  {isResuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {session.resumable ? "Resume conversation" : "Relaunch"}
                </button>
                <button
                  onClick={handleNewSession}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md border text-sm font-medium text-zinc-100 transition-colors hover:brightness-125"
                  style={{
                    backgroundColor: AGENT_STATUS.disconnected.bg,
                    borderColor: AGENT_STATUS.disconnected.border,
                  }}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  New Session
                </button>
              </div>
            </div>
          )}

          {/* Session Management Controls */}
          {!isDisconnected && !isEditing && (
            <div className="flex-shrink-0 px-4 py-2 border-b border-border">
              <button
                onClick={handleNewSession}
                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md bg-surface-active text-zinc-300 text-xs font-medium hover:bg-zinc-700 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                New Session
              </button>
            </div>
          )}

          {/* Edit Panel */}
          <AnimatePresence>
            {isEditing && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="flex-shrink-0 overflow-hidden border-b border-border"
              >
                <div className="p-4 space-y-4">
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setEditName(newName);
                        // Instant update
                        if (selectedNodeId && session) {
                          const customName = newName !== session.agentName ? newName : undefined;
                          updateSession(selectedNodeId, { customName });
                          if (node) {
                            updateNode(selectedNodeId, {
                              data: { ...node.data, label: newName },
                            });
                          }
                          // Persist to API
                          fetch(`/api/sessions/${session.sessionId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ customName }),
                          }).catch(console.error);
                        }
                      }}
                      className="mt-1 w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                  </div>
                  
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Color</label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {presetColors.map((color) => (
                        <button
                          key={color}
                          onClick={() => {
                            setEditColor(color);
                            // Instant update
                            if (selectedNodeId && session) {
                              updateSession(selectedNodeId, { customColor: color });
                              if (node) {
                                updateNode(selectedNodeId, {
                                  data: { ...node.data, color },
                                });
                              }
                              // Persist to API
                              fetch(`/api/sessions/${session.sessionId}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ customColor: color }),
                              }).catch(console.error);
                            }
                          }}
                          className={`w-7 h-7 rounded-md transition-all ${
                            editColor === color
                              ? "ring-2 ring-white ring-offset-2 ring-offset-canvas-dark scale-110"
                              : "hover:scale-110"
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Icon</label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {iconOptions.map(({ id, icon: IconComponent }) => (
                        <button
                          key={id}
                          onClick={() => {
                            setEditIcon(id);
                            // Instant update
                            if (selectedNodeId && node) {
                              updateNode(selectedNodeId, {
                                data: { ...node.data, icon: id },
                              });
                            }
                          }}
                          className={`w-9 h-9 rounded-md transition-all flex items-center justify-center ${
                            editIcon === id
                              ? "ring-2 ring-white ring-offset-2 ring-offset-canvas-dark scale-110 bg-white/10"
                              : "hover:scale-110 hover:bg-white/5 bg-canvas"
                          }`}
                          style={{ borderColor: editIcon === id ? editColor : "#333", borderWidth: '1px' }}
                        >
                          <IconComponent
                            className="w-4 h-4"
                            style={{ color: editIcon === id ? editColor : "#888" }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div>
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Notes</label>
                    <textarea
                      value={editNotes}
                      onChange={(e) => {
                        const newNotes = e.target.value;
                        setEditNotes(newNotes);
                        // Update with debounce would be better, but instant for now
                      }}
                      onBlur={() => {
                        // Save notes on blur
                        if (selectedNodeId && session) {
                          fetch(`/api/sessions/${session.sessionId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ notes: editNotes || undefined }),
                          }).catch(console.error);
                          updateSession(selectedNodeId, { notes: editNotes || undefined });
                        }
                      }}
                      placeholder="Add notes..."
                      rows={2}
                      className="mt-1 w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-none"
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Terminal */}
          <div
            className="flex-1 flex flex-col min-h-0 relative"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div
              className="flex-shrink-0 border-b px-4 py-2 flex items-center justify-between"
              style={{
                backgroundColor: terminalPalette.surface,
                borderColor: terminalPalette.border,
              }}
            >
              <div className="flex items-center gap-2">
                <TerminalIcon className="w-3.5 h-3.5" style={{ color: displayColor }} />
                <span className="text-xs" style={{ color: terminalPalette.foreground }}>
                  Terminal
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* File attach button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-surface-active"
                  style={{ color: terminalPalette.muted }}
                  title="Attach files"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length > 0) handleFileUpload(files);
                    e.target.value = "";
                  }}
                />
                <div className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F56]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[#27CA40]" />
                </div>
              </div>
            </div>

            {/* File upload status bar */}
            {(isUploading || lastUpload) && (
              <div
                className="flex-shrink-0 border-b"
                style={{
                  backgroundColor: terminalPalette.surface,
                  borderColor: terminalPalette.border,
                }}
              >
                {isUploading ? (
                  <div className="px-3 py-1.5 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                    <span className="text-[10px] text-blue-400">Uploading files...</span>
                  </div>
                ) : lastUpload?.error ? (
                  <div className="px-3 py-1.5 flex items-center gap-2">
                    <Paperclip className="w-3 h-3 text-red-400 flex-shrink-0" />
                    <span className="text-[10px] text-red-400 truncate flex-1">
                      {lastUpload.error}
                    </span>
                    <button
                      onClick={() => setLastUpload(null)}
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : lastUpload && lastUpload.paths.length > 0 ? (
                  <div className="py-1.5">
                    {/* Header row */}
                    <div className="px-3 pb-1 flex items-center gap-2">
                      <Paperclip className="w-3 h-3 text-green-400 flex-shrink-0" />
                      <span className="text-[10px] text-green-400 flex-1">
                        Saved {lastUpload.paths.length} file
                        {lastUpload.paths.length === 1 ? "" : "s"}
                        {lastUpload.skippedCount > 0
                          ? ` · ${lastUpload.skippedCount} skipped`
                          : ""}
                        {lastUpload.paths.length === 1 ? " · path copied" : ""}
                      </span>
                      {lastUpload.paths.length > 1 && (
                        <button
                          onClick={() =>
                            copyToClipboard(lastUpload.paths.join(" "))
                          }
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
                          title="Copy all paths"
                        >
                          {copiedPath === lastUpload.paths.join(" ") ? (
                            <>
                              <Check className="w-2.5 h-2.5 text-green-400" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-2.5 h-2.5" />
                              Copy all
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => setLastUpload(null)}
                        className="text-zinc-500 hover:text-zinc-300"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    {/* Path list */}
                    <div className="max-h-32 overflow-y-auto">
                      {lastUpload.paths.map((p) => {
                        const isCopied = copiedPath === p;
                        return (
                          <div
                            key={p}
                            className="px-3 py-0.5 flex items-center gap-2 group hover:bg-surface-active/40"
                          >
                            <span
                              className="text-[10px] font-mono text-zinc-300 truncate flex-1"
                              title={p}
                            >
                              {p}
                            </span>
                            <button
                              onClick={() => copyToClipboard(p)}
                              className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Copy path"
                            >
                              {isCopied ? (
                                <Check className="w-3 h-3 text-green-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : lastUpload && lastUpload.skippedCount > 0 ? (
                  <div className="px-3 py-1.5 flex items-center gap-2">
                    <Paperclip className="w-3 h-3 text-yellow-400 flex-shrink-0" />
                    <span className="text-[10px] text-yellow-400 truncate flex-1">
                      Skipped {lastUpload.skippedCount} file
                      {lastUpload.skippedCount === 1 ? "" : "s"}
                    </span>
                    <button
                      onClick={() => setLastUpload(null)}
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            <div
              className="flex-1 min-h-0 relative overflow-hidden"
              style={{
                backgroundColor: terminalPalette.background,
                boxShadow: `inset 0 0 0 1px ${terminalPalette.border}`,
              }}
            >
              {session.status === "creating" ? (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                  <span className="text-sm text-zinc-500">Setting up session...</span>
                </div>
              ) : (
                <Terminal
                  key={`${session.sessionId}-${terminalKey}`}
                  sessionId={session.sessionId}
                  color={displayColor}
                  nodeId={selectedNodeId!}
                  cwd={session.cwd}
                  initialCols={session.terminalCols}
                  initialRows={session.terminalRows}
                  onOpenFile={(p) => setOpenedFile(p)}
                  onReady={handleTerminalReady}
                />
              )}
              <AnimatePresence>
                {openedFile && (
                  <InPaneMarkdown
                    key={openedFile}
                    path={openedFile}
                    onClose={() => setOpenedFile(null)}
                  />
                )}
              </AnimatePresence>
            </div>

            {/* Drag overlay */}
            {isDraggingFile && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/50 rounded-lg backdrop-blur-sm">
                <div className="text-center">
                  <Paperclip className="w-8 h-8 text-blue-400 mx-auto mb-2" />
                  <p className="text-sm text-blue-300 font-medium">Drop files here</p>
                  <p className="text-[10px] text-blue-400/70 mt-1">Any type · 50MB each · up to 20</p>
                </div>
              </div>
            )}
          </div>

          {/* Details */}
          <div
            className="flex-shrink-0 border-t"
            style={{
              backgroundColor: terminalPalette.surface,
              borderColor: terminalPalette.border,
            }}
          >
            <div className="p-4 space-y-2">
              {session.notes && !isEditing && (
                <p className="text-xs text-zinc-400 italic mb-3 pb-3 border-b border-border">
                  {session.notes}
                </p>
              )}
              <div className="flex items-center gap-2 text-xs">
                <Clock className="w-3 h-3 flex-shrink-0" style={{ color: terminalPalette.ansi.blue }} />
                <span className="text-zinc-500">Started</span>
                <span className="text-zinc-400 font-mono ml-auto">
                  {new Date(session.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Folder className="w-3 h-3 flex-shrink-0" style={{ color: terminalPalette.ansi.yellow }} />
                <span className="text-zinc-500">Directory</span>
                <span className="text-zinc-400 font-mono ml-auto truncate max-w-[180px]" title={session.cwd}>
                  {session.cwd.split('/').slice(-2).join('/')}
                </span>
              </div>
              {session.gitBranch && (
                <div className="flex items-center gap-2 text-xs">
                  <GitBranch className="w-3 h-3 flex-shrink-0" style={{ color: displayColor }} />
                  <span className="text-zinc-500">Branch</span>
                  <span className="font-mono ml-auto" style={{ color: displayColor }}>
                    {session.gitBranch}
                  </span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
