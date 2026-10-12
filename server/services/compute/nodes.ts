import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import type {
  ComputeConfig,
  DevboxConfig,
  ProviderId,
  ProvisionRecord,
  ProvisionRequester,
  Session,
  TerminateReason,
} from "../../types";
import { loadConfig, saveConfig } from "../linear";
import { getDevbox, listProvisionedDevboxes, upsertProvisionedDevbox } from "../devboxes";
import { resolveSecret } from "../secrets";
import { sessions as liveSessions } from "../sessionManager";
import { bootstrapNode, nodeHomeOf, type BootstrapResult, type NodePayload } from "./bootstrap";
import { ModalProvider } from "./modal";
import { sendNodeEmail, type NodeEmailKind, type SendResult } from "./notify";
import { DEFAULT_COMPUTE_CONFIG, evaluatePolicy, normaliseComputeConfig, type ComputeSpec } from "./policy";
import { ProviderError, type ComputeProvider } from "./provider";
import { ensureNaughtKeypair } from "./sshKeys";
import { ThunderProvider } from "./thunder";

/**
 * The node lifecycle: request → policy → (approval) → provision → wait →
 * bootstrap → ready, then a one-minute tick for reminders, idle alerts, the
 * lifetime cap and provider-side disappearance. State lives on the devbox
 * record in config.json, so it survives restarts and reconcile can pick an
 * in-flight node back up.
 */

export type ProvisionedDevbox = DevboxConfig & { provision: ProvisionRecord };

const QUIET = !!process.env.OPENUI_QUIET;
function log(message: string) {
  if (!QUIET) console.log(message);
}

export interface NodesDeps {
  providers: () => Partial<Record<ProviderId, ComputeProvider>>;
  now: () => number;
  mailer: (input: {
    kind: NodeEmailKind;
    n?: number;
    node: ProvisionedDevbox;
    attachedSessions: string[];
    now: number;
  }) => Promise<SendResult>;
  bootstrap: (devbox: DevboxConfig, payload: NodePayload) => Promise<BootstrapResult>;
  sessions: () => Map<string, Session>;
  keypair: () => Promise<{ privateKeyPath: string; publicKey: string }>;
  waitReadyTimeoutMs: number;
}

const defaultProviders = (() => {
  let cache: Partial<Record<ProviderId, ComputeProvider>> | null = null;
  return () => {
    if (!cache) cache = { modal: new ModalProvider(), thunder: new ThunderProvider() };
    return cache;
  };
})();

let deps: NodesDeps = {
  providers: defaultProviders,
  now: () => Date.now(),
  mailer: (input) => {
    const config = getComputeConfig();
    return sendNodeEmail({ ...input, config: config.notifications, apiKey: resolveSecret("RESEND_API_KEY")?.value });
  },
  bootstrap: (devbox, payload) => bootstrapNode(devbox, payload),
  sessions: () => liveSessions,
  keypair: () => ensureNaughtKeypair(),
  waitReadyTimeoutMs: 20 * 60_000,
};

/** Tests swap in fakes; production never calls this. */
export function configureNodes(partial: Partial<NodesDeps>): void {
  deps = { ...deps, ...partial };
}

export function providerRegistry(): Partial<Record<ProviderId, ComputeProvider>> {
  return deps.providers();
}

// ─── config ────────────────────────────────────────────────────────────────

let detectedRecipient: string | null | undefined;

function detectRecipient(): string | undefined {
  if (detectedRecipient !== undefined) return detectedRecipient ?? undefined;
  try {
    const email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf-8", timeout: 3_000 }).trim();
    detectedRecipient = email || null;
  } catch {
    detectedRecipient = null;
  }
  return detectedRecipient ?? undefined;
}

export function getComputeConfig(): ComputeConfig {
  const config = normaliseComputeConfig(loadConfig().compute);
  if (!config.notifications.to) config.notifications.to = detectRecipient();
  return config;
}

export function saveComputeConfig(input: unknown): ComputeConfig {
  const next = normaliseComputeConfig(input);
  const config = loadConfig();
  config.compute = next;
  saveConfig(config);
  return getComputeConfig();
}

export function nodeCredentials(): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) {
    const found = resolveSecret(key, { env: {} });
    if (found) credentials[key] = found.value;
  }
  return credentials;
}

// ─── listing ───────────────────────────────────────────────────────────────

const LIVE: ReadonlySet<ProvisionRecord["status"]> = new Set(["provisioning", "ready", "terminating"]);

export function listNodes(): ProvisionedDevbox[] {
  return listProvisionedDevboxes().sort((a, b) => b.provision.requestedAt - a.provision.requestedAt);
}

export function getNode(id: string): ProvisionedDevbox | null {
  const box = getDevbox(id);
  return box && box.source === "provisioned" && box.provision ? (box as ProvisionedDevbox) : null;
}

export function liveNodes(): ProvisionedDevbox[] {
  return listNodes().filter((node) => LIVE.has(node.provision.status));
}

export function pendingNodes(): ProvisionedDevbox[] {
  return listNodes().filter((node) => node.provision.status === "pending");
}

export function liveHourlyUsd(): number {
  return liveNodes().reduce((sum, node) => sum + (node.provision.status === "ready" || node.provision.status === "provisioning" ? node.provision.hourlyUsd : 0), 0);
}

export function attachedSessions(nodeId: string): Array<{ sessionId: string; name: string; lastActivityAt: number }> {
  const out: Array<{ sessionId: string; name: string; lastActivityAt: number }> = [];
  for (const [sessionId, session] of deps.sessions()) {
    if (session.devboxId !== nodeId || session.pendingDelete) continue;
    out.push({
      sessionId,
      name: session.customName || session.generatedTitle || session.agentName,
      lastActivityAt: Math.max(session.lastOutputTime || 0, session.lastInputTime || 0),
    });
  }
  return out;
}

// ─── change notification ───────────────────────────────────────────────────

type Listener = (nodes: ProvisionedDevbox[]) => void;
const listeners = new Set<Listener>();

export function onNodesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  const nodes = listNodes();
  for (const listener of listeners) {
    try { listener(nodes); } catch { /* a listener must not break the pipeline */ }
  }
}

function persist(node: ProvisionedDevbox): ProvisionedDevbox {
  const stored = upsertProvisionedDevbox(node) as ProvisionedDevbox;
  emit();
  return stored;
}

function patch(nodeId: string, provision: Partial<ProvisionRecord>, box: Partial<DevboxConfig> = {}): ProvisionedDevbox | null {
  const current = getNode(nodeId);
  if (!current) return null;
  return persist({ ...current, ...box, provision: { ...current.provision, ...provision } });
}

// ─── mail ──────────────────────────────────────────────────────────────────

async function mail(node: ProvisionedDevbox, kind: NodeEmailKind, n?: number): Promise<boolean> {
  try {
    const result = await deps.mailer({
      kind,
      n,
      node,
      attachedSessions: attachedSessions(node.id).map((item) => item.name),
      now: deps.now(),
    });
    if (!result.sent) log(`[compute] ${kind} email for ${node.name} skipped (${result.skipped})`);
    return result.sent;
  } catch (error: any) {
    log(`[compute] ${kind} email for ${node.name} failed: ${error?.message || error}`);
    return false;
  }
}

// ─── requests ──────────────────────────────────────────────────────────────

export interface NodeRequestInput {
  provider: ProviderId;
  gpu?: string;
  gpuCount?: number;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  name?: string;
  maxLifetimeHours?: number;
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

function providerFor(id: ProviderId): ComputeProvider {
  const provider = deps.providers()[id];
  if (!provider) throw new ProviderError(`Unknown compute provider: ${id}`);
  return provider;
}

export async function buildSpec(input: NodeRequestInput): Promise<{ spec: ComputeSpec; hourlyUsd: number }> {
  if (input.provider !== "modal" && input.provider !== "thunder") throw new ProviderError(`Unknown compute provider: ${String(input.provider)}`);
  const config = getComputeConfig();
  const gpu = typeof input.gpu === "string" && input.gpu.trim() ? input.gpu.trim() : undefined;
  const gpuCount = gpu ? Math.max(1, Math.floor(Number(input.gpuCount) || 1)) : 0;
  const cpu = Math.max(1, Math.floor(Number(input.cpu) || 4));
  const memoryGb = Math.max(1, Math.round(Number(input.memoryGb) || 16));
  const diskGb = input.diskGb !== undefined ? Math.max(10, Math.floor(Number(input.diskGb) || 100)) : undefined;
  const maxLifetimeHours = Number(input.maxLifetimeHours) > 0 ? Number(input.maxLifetimeHours) : config.policy.maxLifetimeHours;
  const label = gpu ? gpu.toLowerCase().replace(/[^a-z0-9]+/g, "") : "cpu";
  const name = (input.name || "").trim().slice(0, 64) || `${input.provider}-${label}-${shortId()}`;
  const spec: ComputeSpec = { provider: input.provider, gpu, gpuCount, cpu, memoryGb, diskGb, image: input.image?.trim() || undefined, name, maxLifetimeHours };
  const provider = providerFor(input.provider);
  if (input.provider === "thunder") {
    // Thunder's estimate needs its price list; a failure here means "unknown", not "stop".
    try { await provider.offers(); } catch { /* estimate falls back to 0 */ }
  }
  return { spec, hourlyUsd: provider.estimateHourlyUsd(spec) };
}

export async function requestNode(
  input: NodeRequestInput,
  requestedBy: ProvisionRequester,
): Promise<{ node: ProvisionedDevbox; pending: boolean; reasons: string[] }> {
  const { spec, hourlyUsd } = await buildSpec(input);
  const config = getComputeConfig();
  const verdict = evaluatePolicy(config.policy, { ...spec, hourlyUsd }, { liveNodes: liveNodes().length });
  const now = deps.now();
  const node: ProvisionedDevbox = {
    id: `node-${randomUUID()}`,
    name: spec.name,
    source: "provisioned",
    inSshConfig: false,
    provision: {
      provider: spec.provider,
      instanceId: "",
      gpu: spec.gpu,
      gpuCount: spec.gpuCount,
      cpu: spec.cpu,
      memoryGb: spec.memoryGb,
      diskGb: spec.diskGb,
      image: spec.image,
      status: verdict.allowed ? "provisioning" : "pending",
      requestedBy,
      requestedAt: now,
      hourlyUsd,
      maxLifetimeHours: spec.maxLifetimeHours,
      lastActivityAt: now,
      emails: { reminderCount: 0, idleAlertCount: 0 },
      reasons: verdict.allowed ? undefined : verdict.reasons,
    },
  };
  const stored = persist(node);
  if (verdict.allowed) void runProvision(stored.id);
  return { node: stored, pending: !verdict.allowed, reasons: verdict.reasons };
}

const inflight = new Map<string, Promise<void>>();

function specOf(node: ProvisionedDevbox): ComputeSpec {
  const p = node.provision;
  return {
    provider: p.provider,
    gpu: p.gpu,
    gpuCount: p.gpuCount,
    cpu: p.cpu,
    memoryGb: p.memoryGb,
    diskGb: p.diskGb,
    image: p.image,
    name: node.name,
    maxLifetimeHours: p.maxLifetimeHours,
  };
}

/** The pipeline after approval. Idempotent per node; safe to call on restart. */
export function runProvision(nodeId: string): Promise<void> {
  const existing = inflight.get(nodeId);
  if (existing) return existing;
  const promise = (async () => {
    let node = getNode(nodeId);
    if (!node) return;
    const provider = providerFor(node.provision.provider);
    try {
      if (node.provision.status !== "provisioning") {
        node = patch(nodeId, { status: "provisioning", reasons: undefined, error: undefined })!;
      }
      const { privateKeyPath, publicKey } = await deps.keypair();
      if (!node.provision.instanceId) {
        const { instanceId } = await provider.provision(specOf(node), publicKey);
        node = patch(nodeId, { instanceId })!;
        log(`[compute] ${node.name}: ${node.provision.provider} instance ${instanceId} requested`);
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), deps.waitReadyTimeoutMs);
      let endpoint;
      try {
        endpoint = await provider.waitReady(node.provision.instanceId, abort.signal);
      } finally {
        clearTimeout(timer);
      }
      const startedAt = node.provision.startedAt ?? deps.now();
      node = patch(
        nodeId,
        { startedAt, lastActivityAt: deps.now() },
        { host: endpoint.host, user: endpoint.user, port: endpoint.port, identityFile: privateKeyPath, defaultPath: nodeHomeOf({ ...node, user: endpoint.user }) },
      )!;
      if (!node.provision.emails.started) {
        if (await mail(node, "started")) node = patch(nodeId, { emails: { ...node.provision.emails, started: deps.now() } })!;
      }
      const result = await deps.bootstrap(node, {
        credentials: nodeCredentials(),
        installAgents: node.provision.provider === "thunder",
      });
      if (!result.ok) throw new Error(`bootstrap failed: ${result.error}`);
      node = patch(nodeId, { status: "ready", readyAt: deps.now(), versions: result.versions, error: undefined })!;
      log(`[compute] ${node.name} ready at ${node.user}@${node.host}:${node.port}`);
    } catch (error: any) {
      const message = error?.message || String(error);
      log(`[compute] ${nodeId} failed: ${message}`);
      const current = getNode(nodeId);
      if (!current) return;
      // A terminate that raced the pipeline already owns the record.
      if (current.provision.status === "terminating" || current.provision.status === "terminated") return;
      if (current.provision.instanceId) {
        try { await provider.terminate(current.provision.instanceId); } catch { /* best effort */ }
      }
      const failed = patch(nodeId, {
        status: current.provision.startedAt ? "terminated" : "error",
        error: message,
        terminatedAt: deps.now(),
        terminateReason: "failed",
      });
      if (failed && current.provision.startedAt) await mail(failed, "terminated");
      if (failed && !current.provision.startedAt) {
        // Never started billing: the record is an error card, not a dead node.
        patch(nodeId, { status: "error" });
      }
    }
  })().finally(() => inflight.delete(nodeId));
  inflight.set(nodeId, promise);
  return promise;
}

export async function approveNode(nodeId: string): Promise<ProvisionedDevbox | null> {
  const node = getNode(nodeId);
  if (!node) return null;
  if (node.provision.status !== "pending") return node;
  const updated = patch(nodeId, { status: "provisioning", reasons: undefined })!;
  void runProvision(nodeId);
  return updated;
}

export async function denyNode(nodeId: string): Promise<ProvisionedDevbox | null> {
  const node = getNode(nodeId);
  if (!node) return null;
  if (node.provision.status !== "pending") return node;
  return patch(nodeId, { status: "terminated", terminatedAt: deps.now(), terminateReason: "user" });
}

export async function terminateNode(nodeId: string, reason: TerminateReason): Promise<ProvisionedDevbox | null> {
  const node = getNode(nodeId);
  if (!node) return null;
  if (node.provision.status === "terminated") return node;
  if (node.provision.status === "pending" || node.provision.status === "error") {
    return patch(nodeId, { status: "terminated", terminatedAt: deps.now(), terminateReason: reason });
  }
  let current = patch(nodeId, { status: "terminating", terminateReason: reason })!;
  if (current.provision.instanceId) {
    try {
      await providerFor(current.provision.provider).terminate(current.provision.instanceId);
    } catch (error: any) {
      log(`[compute] terminate ${current.name} failed: ${error?.message || error}`);
      return patch(nodeId, { status: "ready", error: `terminate failed: ${error?.message || error}` });
    }
  }
  current = patch(nodeId, { status: "terminated", terminatedAt: deps.now(), error: undefined })!;
  if (current.provision.startedAt && !current.provision.emails.terminated) {
    if (await mail(current, "terminated")) patch(nodeId, { emails: { ...current.provision.emails, terminated: deps.now() } });
  }
  log(`[compute] ${current.name} terminated (${reason})`);
  return getNode(nodeId);
}

export function waitForNode(nodeId: string, timeoutMs: number): Promise<ProvisionedDevbox | null> {
  return new Promise((resolve) => {
    const settled = (node: ProvisionedDevbox | null) => !node || ["ready", "error", "terminated"].includes(node.provision.status);
    const first = getNode(nodeId);
    if (settled(first)) {
      resolve(first);
      return;
    }
    const finish = (node: ProvisionedDevbox | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(node);
    };
    const unsubscribe = onNodesChanged(() => {
      const node = getNode(nodeId);
      if (settled(node)) finish(node);
    });
    const timer = setTimeout(() => finish(getNode(nodeId)), timeoutMs);
  });
}

// ─── tick + reconcile ──────────────────────────────────────────────────────

export async function tick(): Promise<void> {
  const config = getComputeConfig();
  const now = deps.now();
  for (const node of listNodes()) {
    const p = node.provision;
    if (!LIVE.has(p.status)) continue;

    const activity = Math.max(p.lastActivityAt, ...attachedSessions(node.id).map((item) => item.lastActivityAt));
    let current = activity > p.lastActivityAt ? patch(node.id, { lastActivityAt: activity })! : node;

    if (p.status === "ready" && p.startedAt) {
      const elapsedMs = now - p.startedAt;
      if (elapsedMs >= p.maxLifetimeHours * 3_600_000) {
        await terminateNode(node.id, "max-lifetime");
        continue;
      }
      const due = Math.floor(elapsedMs / (config.notifications.reminderHours * 3_600_000));
      if (current.provision.emails.reminderCount < due) {
        const n = current.provision.emails.reminderCount + 1;
        if (await mail(current, "reminder", n)) {
          current = patch(node.id, { emails: { ...current.provision.emails, reminderCount: n, lastReminderAt: now } })!;
        }
      }
      const idleMs = now - current.provision.lastActivityAt;
      const idleWindow = config.notifications.idleAlertMinutes * 60_000;
      const lastIdle = current.provision.emails.idleAlertAt ?? 0;
      if (idleMs >= idleWindow && (lastIdle < current.provision.lastActivityAt || now - lastIdle >= idleWindow)) {
        const n = current.provision.emails.idleAlertCount + 1;
        if (await mail(current, "idle", n)) {
          current = patch(node.id, { emails: { ...current.provision.emails, idleAlertAt: now, idleAlertCount: n } })!;
        }
      }
      try {
        const status = await providerFor(p.provider).status(p.instanceId);
        if (status === "terminated" || status === "error") {
          const gone = patch(node.id, { status: "terminated", terminatedAt: now, terminateReason: "provider", error: status === "error" ? "provider reported an error" : undefined })!;
          if (!gone.provision.emails.terminated && (await mail(gone, "terminated"))) {
            patch(node.id, { emails: { ...gone.provision.emails, terminated: now } });
          }
        }
      } catch (error: any) {
        log(`[compute] status check for ${node.name} failed: ${error?.message || error}`);
      }
    }
  }
}

/** On startup: resume in-flight provisions, drop nodes the provider no longer has. */
export async function reconcileNodes(): Promise<void> {
  for (const node of listNodes()) {
    const p = node.provision;
    if (p.status === "provisioning") {
      if (!p.instanceId) {
        patch(node.id, { status: "error", error: "Naught restarted before the provider answered; request it again." });
      } else {
        void runProvision(node.id);
      }
      continue;
    }
    if (p.status === "ready" || p.status === "terminating") {
      try {
        const status = await providerFor(p.provider).status(p.instanceId);
        if (status === "terminated" || status === "error") {
          const gone = patch(node.id, { status: "terminated", terminatedAt: deps.now(), terminateReason: p.status === "terminating" ? p.terminateReason ?? "user" : "provider" })!;
          if (!gone.provision.emails.terminated && gone.provision.startedAt && (await mail(gone, "terminated"))) {
            patch(node.id, { emails: { ...gone.provision.emails, terminated: deps.now() } });
          }
        } else if (p.status === "terminating") {
          void terminateNode(node.id, p.terminateReason ?? "user");
        }
      } catch (error: any) {
        log(`[compute] reconcile ${node.name}: ${error?.message || error}`);
      }
    }
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;

export function startNodeTicker(intervalMs = 60_000): void {
  if (ticker) return;
  ticker = setInterval(() => {
    tick().catch((error) => log(`[compute] tick failed: ${error?.message || error}`));
  }, intervalMs);
  ticker.unref();
}

export function stopNodeTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

export { DEFAULT_COMPUTE_CONFIG };
