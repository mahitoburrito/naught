import type { IPty } from "node-pty";
import type WebSocket from "ws";

export type AgentStatus = "running" | "waiting_input" | "tool_calling" | "idle" | "disconnected" | "error";

/** How a status was arrived at. See services/agentStatus.ts. */
export type AgentStatusSource = "authoritative" | "hook" | "inferred";

export type TerminalBlockStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";

export type TerminalBlockFailureKind =
  | "command_not_found"
  | "not_executable"
  | "exit_error";

export type TerminalBlockSource = "shell-integration" | "inferred" | "recovered";

export interface TerminalCommandBlock {
  id: string;
  sequence: number;
  command: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  status: TerminalBlockStatus;
  failureKind?: TerminalBlockFailureKind;
  source: TerminalBlockSource;
  output: string;
  outputTruncated: boolean;
  bookmarked?: boolean;
  note?: string;
  sensitive?: boolean;
  shellIntegration?: string;
  shellEpochId?: string;
  shellDepth?: number;
  frameRedrawsInPlace?: boolean;
}

export type TerminalLifecyclePhase =
  | "unknown"
  | "at_prompt"
  | "executing"
  | "awaiting_prompt"
  | "terminated";

export type TerminalMouseTrackingMode = "none" | "click" | "drag" | "motion";
export type TerminalMouseEncoding = "default" | "utf8" | "sgr";

export interface TerminalModeSnapshot {
  applicationCursorKeys: boolean;
  mouseTracking: TerminalMouseTrackingMode;
  focusReporting: boolean;
  mouseEncoding: TerminalMouseEncoding;
  alternateScroll: boolean;
  synchronizedOutput: boolean;
}

export interface TerminalLifecycleSnapshot {
  phase: TerminalLifecyclePhase;
  currentCwd: string;
  shellIntegration?: string;
  shellEpochId?: string;
  shellDepth: number;
  activeBlockId?: string;
  alternateScreen: boolean;
  bracketedPasteEnabled: boolean;
  terminalModes: TerminalModeSnapshot;
  blocks: TerminalCommandBlock[];
}

export type TerminalShellCompletionKind =
  | "alias"
  | "function"
  | "builtin"
  | "keyword"
  | "abbreviation"
  | "variable";

export interface TerminalShellCompletionEntry {
  name: string;
  kind: TerminalShellCompletionKind;
}

export type TerminalShellEnvironmentKey = "PATH" | "PATHEXT" | "CDPATH";
export type TerminalShellEnvironment = Partial<Record<TerminalShellEnvironmentKey, string>>;

export type TerminalShellCapabilityKey = "autocd";
export type TerminalShellCapabilities = Partial<Record<TerminalShellCapabilityKey, boolean>>;

export type TerminalFindField = "command" | "output" | "note" | "cwd";
export type TerminalFindOrder = "newest-first" | "oldest-first";
export type TerminalFindStatus = "scanning" | "complete" | "cancelled" | "error";

export interface TerminalFindMatch {
  id: string;
  blockId: string;
  blockSequence: number;
  field: TerminalFindField;
  start: number;
  end: number;
  line: number;
  column: number;
  excerpt: string;
  sensitive: boolean;
}

export interface TerminalFindSnapshot {
  id: string;
  sessionId: string;
  clientId?: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  fields: TerminalFindField[];
  order: TerminalFindOrder;
  status: TerminalFindStatus;
  version: number;
  totalBlocks: number;
  scannedBlocks: number;
  totalMatches: number;
  returnedMatches: number;
  hiddenOutputRangeCount: number;
  truncated: boolean;
  matches: TerminalFindMatch[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalWorkflowParameter {
  name: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  options?: string[];
  dynamicOptionsCommand?: string;
  sensitive?: boolean;
  shellQuote?: boolean;
}

export interface TerminalWorkflow {
  id: string;
  name: string;
  description: string;
  command: string;
  parameters: TerminalWorkflowParameter[];
  tags: string[];
  scope: "global" | "workspace";
  workspacePath?: string;
  shells?: Array<"zsh" | "bash" | "fish" | "powershell">;
  sourceUrl?: string;
  author?: string;
  authorUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export type TerminalPaneLayout =
  | { type: "pane"; sessionRef: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      sizes?: number[];
      children: TerminalPaneLayout[];
    };

export type TerminalPaneDirection = "left" | "right" | "up" | "down";

export type TerminalWorkspacePaneNode =
  | {
      id: string;
      type: "pane";
      sessionId: string;
    }
  | {
      id: string;
      type: "split";
      direction: "horizontal" | "vertical";
      sizes: number[];
      children: TerminalWorkspacePaneNode[];
    };

export interface TerminalWorkspaceTab {
  id: string;
  title?: string;
  root: TerminalWorkspacePaneNode;
  activeSessionId: string;
  zoomedSessionId?: string;
}

export interface TerminalWorkspaceSnapshot {
  version: 1;
  revision: number;
  tabs: TerminalWorkspaceTab[];
  activeTabId?: string;
  detachedSessionIds: string[];
  closedPaneCount: number;
  updatedAt: number;
}

export interface TerminalLaunchSession {
  ref: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  customName?: string;
  customColor?: string;
  initialPrompt?: string;
  workflowId?: string;
  workflowValues?: Record<string, string>;
  position?: { x: number; y: number };
}

export interface TerminalLaunchConfiguration {
  id: string;
  version: 1;
  name: string;
  description: string;
  sessions: TerminalLaunchSession[];
  layout?: TerminalPaneLayout;
  activeSessionRef?: string;
  launchMode: "atomic" | "best-effort";
  createdAt: number;
  updatedAt: number;
}

export interface TerminalAutomationState {
  version: 1;
  workflows: TerminalWorkflow[];
  launchConfigurations: TerminalLaunchConfiguration[];
}

export type TerminalSuggestionKind =
  | "action"
  | "workflow"
  | "history"
  | "session"
  | "file"
  | "command"
  | "subcommand"
  | "option"
  | "argument"
  | "variable";

export interface TerminalSuggestion {
  id: string;
  kind: TerminalSuggestionKind;
  title: string;
  description: string;
  value: string;
  score: number;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface AgentProfileConfig {
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
}

export interface AgentProfileVersion {
  version: number;
  createdAt: number;
  config: AgentProfileConfig;
  changeNote?: string;
  promotedFromVersion?: number;
}

export interface AgentProfile {
  id: string;
  latestVersion: number;
  versions: AgentProfileVersion[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface AgentProfileReference {
  id: string;
  version?: number;
}

export interface AgentPermissionEvent {
  id: string;
  createdAt: number;
  toolName: string;
  decision: "deny" | "provider-flow";
  reason: string;
  profileId: string;
  profileVersion: number;
}

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

export interface Session {
  pty: IPty | null;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  originalCwd?: string;
  gitBranch?: string;
  worktreePath?: string;
  worktreePaths?: Record<string, string>;   // repo name → worktree path (multi-repo)
  worktreeMode?: 'current' | 'main';
  stashRefs?: Record<string, string>;       // repo name → stash ref
  /** Set when this session runs on a remote devbox rather than this machine. */
  devboxId?: string;
  remotePath?: string;
  createdAt: string;
  clients: Set<WebSocket>;
  /** True after a renderer has received this live PTY epoch's initial output. */
  terminalClientConnected?: boolean;
  outputBuffer: string[];
  outputBufferChars: number;
  outputBufferTruncated?: boolean;
  // Bumped on every scrollback mutation so the periodic save can skip sessions
  // that produced no output since the last write. Wraps harmlessly: the check
  // is inequality against the last persisted value, never ordering.
  outputBufferRev?: number;
  shellLaunch?: { shell: string; args: string[] };
  terminalCols: number;
  terminalRows: number;
  terminalFrameRedrawsInPlace: boolean;
  status: AgentStatus;
  /** When `status` last actually changed — drives "waiting a while" in the UI. */
  statusChangedAt?: number;
  /** Where the committed status came from; a guess gets less benefit of doubt. */
  statusSource?: AgentStatusSource;
  /** Handle for the per-session decay + inference tick. */
  statusTicker?: ReturnType<typeof setInterval>;
  /** A status change waiting out its debounce. See services/agentStatus.ts. */
  pendingStatus?: AgentStatus;
  pendingStatusSource?: AgentStatusSource;
  pendingStatusCommitAt?: number;
  pendingStatusTimer?: ReturnType<typeof setTimeout>;
  lastOutputTime: number;
  lastInputTime: number;
  recentOutputSize: number;
  customName?: string;
  customColor?: string;
  notes?: string;
  icon?: string;
  nodeId: string;
  isRestored?: boolean;
  position?: { x: number; y: number };
  // Linear ticket info
  ticketId?: string;
  ticketTitle?: string;
  ticketUrl?: string;
  launchCheckpoint?: CheckpointSummary;
  // Plugin-reported status
  pluginReportedStatus?: boolean;
  lastPluginStatusTime?: number;
  claudeSessionId?: string;
  /** Transcript path reported by the status hook, when the agent is Claude Code. */
  transcriptPath?: string;
  /** Codex rollout id, resolved on disk at move time. */
  codexSessionId?: string;
  /** An in-flight or last move to / from a node. */
  move?: MoveState;
  currentTool?: string;
  lastHookEvent?: string;
  // Permission detection: when the current tool call started, used with
  // terminal silence to tell a slow tool apart from a prompt awaiting an answer.
  preToolTime?: number;
  // State tracker PTY (for output parsing fallback)
  stateTrackerPty?: IPty | null;
  // Auto-naming from first query
  firstInputBuffer?: string;
  nameGenerated?: boolean;
  generatedTitle?: string;
  titlePromptHistory?: string[];
  // Soft delete
  pendingDelete?: boolean;
  deleteTimeout?: ReturnType<typeof setTimeout>;
  // Semantic terminal history. The runtime coordinator mutates this array in
  // place so persistence can save command blocks without serializing runtime
  // parser state.
  terminalBlocks: TerminalCommandBlock[];
  agentProfileId?: string;
  agentProfileVersion?: number;
  agentPermissionPolicy?: AgentProfileConfig["permissionPolicy"];
  agentAllowedTools?: string[];
  agentRuntimeManifestPath?: string;
  agentModel?: string;
  agentPermissionEvents?: AgentPermissionEvent[];
  agentFallbackCommands?: string[];
  agentFallbackIndex?: number;
  agentAttemptCommand?: string;
  agentAttemptBlockId?: string;
  agentAttemptStartedAt?: number;
}

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; color: string };
  priority: number;
  assignee?: { name: string };
  team?: { name: string; key: string };
}

export interface LinearConfig {
  apiKey?: string;
  defaultTeamId?: string;
  defaultBaseBranch?: string;
  createWorktree?: boolean;
  ticketPromptTemplate?: string;
  initialPrompt?: string;
  autoCareful?: boolean;
  /* Session launch defaults (Settings -> Sessions) */
  defaultStartingDirectory?: string;
  rememberLastDirectory?: boolean;
  defaultAgentId?: string;
  /* Remote devboxes (Settings -> Devboxes) */
  devboxes?: DevboxConfig[];
  /* Compute nodes (Settings -> Compute) */
  compute?: ComputeConfig;
}

export interface DevboxConfig {
  id: string;
  name: string;
  source: "manual" | "ssh-config" | "provisioned";
  /** True when `ssh <name>` resolves through the user's own ssh config. */
  inSshConfig: boolean;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** Remote working directory a session starts in. */
  defaultPath?: string;
  /** Present when Naught provisioned this box through a compute provider. */
  provision?: ProvisionRecord;
}

export type ProviderId = "modal" | "thunder";

export type ProvisionStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "terminating"
  | "terminated"
  | "error";

export type ProvisionRequester = { kind: "user" } | { kind: "session"; sessionId: string };

export type TerminateReason = "user" | "agent" | "max-lifetime" | "provider" | "bring-back" | "failed";

export interface ProvisionRecord {
  provider: ProviderId;
  /** Sandbox id (Modal) or instance uuid (Thunder). Empty until the provider answers. */
  instanceId: string;
  gpu?: string;
  gpuCount: number;
  cpu: number;
  memoryGb: number;
  diskGb?: number;
  image?: string;
  status: ProvisionStatus;
  requestedBy: ProvisionRequester;
  requestedAt: number;
  /** Billing start: the provider reported the node ready. */
  startedAt?: number;
  /** Bootstrap finished; sessions may launch. */
  readyAt?: number;
  terminatedAt?: number;
  terminateReason?: TerminateReason;
  /** Estimate; the UI always labels it "est.". */
  hourlyUsd: number;
  maxLifetimeHours: number;
  lastActivityAt: number;
  emails: {
    started?: number;
    reminderCount: number;
    lastReminderAt?: number;
    idleAlertAt?: number;
    idleAlertCount: number;
    terminated?: number;
  };
  /** Policy reasons while `status` is `pending`. */
  reasons?: string[];
  error?: string;
  /** Versions reported by bootstrap. */
  versions?: Record<string, string>;
}

export interface ComputePolicy {
  maxConcurrentNodes: number;
  allowedGpus: string[] | "any";
  maxLifetimeHours: number;
  maxHourlyUsd: number;
}

export interface ComputeNotifications {
  to?: string;
  from: string;
  reminderHours: number;
  idleAlertMinutes: number;
}

export interface ComputeConfig {
  policy: ComputePolicy;
  notifications: ComputeNotifications;
  nodeCredentials: { syncCodexAuth: boolean };
}

export type MoveDirection = "out" | "home";

export type MoveStep =
  | "waiting-idle"
  | "prepare"
  | "quiesce"
  | "sync-files"
  | "sync-agent"
  | "relaunch"
  | "verify"
  | "done"
  | "error";

export type MoveHarness =
  | { kind: "claude"; sessionId: string; transcriptPath?: string }
  | { kind: "codex"; sessionId: string; rolloutPath: string }
  | { kind: "shell" };

export interface ManifestSummary {
  hash: string;
  files: number;
  bytes: number;
  roots: string[];
}

export interface MoveHistoryEntry {
  direction: MoveDirection;
  nodeId: string;
  at: number;
  manifestHash: string;
}

export interface MoveState {
  direction: MoveDirection;
  state: MoveStep;
  nodeId: string;
  startedAt: number;
  updatedAt: number;
  harness: MoveHarness;
  /** Local absolute paths copied: the session cwd, plus a linked worktree's mother `.git`. */
  roots: string[];
  manifest?: ManifestSummary;
  includeIgnored: boolean;
  /** The step that failed, for retry. */
  failedStep?: MoveStep;
  error?: string;
  /** Bring-back options chosen in the sheet. */
  conflict?: "overwrite" | "worktree";
  terminateNode?: boolean;
  history: MoveHistoryEntry[];
}

export interface PersistedNode {
  nodeId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  shellLaunch?: { shell: string; args: string[] };
  terminalCols?: number;
  terminalRows?: number;
  terminalFrameRedrawsInPlace?: boolean;
  originalCwd?: string;
  devboxId?: string;
  remotePath?: string;
  move?: MoveState;
  createdAt: string;
  customName?: string;
  generatedTitle?: string;
  titlePromptHistory?: string[];
  customColor?: string;
  notes?: string;
  icon?: string;
  position: { x: number; y: number };
  worktreePaths?: Record<string, string>;
  launchCheckpoint?: CheckpointSummary;
  agentProfileId?: string;
  agentProfileVersion?: number;
  agentPermissionPolicy?: AgentProfileConfig["permissionPolicy"];
  agentAllowedTools?: string[];
  agentRuntimeManifestPath?: string;
  agentModel?: string;
  agentPermissionEvents?: AgentPermissionEvent[];
}

export interface PersistedCategory {
  id: string;
  label: string;
  color: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface PersistedState {
  version?: 2;
  savedAt?: number;
  nodes: PersistedNode[];
  categories?: PersistedCategory[];
}

export interface Agent {
  id: string;
  name: string;
  command: string;
  description: string;
  color: string;
  icon: string;
  profileId?: string;
  profileVersion?: number;
  profileConfig?: AgentProfileConfig;
}

export interface WebSocketData {
  sessionId: string;
}

export interface DetectedRepo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  defaultBranch: string;
}
