import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  FolderOpen,
  Terminal,
  Plus,
  Minus,
  Search,
  Loader2,
  GitBranch,
  AlertCircle,
  Ticket,
  Home,
  ArrowUp,
  Github,
  RefreshCw,
  Server,
} from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import { useStore, Agent, AgentSession } from "../stores/useStore";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { canUseNativeDirectoryPicker, pickDirectoryNative } from "../utils/nativeDirectoryPicker";
import { NewNodeForm, createNode } from "./compute/NewNodeForm";
import type { Devbox, NodeRequest, ProvisionedNode } from "../types/compute";

/** The Run-on value that means "provision a node first, then run there". */
const NEW_NODE = "__new__";

const NODE_POLL_MS = 3_000;

/** Where a provision-then-launch stands; the modal stays open through all of it. */
interface NodeFlow {
  phase: "requesting" | "pending" | "provisioning" | "bootstrapping" | "starting" | "cancelling" | "error";
  nodeId?: string;
  name?: string;
  reasons?: string[];
  message?: string;
}

function nodeFlowFor(node: ProvisionedNode, reasons?: string[]): NodeFlow {
  const status = node.provision.status;
  if (status === "pending") return { phase: "pending", nodeId: node.id, name: node.name, reasons: reasons ?? node.provision.reasons };
  // The provider reports ready (startedAt) before Naught finishes bootstrapping.
  return { phase: node.provision.startedAt ? "bootstrapping" : "provisioning", nodeId: node.id, name: node.name };
}

function nodeFlowLabel(flow: NodeFlow): string {
  switch (flow.phase) {
    case "requesting": return "Requesting a node…";
    case "pending": return "Waiting for approval in Naught…";
    case "provisioning": return `Provisioning ${flow.name ?? "the node"}…`;
    case "bootstrapping": return `Bootstrapping ${flow.name ?? "the node"}…`;
    case "starting": return "Starting the session…";
    case "cancelling": return "Cancelling…";
    case "error": return flow.message ?? "Provisioning failed.";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; color: string };
  priority: number;
  assignee?: { name: string };
  team?: { name: string; key: string };
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  url: string;
  state: string;
  labels: { name: string; color: string }[];
  assignee?: { login: string };
}

interface DetectedRepo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  defaultBranch: string;
}

interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  // If provided, we're replacing an existing session on this node
  existingSession?: AgentSession;
  existingNodeId?: string;
}

type TabType = "blank" | "linear" | "github";

// Node dimensions for collision detection
const NODE_WIDTH = 200;
const NODE_HEIGHT = 120;
const SPACING = 24; // Grid snap size

// Find a free position near the target that doesn't overlap existing nodes
function findFreePosition(
  targetX: number,
  targetY: number,
  existingNodes: { position?: { x: number; y: number } }[],
  count: number = 1
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  const GRID = SPACING;

  // Snap target to grid
  const startX = Math.round(targetX / GRID) * GRID;
  const startY = Math.round(targetY / GRID) * GRID;

  // Filter to only nodes with valid positions
  const validNodes = existingNodes.filter(
    (n): n is { position: { x: number; y: number } } =>
      n.position !== undefined &&
      typeof n.position.x === 'number' &&
      typeof n.position.y === 'number'
  );

  // Check if a position overlaps with any existing node or already-placed new node
  const isOverlapping = (x: number, y: number, placedPositions: { x: number; y: number }[]) => {
    const allPositions = [...validNodes.map(n => n.position), ...placedPositions];
    for (const pos of allPositions) {
      const overlapX = Math.abs(x - pos.x) < NODE_WIDTH + SPACING;
      const overlapY = Math.abs(y - pos.y) < NODE_HEIGHT + SPACING;
      if (overlapX && overlapY) return true;
    }
    return false;
  };

  // Spiral outward from target position to find free spots
  for (let i = 0; i < count; i++) {
    let found = false;
    let radius = 0;
    const maxRadius = 20; // Max search radius in grid units

    while (!found && radius <= maxRadius) {
      // Try positions in a spiral pattern
      for (let dx = -radius; dx <= radius && !found; dx++) {
        for (let dy = -radius; dy <= radius && !found; dy++) {
          // Only check positions on the current ring
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

          const x = startX + dx * (NODE_WIDTH + SPACING);
          const y = startY + dy * (NODE_HEIGHT + SPACING);

          if (!isOverlapping(x, y, positions)) {
            positions.push({ x, y });
            found = true;
          }
        }
      }
      radius++;
    }

    // Fallback if no free position found
    if (!found) {
      positions.push({
        x: startX + i * (NODE_WIDTH + SPACING),
        y: startY,
      });
    }
  }

  return positions;
}

export function NewSessionModal({
  open,
  onClose,
  existingSession,
  existingNodeId,
}: NewSessionModalProps) {
  const {
    agents,
    addNode,
    addSession,
    updateSession,
    nodes,
    launchCwd,
    lastPickedDirectory,
    setLastPickedDirectory,
    newSessionInitialPrompt,
    setNewSessionInitialPrompt,
  } = useStore();

  // Get ReactFlow instance to access viewport
  const reactFlowInstance = useReactFlow();

  const isReplacing = !!existingSession;

  // Form state
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [cwd, setCwd] = useState("");
  const [customName, setCustomName] = useState("");
  const [commandArgs, setCommandArgs] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [count, setCount] = useState(1);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>("blank");

  // Linear state
  const [linearConfigured, setLinearConfigured] = useState<boolean | null>(null);
  const [tickets, setTickets] = useState<LinearTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<LinearTicket | null>(null);
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [createWorktree, setCreateWorktree] = useState(false);

  // Multi-repo detection state
  const [detectedRepos, setDetectedRepos] = useState<DetectedRepo[]>([]);
  const [selectedRepoPaths, setSelectedRepoPaths] = useState<Set<string>>(new Set());
  const [multiRepoMode, setMultiRepoMode] = useState<'current' | 'main'>('main');
  const [scanningRepos, setScanningRepos] = useState(false);

  // Directory picker state
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [dirBrowsePath, setDirBrowsePath] = useState("");
  const [dirBrowseParent, setDirBrowseParent] = useState<string | null>(null);
  const [dirBrowseDirs, setDirBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [dirBrowseLoading, setDirBrowseLoading] = useState(false);
  const [dirBrowseError, setDirBrowseError] = useState<string | null>(null);

  // Devboxes: an empty devboxId means this session runs locally; NEW_NODE means
  // provision one first. Only ready provisioned nodes are offered as targets.
  const [devboxes, setDevboxes] = useState<Devbox[]>([]);
  const [devboxId, setDevboxId] = useState("");
  // The default devbox from Settings, applied once the devbox list has loaded
  // so a deleted or not-ready box never gets preselected.
  const [pendingDefaultDevboxId, setPendingDefaultDevboxId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [newNodeSpec, setNewNodeSpec] = useState<NodeRequest | null>(null);
  const [nodeFlow, setNodeFlow] = useState<NodeFlow | null>(null);
  // Set while a provision-then-launch is polling; calling it stops the loop.
  const stopNodeFlow = useRef<(() => void) | null>(null);
  const selectableDevboxes = devboxes.filter(
    (box) => box.source !== "provisioned" || box.provision?.status === "ready",
  );
  const nodeFlowBusy = !!nodeFlow && nodeFlow.phase !== "error";

  useEffect(() => {
    if (!pendingDefaultDevboxId || devboxes.length === 0) return;
    const box = selectableDevboxes.find((item) => item.id === pendingDefaultDevboxId);
    if (box) {
      setDevboxId(box.id);
      setRemotePath(box.defaultPath || "");
    }
    setPendingDefaultDevboxId("");
  }, [pendingDefaultDevboxId, devboxes]);

  // Session launch defaults, loaded from Settings -> Sessions
  const [defaultStartingDirectory, setDefaultStartingDirectory] = useState("");
  const [rememberLastDirectory, setRememberLastDirectory] = useState(true);

  // Where a session starts when the user has not typed a directory: the session
  // being replaced, then the last one picked (only while remembering is on, since
  // that is the more recent signal of intent), then the configured default, then
  // the directory the app was launched from.
  const effectiveDefaultDirectory =
    (isReplacing ? existingSession?.originalCwd || existingSession?.cwd : "") ||
    (rememberLastDirectory ? lastPickedDirectory : "") ||
    defaultStartingDirectory ||
    launchCwd;

  // GitHub state
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [githubIssues, setGithubIssues] = useState<GitHubIssue[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [selectedGithubIssue, setSelectedGithubIssue] = useState<GitHubIssue | null>(null);

  // Track if we've initialized for this modal open
  const [initialized, setInitialized] = useState(false);

  // Reset form when modal opens (only once per open)
  useEffect(() => {
    if (open && !initialized) {
      if (existingSession) {
        // Pre-fill from existing session — use originalCwd (mother repo) when available
        // to avoid pre-filling the worktree path as the working directory
        const agent = agents.find((a) => a.id === existingSession.agentId);
        setSelectedAgent(agent || null);
        setCwd(existingSession.originalCwd || existingSession.cwd);
        setCustomName(existingSession.customName || "");
        setCommandArgs(
          agent?.id === "claude"
            ? "--dangerously-skip-permissions"
            : agent?.id === "codex"
              ? "--yolo"
              : ""
        );
        setInitialPrompt(newSessionInitialPrompt);
        setCount(1);
      } else {
        setSelectedAgent(null);
        setDevboxId("");
        setPendingDefaultDevboxId("");
        setRemotePath("");
        setCwd("");
        setCustomName("");
        setCommandArgs("");
        setInitialPrompt(newSessionInitialPrompt);
        setCount(1);
      }
      setNewSessionInitialPrompt("");
      setNewNodeSpec(null);
      setNodeFlow(null);
      setActiveTab("blank");
      setSelectedTicket(null);
      setSearchQuery("");
      setTickets([]);
      setTicketsError(null);
      // Reset GitHub state
      setSelectedGithubIssue(null);
      setGithubIssues([]);
      setGithubError(null);
      setDetectedRepos([]);
      setSelectedRepoPaths(new Set());
      setMultiRepoMode('main');
      setInitialized(true);

      // Scan for repos in the effective working directory — prefer originalCwd to avoid scanning worktree dirs
      const effectiveCwd = existingSession?.originalCwd || existingSession?.cwd || launchCwd;
      if (effectiveCwd) {
        scanForRepos(effectiveCwd);
      }

      fetch("/api/devboxes")
        .then((res) => res.json())
        .then((data) => setDevboxes(data.devboxes || []))
        .catch(() => setDevboxes([]));

      // Check Linear config
      fetch("/api/linear/config")
        .then((res) => res.json())
        .then((config) => {
          setLinearConfigured(config.hasApiKey);
          setBaseBranch(config.defaultBaseBranch || "main");
          setCreateWorktree(config.createWorktree ?? false);

          const remember = config.rememberLastDirectory ?? true;
          setRememberLastDirectory(remember);
          setDefaultStartingDirectory(config.defaultStartingDirectory || "");

          // Launch defaults seed brand-new sessions only. Replacing a session
          // keeps that session's own agent, directory and prompt.
          if (existingSession) return;

          const startingDir =
            (remember ? lastPickedDirectory : "") || config.defaultStartingDirectory || "";
          if (startingDir) {
            setCwd(startingDir);
            scanForRepos(startingDir);
          }
          if (config.defaultAgentId) {
            const preselected = agents.find((a) => a.id === config.defaultAgentId);
            if (preselected) setSelectedAgent(preselected);
          }
          if (config.defaultDevboxId) setPendingDefaultDevboxId(config.defaultDevboxId);
          // An explicit prompt handed to the modal outranks the configured one.
          if (config.initialPrompt && !newSessionInitialPrompt) {
            setInitialPrompt(config.initialPrompt);
          }
        })
        .catch(() => setLinearConfigured(false));
    } else if (!open) {
      // Reset flags when modal closes
      setInitialized(false);
      setLinearConfigured(null);
    }
  }, [open, initialized, existingSession, agents, newSessionInitialPrompt, setNewSessionInitialPrompt]);

  // Load tickets when switching to linear tab
  useEffect(() => {
    if (activeTab === "linear" && linearConfigured === true && !ticketsLoading && tickets.length === 0 && !ticketsError) {
      loadMyTickets();
    }
  }, [activeTab, linearConfigured]);

  // Generate branch name from ticket (Linear or GitHub)
  useEffect(() => {
    if (selectedTicket) {
      const slug = selectedTicket.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      setBranchName(`${selectedTicket.identifier.toLowerCase()}/${slug}`);
    } else if (selectedGithubIssue) {
      const slug = selectedGithubIssue.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      setBranchName(`issue-${selectedGithubIssue.number}/${slug}`);
    }
  }, [selectedTicket, selectedGithubIssue]);

  // Directory browsing
  const browsePath = async (path?: string) => {
    setDirBrowseLoading(true);
    setDirBrowseError(null);
    try {
      const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : "/api/browse";
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setDirBrowseError(data.error);
      } else {
        setDirBrowsePath(data.current);
        setDirBrowseParent(data.parent);
        setDirBrowseDirs(data.directories);
      }
    } catch (e: any) {
      setDirBrowseError(e.message);
    } finally {
      setDirBrowseLoading(false);
    }
  };

  const openDirPicker = async () => {
    const startingPath = cwd || effectiveDefaultDirectory;
    // Under Electron, hand off to the macOS folder panel. The in-app browser
    // below stays for the browser-served client, where no native dialog exists.
    if (canUseNativeDirectoryPicker()) {
      const picked = await pickDirectoryNative(startingPath);
      if (picked) selectDirectory(picked);
      return;
    }
    setShowDirPicker(true);
    browsePath(startingPath);
  };

  const scanForRepos = async (path: string) => {
    setScanningRepos(true);
    try {
      const res = await fetch(`/api/scan-repos?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const { repos } = await res.json();
        setDetectedRepos(repos || []);
        // Auto-select all repos by default
        setSelectedRepoPaths(new Set((repos || []).map((r: DetectedRepo) => r.path)));
      } else {
        setDetectedRepos([]);
        setSelectedRepoPaths(new Set());
      }
    } catch {
      setDetectedRepos([]);
      setSelectedRepoPaths(new Set());
    } finally {
      setScanningRepos(false);
    }
  };

  const selectDirectory = (path: string) => {
    setCwd(path);
    setLastPickedDirectory(path);
    setShowDirPicker(false);
    // Scan for repos in the selected directory
    scanForRepos(path);
  };

  const loadMyTickets = async () => {
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      const res = await fetch("/api/linear/tickets");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to load tickets");
      }
      const data = await res.json();
      setTickets(data);
    } catch (e: any) {
      setTicketsError(e.message);
    } finally {
      setTicketsLoading(false);
    }
  };

  const searchTickets = async (query: string) => {
    if (!query.trim()) {
      loadMyTickets();
      return;
    }
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      const res = await fetch(`/api/linear/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Search failed");
      }
      const data = await res.json();
      setTickets(data);
    } catch (e: any) {
      setTicketsError(e.message);
    } finally {
      setTicketsLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchTickets(searchQuery);
  };

  // GitHub functions
  const loadGithubIssues = async (repoUrl: string) => {
    if (!repoUrl.trim()) return;
    setGithubLoading(true);
    setGithubError(null);
    try {
      const res = await fetch(`/api/github/issues?repoUrl=${encodeURIComponent(repoUrl)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to load issues");
      }
      const data = await res.json();
      setGithubIssues(data);
    } catch (e: any) {
      setGithubError(e.message);
    } finally {
      setGithubLoading(false);
    }
  };

  const handleGithubRepoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadGithubIssues(githubRepoUrl);
  };

  const handleClose = () => {
    // Closing while a node is still coming up leaves the node alone: it stays
    // listed under Settings → Devboxes and the live-nodes indicator.
    stopNodeFlow.current?.();
    stopNodeFlow.current = null;
    setNodeFlow(null);
    onClose();
  };

  type LaunchTarget = { devboxId: string; remotePath?: string } | null;

  const handleCreate = () => {
    if (!selectedAgent) return;
    if (devboxId === NEW_NODE && (!newNodeSpec || nodeFlowBusy)) return;

    const workingDir = cwd || effectiveDefaultDirectory;
    const fullCommand = selectedAgent.command
      ? (commandArgs ? `${selectedAgent.command} ${commandArgs}` : selectedAgent.command)
      : commandArgs;
    const starterPrompt = initialPrompt.trim();

    const selectedReposList = detectedRepos.filter(r => selectedRepoPaths.has(r.path));
    const isMultiRepo = createWorktree && selectedReposList.length > 1;
    const effectiveWorkingDir = workingDir;
    if (effectiveWorkingDir) {
      setLastPickedDirectory(effectiveWorkingDir);
    }
    const multiRepoParams = isMultiRepo ? {
      multiRepoMode,
      additionalRepos: selectedReposList
        .map(r => ({ name: r.name, path: r.path, defaultBranch: r.defaultBranch })),
    } : {};

    // Everything the session POSTs need is captured above, so a launch can run
    // now (local or an existing devbox) or once a new node is ready. Resolves
    // false when any session failed to start; the canvas card already shows
    // that, and the new-node path reports it inline as well.
    const launch = async (target: LaunchTarget): Promise<boolean> => {
      const targetParams = target ? { devboxId: target.devboxId, remotePath: target.remotePath } : {};

      if (isReplacing && existingSession && existingNodeId) {
        // Show creating state on the existing node
        updateSession(existingNodeId, { status: "creating" });

        try {
          await fetch(`/api/sessions/${existingSession.sessionId}`, { method: "DELETE" });

          const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: selectedAgent.id,
              agentName: selectedAgent.name,
              command: fullCommand,
              cwd: effectiveWorkingDir,
              ...targetParams,
              nodeId: existingNodeId,
              customName: customName || existingSession.customName,
              customColor: existingSession.customColor,
              initialPrompt: starterPrompt || undefined,
              ...(selectedAgent.profileId && {
                agentProfile: {
                  id: selectedAgent.profileId,
                  version: selectedAgent.profileVersion,
                },
              }),
              ...(createWorktree && branchName && {
                branchName,
                baseBranch,
                createWorktree,
                ...multiRepoParams,
              }),
              ...(selectedTicket && {
                ticketId: selectedTicket.identifier,
                ticketTitle: selectedTicket.title,
                ticketUrl: selectedTicket.url,
              }),
              ...(selectedGithubIssue && {
                ticketId: `#${selectedGithubIssue.number}`,
                ticketTitle: selectedGithubIssue.title,
                ticketUrl: selectedGithubIssue.url,
              }),
            }),
          });

          if (res.ok) {
            const {
              sessionId: newSessionId,
              gitBranch,
              cwd: newCwd,
              terminalCols,
              terminalRows,
            } = await res.json();
            updateSession(existingNodeId, {
              sessionId: newSessionId,
              agentId: selectedAgent.id,
              agentName: selectedAgent.name,
              command: fullCommand,
              cwd: newCwd || effectiveWorkingDir,
              status: "idle",
              isRestored: false,
              ticketId: selectedTicket?.identifier || (selectedGithubIssue ? `#${selectedGithubIssue.number}` : undefined),
              ticketTitle: selectedTicket?.title || selectedGithubIssue?.title,
              gitBranch: gitBranch || branchName || undefined,
              terminalCols,
              terminalRows,
            });
            return true;
          }
          updateSession(existingNodeId, { status: "error" });
          return false;
        } catch (error) {
          console.error("Failed to create session:", error);
          updateSession(existingNodeId, { status: "error" });
          return false;
        }
      }

      // Creating new agent(s) — add nodes immediately with "creating" status
      const viewport = reactFlowInstance.getViewport();
      const viewportBounds = document.querySelector('.react-flow')?.getBoundingClientRect();
      const viewportWidth = viewportBounds?.width || window.innerWidth;
      const viewportHeight = viewportBounds?.height || window.innerHeight;

      const centerX = (-viewport.x + viewportWidth / 2) / viewport.zoom;
      const centerY = (-viewport.y + viewportHeight / 2) / viewport.zoom;

      const freePositions = findFreePosition(centerX, centerY, nodes, count);
      const results: Promise<boolean>[] = [];

      for (let i = 0; i < count; i++) {
        const nodeId = `node-${Date.now()}-${i}`;
        const selectedColor = getAgentAccentColor(selectedAgent.id, selectedAgent.color);
        const agentName = count > 1
          ? `${customName || selectedAgent.name} ${i + 1}`
          : customName || selectedAgent.name;
        const placeholderSessionId = `pending-${nodeId}`;

        const { x, y } = freePositions[i];

        // Add node and session immediately with "creating" status
        addNode({
          id: nodeId,
          type: "agent",
          position: { x, y },
          data: {
            label: agentName,
            agentId: selectedAgent.id,
            color: selectedColor,
            icon: selectedAgent.icon,
            sessionId: placeholderSessionId,
          },
        });

        addSession(nodeId, {
          id: nodeId,
          sessionId: placeholderSessionId,
          agentId: selectedAgent.id,
          agentName: selectedAgent.name,
          command: fullCommand,
          color: selectedColor,
          createdAt: new Date().toISOString(),
          cwd: effectiveWorkingDir || "",
          gitBranch: branchName || undefined,
          status: "creating",
          customName: count > 1 ? agentName : customName || undefined,
          ticketId: i === 0 ? (selectedTicket?.identifier || (selectedGithubIssue ? `#${selectedGithubIssue.number}` : undefined)) : undefined,
          ticketTitle: i === 0 ? (selectedTicket?.title || selectedGithubIssue?.title) : undefined,
        });

        // Fire the session creation in the background
        const agentIndex = i;
        results.push((async () => {
          try {
            const res = await fetch("/api/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                command: fullCommand,
                cwd: effectiveWorkingDir,
                ...targetParams,
                nodeId,
                customName: count > 1 ? agentName : customName || undefined,
                initialPrompt: starterPrompt || undefined,
                ...(selectedAgent.profileId && {
                  agentProfile: {
                    id: selectedAgent.profileId,
                    version: selectedAgent.profileVersion,
                  },
                }),
                ...(agentIndex === 0 && createWorktree && branchName && {
                  branchName,
                  baseBranch,
                  createWorktree,
                  ...multiRepoParams,
                }),
                ...(agentIndex === 0 && selectedTicket && {
                  ticketId: selectedTicket.identifier,
                  ticketTitle: selectedTicket.title,
                  ticketUrl: selectedTicket.url,
                }),
                ...(agentIndex === 0 && selectedGithubIssue && {
                  ticketId: `#${selectedGithubIssue.number}`,
                  ticketTitle: selectedGithubIssue.title,
                  ticketUrl: selectedGithubIssue.url,
                }),
              }),
            });

            if (res.ok) {
              const {
                sessionId,
                gitBranch,
                cwd: newCwd,
                launchCheckpoint,
                terminalCols,
                terminalRows,
              } = await res.json();
              updateSession(nodeId, {
                sessionId,
                cwd: newCwd || effectiveWorkingDir,
                gitBranch: gitBranch || branchName || undefined,
                launchCheckpoint,
                terminalCols,
                terminalRows,
                status: "idle",
              });
              return true;
            }
            updateSession(nodeId, { status: "error" });
            return false;
          } catch (error) {
            console.error("Failed to create session:", error);
            updateSession(nodeId, { status: "error" });
            return false;
          }
        })());
      }

      return (await Promise.all(results)).every(Boolean);
    };

    if (devboxId === NEW_NODE && newNodeSpec) {
      void provisionThenLaunch(newNodeSpec, launch);
      return;
    }

    // Close modal immediately so the UI stays responsive
    handleClose();
    void launch(devboxId ? { devboxId, remotePath: remotePath.trim() || undefined } : null);
  };

  // Ask for the node, then poll it until it is ready (launch the session and
  // close) or gone (say why and stay open). A request parked for approval keeps
  // polling: the approval may well arrive while the modal is up.
  const provisionThenLaunch = async (
    spec: NodeRequest,
    launch: (target: LaunchTarget) => Promise<boolean>,
  ) => {
    let stopped = false;
    stopNodeFlow.current = () => { stopped = true; };
    setNodeFlow({ phase: "requesting" });

    const result = await createNode(spec);
    if (stopped) return;
    if (!result.ok) {
      stopNodeFlow.current = null;
      setNodeFlow({ phase: "error", message: result.error });
      return;
    }

    let node = result.node;
    setNodeFlow(nodeFlowFor(node, result.reasons));

    while (!stopped) {
      await sleep(NODE_POLL_MS);
      if (stopped) return;
      try {
        const res = await fetch(`/api/compute/nodes/${encodeURIComponent(node.id)}`);
        if (res.status === 404) {
          stopNodeFlow.current = null;
          setNodeFlow({ phase: "error", nodeId: node.id, name: node.name, message: `${node.name} is no longer listed; the request may have been withdrawn.` });
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { node?: ProvisionedNode };
        if (data.node) node = data.node;
      } catch {
        continue; // transient: keep polling
      }
      if (stopped) return;

      const status = node.provision.status;
      if (status === "ready") {
        setNodeFlow({ phase: "starting", nodeId: node.id, name: node.name });
        const ok = await launch({ devboxId: node.id, remotePath: node.defaultPath });
        if (stopped) return;
        stopNodeFlow.current = null;
        if (ok) {
          setNodeFlow(null);
          onClose();
        } else {
          setNodeFlow({
            phase: "error",
            nodeId: node.id,
            name: node.name,
            message: `${node.name} is ready, but the session could not be started. The node stays up; see Settings → Devboxes.`,
          });
        }
        return;
      }
      if (status === "error" || status === "terminated") {
        stopNodeFlow.current = null;
        setNodeFlow({
          phase: "error",
          nodeId: node.id,
          name: node.name,
          message:
            node.provision.error ||
            (status === "terminated"
              ? `${node.name} was ${node.provision.terminateReason === "user" ? "withdrawn" : "terminated"} before a session could start.`
              : `Provisioning ${node.name} failed.`),
        });
        return;
      }
      setNodeFlow(nodeFlowFor(node));
    }
  };

  // Stop waiting and take the request back: deny while it is parked, terminate
  // once it is provisioning. Both are final; the button says which it will do.
  const cancelNodeFlow = async () => {
    const flow = nodeFlow;
    stopNodeFlow.current?.();
    stopNodeFlow.current = null;
    if (!flow?.nodeId) {
      setNodeFlow(null);
      return;
    }
    setNodeFlow({ phase: "cancelling", nodeId: flow.nodeId, name: flow.name });
    try {
      if (flow.phase === "pending") {
        await fetch(`/api/compute/nodes/${encodeURIComponent(flow.nodeId)}/deny`, { method: "POST" });
      } else {
        await fetch(`/api/compute/nodes/${encodeURIComponent(flow.nodeId)}`, { method: "DELETE" });
      }
    } catch {
      // The node is still listed under Settings → Devboxes either way.
    }
    setNodeFlow(null);
  };

  const priorityColors: Record<number, string> = {
    0: "#6B7280",
    1: "#EF4444",
    2: "#D97652",
    3: "#FBBF24",
    4: "#22C55E",
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div className="pointer-events-auto w-full max-w-lg mx-4">
              <div className="rounded-xl bg-surface border border-border shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
                {/* Header */}
                <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
                  <h2 className="text-base font-semibold text-white">
                    {isReplacing ? "New Session" : "New Agent"}
                  </h2>
                  <button
                    onClick={handleClose}
                    className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Tabs */}
                <div className="px-5 pt-4 flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => {
                      setActiveTab("blank");
                      setSelectedTicket(null);
                      setSelectedGithubIssue(null);
                    }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      activeTab === "blank"
                        ? "bg-white text-canvas"
                        : "text-zinc-400 hover:text-white hover:bg-surface-active"
                    }`}
                  >
                    Blank
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab("linear");
                      setSelectedGithubIssue(null);
                    }}
                    disabled={linearConfigured === false}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      activeTab === "linear"
                        ? "bg-indigo-600 text-white"
                        : linearConfigured === false
                        ? "text-zinc-600 cursor-not-allowed"
                        : "text-zinc-400 hover:text-white hover:bg-surface-active"
                    }`}
                  >
                    <Ticket className="w-3.5 h-3.5" />
                    Linear
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab("github");
                      setSelectedTicket(null);
                    }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      activeTab === "github"
                        ? "bg-zinc-700 text-white"
                        : "text-zinc-400 hover:text-white hover:bg-surface-active"
                    }`}
                  >
                    <Github className="w-3.5 h-3.5" />
                    GitHub
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {/* Agent selection (only for new agents) */}
                  {!isReplacing && (
                    <div className="space-y-2">
                      <label className="text-xs text-zinc-500">Select Agent</label>
                      <div className="grid grid-cols-2 gap-2">
                        {agents.map((agent) => {
                          const isSelected = selectedAgent?.id === agent.id;
                          const displayColor = getAgentAccentColor(agent.id, agent.color);
                          const useBrandOnly = agent.id === "codex" || agent.id === "claude";
                          return (
                            <button
                              key={agent.id}
                              onClick={() => {
                                setSelectedAgent(agent);
                                setCommandArgs(
                                  agent.id === "claude"
                                    ? "--dangerously-skip-permissions"
                                    : agent.id === "codex"
                                      ? "--yolo"
                                      : ""
                                );
                              }}
                              className={`group relative rounded-md border p-3 transition-all ${
                                useBrandOnly ? "text-center" : "text-left"
                              } ${
                                isSelected
                                  ? "border-zinc-200/40 bg-surface-active"
                                  : "border-border hover:border-zinc-600 hover:bg-surface-hover"
                              }`}
                              aria-label={`${agent.name}: ${agent.description}`}
                              title={`${agent.name}: ${agent.description}`}
                            >
                              <div
                                className={`relative rounded-md flex items-center justify-center ${
                                  useBrandOnly ? "mx-auto h-14 w-14" : "mb-2 h-8 w-8"
                                }`}
                                style={{ backgroundColor: useBrandOnly ? "transparent" : `${displayColor}18` }}
                              >
                                <AgentIcon
                                  agentId={agent.id}
                                  iconId={agent.icon}
                                  className={useBrandOnly ? "h-12 w-12" : "h-4 w-4"}
                                  style={{ color: displayColor }}
                                />
                                <span
                                  className="absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full border border-canvas-dark"
                                  style={{ backgroundColor: displayColor }}
                                />
                              </div>
                              {useBrandOnly ? (
                                <>
                                  <span className="mt-2 block text-xs font-medium text-zinc-200">
                                    {agent.name}
                                  </span>
                                  <span className="mt-1 block min-h-[1.5rem] text-[10px] leading-snug text-zinc-500 opacity-0 transition-all duration-150 group-hover:text-zinc-300 group-hover:opacity-100 group-focus-visible:text-zinc-300 group-focus-visible:opacity-100">
                                    {agent.description}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <h3 className="text-sm font-medium text-white">{agent.name}</h3>
                                  <p className="text-[10px] text-zinc-500 mt-0.5">{agent.description}</p>
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Linear ticket selection */}
                  {activeTab === "linear" && (
                    <div className="space-y-3">
                      {!selectedTicket ? (
                        <>
                          {/* Search */}
                          <form onSubmit={handleSearch} className="flex gap-2">
                            <div className="relative flex-1">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                              <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search tickets..."
                                className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => loadMyTickets()}
                              disabled={ticketsLoading}
                              className="px-3 py-2 rounded-md bg-canvas border border-border text-zinc-400 hover:text-white hover:bg-surface-active disabled:opacity-50 transition-colors"
                              title="Refresh tickets"
                            >
                              <RefreshCw className={`w-4 h-4 ${ticketsLoading ? "animate-spin" : ""}`} />
                            </button>
                          </form>

                          {/* Ticket list */}
                          <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                            {ticketsLoading ? (
                              <div className="p-6 text-center">
                                <Loader2 className="w-5 h-5 text-zinc-500 animate-spin mx-auto" />
                              </div>
                            ) : ticketsError ? (
                              <div className="p-4 text-center">
                                <AlertCircle className="w-5 h-5 text-red-500 mx-auto mb-1" />
                                <p className="text-xs text-red-400">{ticketsError}</p>
                              </div>
                            ) : tickets.length === 0 ? (
                              <div className="p-6 text-center text-zinc-500 text-sm">
                                No tickets found
                              </div>
                            ) : (
                              tickets.map((ticket) => (
                                <button
                                  key={ticket.id}
                                  onClick={() => setSelectedTicket(ticket)}
                                  className="w-full p-3 hover:bg-canvas text-left transition-colors flex items-start gap-2 border-b border-border last:border-b-0"
                                >
                                  <div
                                    className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                                    style={{ backgroundColor: priorityColors[ticket.priority] || "#6B7280" }}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <span className="text-[10px] font-mono text-indigo-400">
                                        {ticket.identifier}
                                      </span>
                                      <span
                                        className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                                        style={{
                                          backgroundColor: `${ticket.state.color}20`,
                                          color: ticket.state.color,
                                        }}
                                      >
                                        {ticket.state.name}
                                      </span>
                                    </div>
                                    <p className="text-xs text-white truncate">{ticket.title}</p>
                                  </div>
                                </button>
                              ))
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Selected ticket */}
                          <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-mono font-semibold text-indigo-400">
                                {selectedTicket.identifier}
                              </span>
                              <button
                                onClick={() => setSelectedTicket(null)}
                                className="text-[10px] text-zinc-500 hover:text-white"
                              >
                                Change
                              </button>
                            </div>
                            <p className="text-sm text-white">{selectedTicket.title}</p>
                          </div>

                          {/* Branch options */}
                          <div>
                            <label className="text-xs text-zinc-500 flex items-center gap-1 mb-1.5">
                              <GitBranch className="w-3 h-3" />
                              Branch name
                            </label>
                            <input
                              type="text"
                              value={branchName}
                              onChange={(e) => setBranchName(e.target.value)}
                              className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                          </div>

                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={createWorktree}
                              onChange={(e) => setCreateWorktree(e.target.checked)}
                              className="w-4 h-4 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                            />
                            <span className="text-sm text-zinc-300">Create git worktree</span>
                          </label>

                          {createWorktree && (
                            <div className="space-y-2">
                              <label className="text-xs text-zinc-500 mb-1 block">Branch off from</label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="linear-worktree-base"
                                  checked={multiRepoMode === 'main'}
                                  onChange={() => setMultiRepoMode('main')}
                                  className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                                />
                                <span className="text-sm text-zinc-300">A specific base branch</span>
                              </label>
                              {multiRepoMode === 'main' && (
                                <input
                                  type="text"
                                  value={baseBranch}
                                  onChange={(e) => setBaseBranch(e.target.value)}
                                  placeholder="main"
                                  className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors ml-5"
                                  style={{ width: 'calc(100% - 1.25rem)' }}
                                />
                              )}
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="linear-worktree-base"
                                  checked={multiRepoMode === 'current'}
                                  onChange={() => setMultiRepoMode('current')}
                                  className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                                />
                                <div>
                                  <span className="text-sm text-zinc-300">Each repo's current branch</span>
                                  {detectedRepos.length > 0 && (
                                    <p className="text-[10px] text-zinc-600">
                                      {detectedRepos.filter(r => selectedRepoPaths.has(r.path)).map(r => `${r.name}: ${r.branch}`).join(', ')}
                                    </p>
                                  )}
                                </div>
                              </label>
                            </div>
                          )}

                          {/* Multi-repo detection */}
                          {createWorktree && detectedRepos.length > 1 && (
                            <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs text-indigo-300 font-medium">
                                    Repos in {cwd.split("/").pop() || cwd}
                                  </p>
                                  {scanningRepos && <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const allSelected = detectedRepos.every(r => selectedRepoPaths.has(r.path));
                                    setSelectedRepoPaths(allSelected ? new Set() : new Set(detectedRepos.map(r => r.path)));
                                  }}
                                  className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                                >
                                  {detectedRepos.every(r => selectedRepoPaths.has(r.path)) ? "Deselect all" : "Select all"}
                                </button>
                              </div>

                              <div className="space-y-1.5">
                                {detectedRepos.map((repo) => (
                                  <label key={repo.path} className="flex items-center gap-2 cursor-pointer group">
                                    <input
                                      type="checkbox"
                                      checked={selectedRepoPaths.has(repo.path)}
                                      onChange={(e) => {
                                        const next = new Set(selectedRepoPaths);
                                        if (e.target.checked) next.add(repo.path);
                                        else next.delete(repo.path);
                                        setSelectedRepoPaths(next);
                                      }}
                                      className="w-3.5 h-3.5 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                                    />
                                    <span className="text-sm text-zinc-300">{repo.name}</span>
                                    <span className="text-[10px] text-zinc-500 font-mono">{repo.branch}</span>
                                    {repo.dirty && (
                                      <span className="text-[10px] text-amber-400">modified</span>
                                    )}
                                  </label>
                                ))}
                              </div>

                              {detectedRepos.some(r => r.dirty && selectedRepoPaths.has(r.path)) && (
                                <p className="text-[10px] text-amber-400/70 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" />
                                  Uncommitted changes will be stashed
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* GitHub issue selection */}
                  {activeTab === "github" && (
                    <div className="space-y-3">
                      {!selectedGithubIssue ? (
                        <>
                          {/* Repo URL input */}
                          <form onSubmit={handleGithubRepoSubmit}>
                            <div className="space-y-2">
                              <label className="text-xs text-zinc-500">GitHub Repository URL</label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={githubRepoUrl}
                                  onChange={(e) => setGithubRepoUrl(e.target.value)}
                                  placeholder="https://github.com/owner/repo"
                                  className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
                                />
                                <button
                                  type="submit"
                                  disabled={!githubRepoUrl.trim() || githubLoading}
                                  className="px-3 py-2 rounded-md bg-zinc-700 text-white text-sm font-medium hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  {githubLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load"}
                                </button>
                              </div>
                            </div>
                          </form>

                          {/* Issue list */}
                          {(githubIssues.length > 0 || githubError) && (
                            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                              {githubLoading ? (
                                <div className="p-6 text-center">
                                  <Loader2 className="w-5 h-5 text-zinc-500 animate-spin mx-auto" />
                                </div>
                              ) : githubError ? (
                                <div className="p-4 text-center">
                                  <AlertCircle className="w-5 h-5 text-red-500 mx-auto mb-1" />
                                  <p className="text-xs text-red-400">{githubError}</p>
                                </div>
                              ) : githubIssues.length === 0 ? (
                                <div className="p-6 text-center text-zinc-500 text-sm">
                                  No open issues found
                                </div>
                              ) : (
                                githubIssues.map((issue) => (
                                  <button
                                    key={issue.id}
                                    onClick={() => setSelectedGithubIssue(issue)}
                                    className="w-full p-3 hover:bg-canvas text-left transition-colors flex items-start gap-2 border-b border-border last:border-b-0"
                                  >
                                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-green-500" />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[10px] font-mono text-zinc-400">
                                          #{issue.number}
                                        </span>
                                        {issue.labels.slice(0, 2).map((label) => (
                                          <span
                                            key={label.name}
                                            className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                                            style={{
                                              backgroundColor: `#${label.color}20`,
                                              color: `#${label.color}`,
                                            }}
                                          >
                                            {label.name}
                                          </span>
                                        ))}
                                      </div>
                                      <p className="text-xs text-white truncate">{issue.title}</p>
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {/* Selected issue */}
                          <div className="p-3 rounded-lg bg-zinc-700/30 border border-zinc-600/30">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-mono font-semibold text-zinc-300">
                                #{selectedGithubIssue.number}
                              </span>
                              <button
                                onClick={() => setSelectedGithubIssue(null)}
                                className="text-[10px] text-zinc-500 hover:text-white"
                              >
                                Change
                              </button>
                            </div>
                            <p className="text-sm text-white">{selectedGithubIssue.title}</p>
                          </div>

                          {/* Branch options */}
                          <div>
                            <label className="text-xs text-zinc-500 flex items-center gap-1 mb-1.5">
                              <GitBranch className="w-3 h-3" />
                              Branch name
                            </label>
                            <input
                              type="text"
                              value={branchName}
                              onChange={(e) => setBranchName(e.target.value)}
                              className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                          </div>

                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={createWorktree}
                              onChange={(e) => setCreateWorktree(e.target.checked)}
                              className="w-4 h-4 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                            />
                            <span className="text-sm text-zinc-300">Create git worktree</span>
                          </label>

                          {createWorktree && (
                            <div className="space-y-2">
                              <label className="text-xs text-zinc-500 mb-1 block">Branch off from</label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="github-worktree-base"
                                  checked={multiRepoMode === 'current'}
                                  onChange={() => setMultiRepoMode('current')}
                                  className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                                />
                                <div>
                                  <span className="text-sm text-zinc-300">Each repo's current branch</span>
                                  {detectedRepos.length > 0 && (
                                    <p className="text-[10px] text-zinc-600">
                                      {detectedRepos.filter(r => selectedRepoPaths.has(r.path)).map(r => `${r.name}: ${r.branch}`).join(', ')}
                                    </p>
                                  )}
                                </div>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="github-worktree-base"
                                  checked={multiRepoMode === 'main'}
                                  onChange={() => setMultiRepoMode('main')}
                                  className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                                />
                                <span className="text-sm text-zinc-300">A specific base branch</span>
                              </label>
                              {multiRepoMode === 'main' && (
                                <input
                                  type="text"
                                  value={baseBranch}
                                  onChange={(e) => setBaseBranch(e.target.value)}
                                  placeholder="main"
                                  className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors ml-5"
                                  style={{ width: 'calc(100% - 1.25rem)' }}
                                />
                              )}
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="github-worktree-base"
                                  checked={multiRepoMode === 'current'}
                                  onChange={() => setMultiRepoMode('current')}
                                  className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                                />
                                <div>
                                  <span className="text-sm text-zinc-300">Each repo's current branch</span>
                                  {detectedRepos.length > 0 && (
                                    <p className="text-[10px] text-zinc-600">
                                      {detectedRepos.filter(r => selectedRepoPaths.has(r.path)).map(r => `${r.name}: ${r.branch}`).join(', ')}
                                    </p>
                                  )}
                                </div>
                              </label>
                            </div>
                          )}

                          {/* Multi-repo detection */}
                          {createWorktree && detectedRepos.length > 1 && (
                            <div className="rounded-md border border-zinc-600/30 bg-zinc-700/20 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs text-zinc-300 font-medium">
                                    Repos in {cwd.split("/").pop() || cwd}
                                  </p>
                                  {scanningRepos && <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const allSelected = detectedRepos.every(r => selectedRepoPaths.has(r.path));
                                    setSelectedRepoPaths(allSelected ? new Set() : new Set(detectedRepos.map(r => r.path)));
                                  }}
                                  className="text-[10px] text-zinc-400 hover:text-zinc-300 transition-colors"
                                >
                                  {detectedRepos.every(r => selectedRepoPaths.has(r.path)) ? "Deselect all" : "Select all"}
                                </button>
                              </div>

                              <div className="space-y-1.5">
                                {detectedRepos.map((repo) => (
                                  <label key={repo.path} className="flex items-center gap-2 cursor-pointer group">
                                    <input
                                      type="checkbox"
                                      checked={selectedRepoPaths.has(repo.path)}
                                      onChange={(e) => {
                                        const next = new Set(selectedRepoPaths);
                                        if (e.target.checked) next.add(repo.path);
                                        else next.delete(repo.path);
                                        setSelectedRepoPaths(next);
                                      }}
                                      className="w-3.5 h-3.5 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                                    />
                                    <span className="text-sm text-zinc-300">{repo.name}</span>
                                    <span className="text-[10px] text-zinc-500 font-mono">{repo.branch}</span>
                                    {repo.dirty && (
                                      <span className="text-[10px] text-amber-400">modified</span>
                                    )}
                                  </label>
                                ))}
                              </div>

                              {detectedRepos.some(r => r.dirty && selectedRepoPaths.has(r.path)) && (
                                <p className="text-[10px] text-amber-400/70 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" />
                                  Uncommitted changes will be stashed
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Name & Count (only for new agents) */}
                  {!isReplacing && (
                    <div className="flex gap-3">
                      <div className="flex-1 space-y-2">
                        <label className="text-xs text-zinc-500">Name (auto-named from first prompt)</label>
                        <input
                          type="text"
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                          placeholder={selectedAgent?.name || "My Agent"}
                          className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                        />
                      </div>
                      <div className="w-28 space-y-2">
                        <label className="text-xs text-zinc-500">Count</label>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCount(Math.max(1, count - 1))}
                            className="w-8 h-9 rounded-md bg-canvas border border-border text-zinc-400 hover:text-white hover:bg-surface-active transition-colors flex items-center justify-center"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <input
                            type="number"
                            value={count}
                            onChange={(e) =>
                              setCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                            }
                            min={1}
                            max={20}
                            className="w-10 h-9 rounded-md bg-canvas border border-border text-white text-sm text-center focus:outline-none focus:border-zinc-500 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <button
                            onClick={() => setCount(Math.min(20, count + 1))}
                            className="w-8 h-9 rounded-md bg-canvas border border-border text-zinc-400 hover:text-white hover:bg-surface-active transition-colors flex items-center justify-center"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Starter prompt */}
                  <div className="space-y-2">
                    <label className="text-xs text-zinc-500">Starter prompt</label>
                    <textarea
                      value={initialPrompt}
                      onChange={(event) => setInitialPrompt(event.target.value)}
                      rows={5}
                      placeholder="Optional first message to send after the agent starts..."
                      className="w-full resize-y rounded-md bg-canvas border border-border px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                  </div>

                  {/* Command arguments stay out of the path for managed profiles. */}
                  {!selectedAgent?.profileId && <div className="space-y-2">
                    <label className="text-xs text-zinc-500 flex items-center gap-1.5">
                      <Terminal className="w-3 h-3" />
                      {selectedAgent?.command ? "Arguments (optional)" : "Command"}
                    </label>
                    <input
                      type="text"
                      value={commandArgs}
                      onChange={(e) => setCommandArgs(e.target.value)}
                      placeholder={selectedAgent?.command ? "e.g. --model opus or --resume" : "Select Claude or Codex first"}
                      className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
                    />
                    {selectedAgent && (selectedAgent.command || commandArgs) && (
                      <p className="text-[10px] text-zinc-600 font-mono">
                        {selectedAgent.command}{selectedAgent.command && commandArgs ? " " : ""}{commandArgs}
                      </p>
                    )}
                  </div>}

                  {/* Run on: local, one of the configured devboxes, or a node
                      provisioned on the way in. Always shown: a node can be
                      created even when no devbox exists yet. */}
                  <div className="space-y-2">
                    <label htmlFor="new-session-run-on" className="text-xs text-zinc-500 flex items-center gap-1.5">
                      <Server className="w-3 h-3" />
                      Run on
                    </label>
                    <select
                      id="new-session-run-on"
                      value={devboxId}
                      disabled={nodeFlowBusy}
                      onChange={(e) => {
                        const next = e.target.value;
                        setDevboxId(next);
                        if (next !== NEW_NODE) {
                          setNodeFlow(null);
                          setNewNodeSpec(null);
                        }
                        const box = devboxes.find((item) => item.id === next);
                        setRemotePath(box?.defaultPath || "");
                      }}
                      className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-50"
                    >
                      <option value="">This Mac</option>
                      {selectableDevboxes.map((box) => (
                        <option key={box.id} value={box.id}>
                          {box.name}
                          {box.provision ? ` · ${box.provision.provider} ${box.provision.gpu ?? "CPU"}` : ""}
                        </option>
                      ))}
                      <option value={NEW_NODE}>New node…</option>
                    </select>
                    {devboxId && devboxId !== NEW_NODE && (
                      <input
                        type="text"
                        value={remotePath}
                        onChange={(e) => setRemotePath(e.target.value)}
                        placeholder="Remote directory (optional)"
                        aria-label="Remote directory"
                        className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
                      />
                    )}
                    {devboxId === NEW_NODE && (
                      <div className="rounded-md border border-border bg-canvas/40 p-3 space-y-2">
                        <NewNodeForm
                          compact
                          onSpecChange={setNewNodeSpec}
                          onCreated={() => {}}
                          onCancel={() => setDevboxId("")}
                        />
                        <p className="text-[11px] text-zinc-600">
                          The session starts in the node's home directory once the node is ready.
                        </p>
                        {nodeFlow && (
                          <div
                            role={nodeFlow.phase === "error" ? "alert" : "status"}
                            className={`rounded-md border px-3 py-2 text-xs ${
                              nodeFlow.phase === "error"
                                ? "border-red-500/30 bg-red-500/5 text-red-400"
                                : "border-border bg-canvas text-zinc-300"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2">
                                {nodeFlow.phase !== "error" && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
                                {nodeFlowLabel(nodeFlow)}
                              </span>
                              {nodeFlow.phase !== "error" && nodeFlow.phase !== "cancelling" && nodeFlow.nodeId && (
                                <button
                                  type="button"
                                  onClick={() => void cancelNodeFlow()}
                                  className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 hover:text-red-300 hover:border-red-500/40 transition-colors"
                                >
                                  {nodeFlow.phase === "pending" ? "Withdraw request" : "Cancel and terminate"}
                                </button>
                              )}
                            </div>
                            {nodeFlow.phase === "pending" && nodeFlow.reasons && nodeFlow.reasons.length > 0 && (
                              <ul className="mt-1 list-disc pl-4 text-[11px] text-zinc-500">
                                {nodeFlow.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Working directory — local only; a devbox session runs from
                      the remote directory above, and this just anchors the ssh
                      client on this machine. */}
                  {!devboxId && <div className="space-y-2">
                    <label className="text-xs text-zinc-500 flex items-center gap-1.5">
                      <FolderOpen className="w-3 h-3" />
                      Working Directory
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={cwd}
                        onChange={(e) => setCwd(e.target.value)}
                        onBlur={() => { if (cwd) scanForRepos(cwd); }}
                        placeholder={effectiveDefaultDirectory || "~/"}
                        className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
                      />
                      <button
                        type="button"
                        onClick={openDirPicker}
                        className="px-3 py-2 rounded-md bg-canvas border border-border text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
                        title="Browse directories"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                    </div>

                    {rememberLastDirectory && lastPickedDirectory && (
                      <button
                        type="button"
                        onClick={() => selectDirectory(lastPickedDirectory)}
                        className="flex w-full items-center gap-2 rounded-md border border-border bg-canvas px-3 py-2 text-left transition-colors hover:bg-surface-active"
                        title={lastPickedDirectory}
                      >
                        <FolderOpen className="h-4 w-4 flex-shrink-0 text-zinc-500" />
                        <span className="text-xs font-medium text-zinc-400">Last picked</span>
                        <span className="min-w-0 flex-1 truncate text-xs font-mono text-zinc-500">
                          {lastPickedDirectory}
                        </span>
                      </button>
                    )}

                    {/* Directory picker inline panel */}
                    {showDirPicker && (
                      <div className="rounded-md border border-border bg-canvas overflow-hidden">
                        {/* Current path header */}
                        <div className="px-3 py-2 bg-surface border-b border-border flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            {dirBrowseParent && (
                              <button
                                onClick={() => browsePath(dirBrowseParent)}
                                className="p-1 rounded hover:bg-surface-active text-zinc-400 hover:text-white transition-colors flex-shrink-0"
                                title="Go up"
                              >
                                <ArrowUp className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={() => browsePath("~")}
                              className="p-1 rounded hover:bg-surface-active text-zinc-400 hover:text-white transition-colors flex-shrink-0"
                              title="Home directory"
                            >
                              <Home className="w-4 h-4" />
                            </button>
                            <span className="text-xs font-mono text-zinc-400 truncate" title={dirBrowsePath}>
                              {dirBrowsePath}
                            </span>
                          </div>
                          <button
                            onClick={() => setShowDirPicker(false)}
                            className="p-1 rounded hover:bg-surface-active text-zinc-500 hover:text-white transition-colors flex-shrink-0 ml-2"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Directory list */}
                        <div className="max-h-40 overflow-y-auto">
                          {dirBrowseLoading ? (
                            <div className="p-4 text-center">
                              <Loader2 className="w-4 h-4 text-zinc-500 animate-spin mx-auto" />
                            </div>
                          ) : dirBrowseError ? (
                            <div className="p-3 text-center">
                              <AlertCircle className="w-4 h-4 text-red-500 mx-auto mb-1" />
                              <p className="text-xs text-red-400">{dirBrowseError}</p>
                            </div>
                          ) : dirBrowseDirs.length === 0 ? (
                            <div className="p-4 text-center text-zinc-500 text-xs">
                              No subdirectories
                            </div>
                          ) : (
                            dirBrowseDirs.map((dir) => (
                              <div
                                key={dir.path}
                                className="flex items-center border-b border-border last:border-b-0"
                              >
                                <button
                                  onClick={() => browsePath(dir.path)}
                                  className="flex-1 flex items-center gap-2 px-3 py-2 hover:bg-surface-active transition-colors text-left"
                                >
                                  <FolderOpen className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                                  <span className="text-sm text-white truncate">{dir.name}</span>
                                </button>
                                <button
                                  onClick={() => selectDirectory(dir.path)}
                                  className="px-3 py-2 text-xs text-zinc-500 hover:text-white hover:bg-surface-active transition-colors border-l border-border"
                                >
                                  Select
                                </button>
                              </div>
                            ))
                          )}
                        </div>

                        {/* Select current directory button */}
                        <div className="px-3 py-2 border-t border-border">
                          <button
                            onClick={() => selectDirectory(dirBrowsePath)}
                            className="w-full px-3 py-1.5 rounded-md text-xs font-medium text-white bg-surface-active hover:bg-zinc-700 transition-colors"
                          >
                            Select current: {dirBrowsePath.split("/").pop() || dirBrowsePath}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>}

                  {/* Worktree options (blank tab) */}
                  {activeTab === "blank" && detectedRepos.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <GitBranch className="w-3 h-3 text-zinc-500" />
                        <span className="text-xs text-zinc-500">Git Worktree</span>
                      </div>

                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createWorktree}
                          onChange={(e) => setCreateWorktree(e.target.checked)}
                          className="w-4 h-4 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                        />
                        <span className="text-sm text-zinc-300">Create git worktree</span>
                      </label>

                      {createWorktree && (
                        <>
                          <div>
                            <label className="text-xs text-zinc-500 flex items-center gap-1 mb-1.5">
                              <GitBranch className="w-3 h-3" />
                              New branch name
                            </label>
                            <input
                              type="text"
                              value={branchName}
                              onChange={(e) => setBranchName(e.target.value)}
                              placeholder="e.g. feat/my-feature"
                              className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="text-xs text-zinc-500 mb-1 block">Branch off from</label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="blank-worktree-base"
                                checked={multiRepoMode === 'main'}
                                onChange={() => setMultiRepoMode('main')}
                                className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                              />
                              <span className="text-sm text-zinc-300">A specific base branch</span>
                            </label>
                            {multiRepoMode === 'main' && (
                              <input
                                type="text"
                                value={baseBranch}
                                onChange={(e) => setBaseBranch(e.target.value)}
                                placeholder="main"
                                className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors ml-5"
                                style={{ width: 'calc(100% - 1.25rem)' }}
                              />
                            )}
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="blank-worktree-base"
                                checked={multiRepoMode === 'current'}
                                onChange={() => setMultiRepoMode('current')}
                                className="w-3.5 h-3.5 text-indigo-600 bg-canvas border-zinc-600"
                              />
                              <div>
                                <span className="text-sm text-zinc-300">Each repo's current branch</span>
                                {detectedRepos.length > 0 && (
                                  <p className="text-[10px] text-zinc-600">
                                    {detectedRepos.filter(r => selectedRepoPaths.has(r.path)).map(r => `${r.name}: ${r.branch}`).join(', ')}
                                  </p>
                                )}
                              </div>
                            </label>
                          </div>

                          {detectedRepos.length > 1 && (
                            <div className="rounded-md border border-zinc-600/30 bg-zinc-700/20 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs text-zinc-300 font-medium">
                                    Repos in {(cwd || launchCwd || "").split("/").pop() || cwd || launchCwd}
                                  </p>
                                  {scanningRepos && <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const allSelected = detectedRepos.every(r => selectedRepoPaths.has(r.path));
                                    setSelectedRepoPaths(allSelected ? new Set() : new Set(detectedRepos.map(r => r.path)));
                                  }}
                                  className="text-[10px] text-zinc-400 hover:text-zinc-300 transition-colors"
                                >
                                  {detectedRepos.every(r => selectedRepoPaths.has(r.path)) ? "Deselect all" : "Select all"}
                                </button>
                              </div>

                              <div className="space-y-1.5">
                                {detectedRepos.map((repo) => (
                                  <label key={repo.path} className="flex items-center gap-2 cursor-pointer group">
                                    <input
                                      type="checkbox"
                                      checked={selectedRepoPaths.has(repo.path)}
                                      onChange={(e) => {
                                        const next = new Set(selectedRepoPaths);
                                        if (e.target.checked) next.add(repo.path);
                                        else next.delete(repo.path);
                                        setSelectedRepoPaths(next);
                                      }}
                                      className="w-3.5 h-3.5 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                                    />
                                    <span className="text-xs text-zinc-300 group-hover:text-white transition-colors font-mono">
                                      {repo.name}
                                    </span>
                                    <span className="text-[10px] text-zinc-600 font-mono">{repo.branch}</span>
                                    {repo.dirty && <span className="text-[10px] text-amber-500">modified</span>}
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 bg-canvas border-t border-border flex justify-end gap-2 flex-shrink-0">
                  <button
                    onClick={handleClose}
                    className="px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={
                      !selectedAgent ||
                      (!selectedAgent?.command && !commandArgs) ||
                      (activeTab === "linear" && !selectedTicket) ||
                      (activeTab === "github" && !selectedGithubIssue) ||
                      (devboxId === NEW_NODE && (!newNodeSpec || nodeFlowBusy))
                    }
                    className="px-4 py-1.5 rounded-md text-sm font-medium text-canvas bg-white hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    {nodeFlowBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {nodeFlowBusy
                      ? "Provisioning…"
                      : isReplacing
                      ? "Start Session"
                      : count > 1
                      ? `Create ${count} Agents`
                      : "Create"}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
