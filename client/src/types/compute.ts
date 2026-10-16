/** Client copies of the compute-node and session-move shapes served by /api/compute and /api/sessions/:id/move. */

export type ProviderId = "modal" | "thunder";

export type ProvisionStatus = "pending" | "provisioning" | "ready" | "terminating" | "terminated" | "error";

export interface ProvisionRecord {
  provider: ProviderId;
  instanceId: string;
  gpu?: string;
  gpuCount: number;
  cpu: number;
  memoryGb: number;
  diskGb?: number;
  image?: string;
  status: ProvisionStatus;
  requestedBy: { kind: "user" } | { kind: "session"; sessionId: string };
  requestedAt: number;
  startedAt?: number;
  readyAt?: number;
  terminatedAt?: number;
  terminateReason?: string;
  hourlyUsd: number;
  maxLifetimeHours: number;
  lastActivityAt: number;
  emails: { started?: number; reminderCount: number; lastReminderAt?: number; idleAlertAt?: number; idleAlertCount: number; terminated?: number };
  reasons?: string[];
  error?: string;
  versions?: Record<string, string>;
}

export interface Devbox {
  id: string;
  name: string;
  source: "manual" | "ssh-config" | "provisioned";
  inSshConfig: boolean;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  defaultPath?: string;
  provision?: ProvisionRecord;
}

export type ProvisionedNode = Devbox & { provision: ProvisionRecord };

export interface ComputeOffer {
  provider: ProviderId;
  gpu?: string;
  gpuCount: number;
  cpu: number;
  memoryGb: number;
  diskGb?: number;
  image?: string;
  hourlyUsd: number;
  available?: boolean;
  label: string;
}

export interface ProviderInfo {
  id: ProviderId;
  ok: boolean;
  source?: "naught" | "env" | "detected";
  detail?: string;
  storedInNaught: boolean;
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

export interface NodesSummary {
  nodes: ProvisionedNode[];
  live: number;
  pending: number;
  hourlyUsd: number;
}

export interface NodeRequest {
  provider: ProviderId;
  gpu?: string;
  gpuCount?: number;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  name?: string;
}

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

export interface MoveState {
  direction: "out" | "home";
  state: MoveStep;
  nodeId: string;
  startedAt: number;
  updatedAt: number;
  harness: { kind: "claude" | "codex" | "shell"; sessionId?: string };
  roots: string[];
  manifest?: { hash: string; files: number; bytes: number; roots: string[] };
  includeIgnored: boolean;
  failedStep?: MoveStep;
  error?: string;
  conflict?: "overwrite" | "worktree";
  terminateNode?: boolean;
  history: Array<{ direction: "out" | "home"; nodeId: string; at: number; manifestHash: string }>;
}

export interface MovePlan {
  ok: boolean;
  refusals: string[];
  warnings: string[];
  direction: "out" | "home";
  destination?: { id: string; name: string };
  harness: { kind: "claude" | "codex" | "shell"; sessionId?: string; found: boolean; description: string };
  roots: string[];
  gitDir?: string;
  manifest?: { hash: string; files: number; bytes: number; roots: string[] };
  includeIgnoredExtraBytes?: number;
  credential?: string;
  agentState: "idle" | "working" | "stopped";
  conflicts?: string[];
}

export const MOVE_STEP_LABELS: Record<MoveStep, string> = {
  "waiting-idle": "Waiting for the agent to go idle",
  prepare: "Preparing",
  quiesce: "Stopping the agent",
  "sync-files": "Copying files",
  "sync-agent": "Copying the conversation",
  relaunch: "Relaunching",
  verify: "Verifying",
  done: "Done",
  error: "Failed",
};

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatUptime(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function estimatedCost(provision: ProvisionRecord, now = Date.now()): number {
  if (!provision.startedAt) return 0;
  const end = provision.terminatedAt ?? now;
  return (Math.max(0, end - provision.startedAt) / 3_600_000) * provision.hourlyUsd;
}
