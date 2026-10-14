import { execFile } from "child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";
import type { DevboxConfig, MoveHarness, MoveState, MoveStep, Session } from "../types";
import { ensureNodeAssets } from "./compute/bootstrap";
import { getNode, nodeCredentials, requestNode, terminateNode, waitForNode, attachedSessions, getComputeConfig, type NodeRequestInput } from "./compute/nodes";
import { runOverSsh, shellQuote, type SshRunOptions, type SshRunResult } from "./compute/sshExec";
import { getDevbox } from "./devboxes";
import {
  buildLocalManifest,
  buildRemoteManifest,
  diffManifests,
  entriesDiffer,
  isMultiRepoSession,
  manifestRoots,
  manifestSummary,
  resolveMoveRoots,
  type Manifest,
  type MoveRoots,
} from "./move/manifest";
import {
  claudeProjectDirName,
  codexAuthPath,
  exitCommand,
  findClaudeState,
  findCodexState,
  harnessKindFor,
  relativeToHome,
  resumeCommand,
  type HarnessKind,
} from "./move/harness";
import { deleteLocal, deleteRemote, ensureRemoteDirectory, pullFiles, pushFiles, type TransferDeps } from "./move/transfer";
import { saveState } from "./persistence";
import { getTerminalSnapshot, relaunchSession, remoteLaunchState, sessions as liveSessions, writeTerminalData } from "./sessionManager";

/**
 * Moving a session to a node and back. A persisted step machine: every step
 * writes its state to the session before running, so a crash is resumable
 * and nothing local is ever touched by a move out.
 */

const QUIET = !!process.env.OPENUI_QUIET;
function log(message: string) {
  if (!QUIET) console.log(message);
}

export class MoveError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 = 400, readonly refusals: string[] = []) {
    super(message);
    this.name = "MoveError";
  }
}

export interface MoveDeps {
  sessions: () => Map<string, Session>;
  now: () => number;
  localHome: () => string;
  buildLocalManifest: typeof buildLocalManifest;
  buildRemoteManifest: (devbox: DevboxConfig, roots: MoveRoots, includeIgnored: boolean) => Promise<Manifest>;
  runRemote: (devbox: DevboxConfig, command: string, options?: SshRunOptions) => Promise<SshRunResult>;
  transfer: {
    push: (devbox: DevboxConfig, paths: string[], deps?: TransferDeps) => Promise<void>;
    pull: (devbox: DevboxConfig, paths: string[], deps?: TransferDeps) => Promise<void>;
    deleteRemote: (devbox: DevboxConfig, paths: string[], deps?: TransferDeps) => Promise<void>;
    deleteLocal: (paths: string[]) => void;
    ensureRemoteDirectory: (devbox: DevboxConfig, path: string, deps?: TransferDeps) => Promise<void>;
  };
  ensureNodeAssets: typeof ensureNodeAssets;
  relaunch: typeof relaunchSession;
  write: (sessionId: string, data: string) => void;
  terminalPhase: (sessionId: string) => string | undefined;
  remoteLaunch: (sessionId: string) => { state: "pending" | "remote" | "failed"; error?: string } | undefined;
  persist: () => void;
  terminateNode: (nodeId: string, reason: "bring-back") => Promise<unknown>;
  requestNode: typeof requestNode;
  waitForNode: typeof waitForNode;
  /** Polling cadence and the wait budgets, shrunk by tests. */
  timing: { pollMs: number; idleTimeoutMs: number; quiesceMs: number; verifyMs: number };
}

let deps: MoveDeps = {
  sessions: () => liveSessions,
  now: () => Date.now(),
  localHome: () => homedir(),
  buildLocalManifest,
  buildRemoteManifest: (devbox, roots, includeIgnored) => buildRemoteManifest(devbox, roots, includeIgnored),
  runRemote: (devbox, command, options) => runOverSsh(devbox, command, options),
  transfer: { push: pushFiles, pull: pullFiles, deleteRemote, deleteLocal, ensureRemoteDirectory },
  ensureNodeAssets,
  relaunch: relaunchSession,
  write: (sessionId, data) => { writeTerminalData(sessionId, data, { kind: "automation", bracketedPaste: true, submit: true }); },
  terminalPhase: (sessionId) => getTerminalSnapshot(sessionId, false)?.phase,
  remoteLaunch: (sessionId) => remoteLaunchState(sessionId),
  persist: () => saveState(liveSessions),
  terminateNode: (nodeId, reason) => terminateNode(nodeId, reason),
  requestNode,
  waitForNode,
  timing: { pollMs: 300, idleTimeoutMs: 6 * 3_600_000, quiesceMs: 10_000, verifyMs: 60_000 },
};

export function configureMoves(partial: Partial<MoveDeps>): void {
  deps = { ...deps, ...partial, timing: { ...deps.timing, ...(partial.timing ?? {}) }, transfer: { ...deps.transfer, ...(partial.transfer ?? {}) } };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function sessionOf(sessionId: string): Session {
  const session = deps.sessions().get(sessionId);
  if (!session) throw new MoveError("Session not found", 404);
  return session;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IDLE_STATUSES = new Set(["idle", "waiting_input", "disconnected", "error"]);

async function waitForIdle(session: Session): Promise<void> {
  const started = deps.now();
  while (session.pty && !IDLE_STATUSES.has(session.status)) {
    if (deps.now() - started > deps.timing.idleTimeoutMs) throw new Error("the agent never went idle");
    await sleep(deps.timing.pollMs);
  }
}

async function waitForPtyExit(session: Session, timeoutMs: number): Promise<boolean> {
  const started = deps.now();
  while (session.pty) {
    if (deps.now() - started > timeoutMs) return false;
    await sleep(deps.timing.pollMs);
  }
  return true;
}

async function quiesce(sessionId: string, session: Session, kind: HarnessKind): Promise<void> {
  if (!session.pty) return;
  deps.write(sessionId, exitCommand(kind));
  if (await waitForPtyExit(session, deps.timing.quiesceMs)) return;
  // The harness did not leave on request; the transcript is already flushed
  // at idle, so a hard stop loses nothing it has written.
  try { session.pty?.kill(); } catch { /* already gone */ }
  if (!(await waitForPtyExit(session, deps.timing.quiesceMs))) throw new Error("could not stop the local process");
}

function setMove(session: Session, patch: Partial<MoveState>): MoveState {
  session.move = { ...(session.move as MoveState), ...patch, updatedAt: deps.now() };
  deps.persist();
  return session.move;
}

function fail(session: Session, step: MoveStep, error: unknown): MoveState {
  const message = error instanceof Error ? error.message : String(error);
  log(`[move] ${session.nodeId}: ${step} failed: ${message}`);
  return setMove(session, { state: "error", failedStep: step, error: message });
}

async function remoteHome(devbox: DevboxConfig): Promise<string> {
  const result = await deps.runRemote(devbox, 'printf "%s" "$HOME"', { timeoutMs: 30_000 });
  const home = result.stdout.trim();
  if (result.code !== 0 || !home.startsWith("/")) throw new Error(`could not read the node's home directory${result.stderr ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`);
  return home;
}

// ─── planning ──────────────────────────────────────────────────────────────

export interface MovePlan {
  ok: boolean;
  refusals: string[];
  warnings: string[];
  direction: "out" | "home";
  destination?: { id: string; name: string };
  harness: MoveHarness & { found: boolean; description: string };
  roots: string[];
  gitDir?: string;
  manifest?: { hash: string; files: number; bytes: number; roots: string[] };
  includeIgnoredExtraBytes?: number;
  credential?: string;
  agentState: "idle" | "working" | "stopped";
  /** Bring-back only: local files that changed since the move. */
  conflicts?: string[];
}

function resolveHarness(session: Session): { harness: MoveHarness; found: boolean; description: string; warning?: string } {
  const kind = harnessKindFor(session.agentId, session.command);
  if (kind === "claude") {
    if (!session.claudeSessionId) {
      return { harness: { kind: "shell" }, found: false, description: "Claude Code: no session id reported yet, the agent will start fresh on the node", warning: "No Claude session id has been reported by the status hooks; the conversation cannot be carried." };
    }
    const state = findClaudeState({ home: deps.localHome(), sessionId: session.claudeSessionId, cwd: session.cwd, transcriptPath: session.transcriptPath });
    if (!state) {
      return { harness: { kind: "shell" }, found: false, description: `Claude Code session ${session.claudeSessionId.slice(0, 8)}: transcript not found on disk`, warning: "The transcript file for this session was not found; the agent will start fresh." };
    }
    return {
      harness: { kind: "claude", sessionId: state.sessionId, transcriptPath: state.transcript },
      found: true,
      description: `Claude Code session ${state.sessionId.slice(0, 8)}… found`,
      warning: state.longPath ? "The working directory path is longer than 200 characters; Claude's project directory name is shortened and resume may not find it." : undefined,
    };
  }
  if (kind === "codex") {
    const state = findCodexState({ home: deps.localHome(), cwd: session.cwd, since: Date.parse(session.createdAt) || 0, sessionId: session.codexSessionId });
    if (!state) return { harness: { kind: "shell" }, found: false, description: "Codex: no rollout found for this directory; the agent will start fresh", warning: "No Codex session file matched this directory and start time." };
    return { harness: { kind: "codex", sessionId: state.sessionId, rolloutPath: state.rolloutPath }, found: true, description: `Codex session ${state.sessionId.slice(0, 8)}… found` };
  }
  return { harness: { kind: "shell" }, found: true, description: "Shell: files only" };
}

function credentialFor(harness: MoveHarness): { key?: string; missing?: string } {
  const credentials = nodeCredentials();
  if (harness.kind === "claude") {
    return credentials.CLAUDE_CODE_OAUTH_TOKEN ? { key: "CLAUDE_CODE_OAUTH_TOKEN" } : { missing: "Claude needs CLAUDE_CODE_OAUTH_TOKEN in Settings → Compute → Node credentials (run `claude setup-token`)." };
  }
  if (harness.kind === "codex") {
    if (credentials.OPENAI_API_KEY) return { key: "OPENAI_API_KEY" };
    if (getComputeConfig().nodeCredentials.syncCodexAuth && existsSync(codexAuthPath(deps.localHome()))) return { key: "~/.codex/auth.json" };
    return { missing: "Codex needs OPENAI_API_KEY, or the opt-in to sync ~/.codex/auth.json, in Settings → Compute → Node credentials." };
  }
  return {};
}

function agentStateOf(session: Session): MovePlan["agentState"] {
  if (!session.pty) return "stopped";
  return IDLE_STATUSES.has(session.status) ? "idle" : "working";
}

export async function planMoveOut(sessionId: string, options: { nodeId?: string; includeIgnored?: boolean; manifest?: boolean } = {}): Promise<MovePlan> {
  const session = sessionOf(sessionId);
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (session.devboxId) refusals.push("This session already runs on a node; bring it back first.");
  if (session.move && !["done", "error"].includes(session.move.state)) refusals.push(`A move is already ${session.move.state}.`);
  if (isMultiRepoSession(session.worktreePaths)) refusals.push("Multi-repo worktree sessions cannot be moved yet.");
  const roots = resolveMoveRoots(session.cwd);
  if (!existsSync(roots.roots[0])) refusals.push(`The working directory ${roots.roots[0]} does not exist.`);
  const resolved = resolveHarness(session);
  if (resolved.warning) warnings.push(resolved.warning);
  const credential = credentialFor(resolved.harness);
  if (credential.missing) refusals.push(credential.missing);
  let destination: MovePlan["destination"];
  if (options.nodeId) {
    const devbox = getDevbox(options.nodeId);
    if (!devbox) refusals.push("Destination node not found.");
    else {
      const node = getNode(options.nodeId);
      if (node && node.provision.status !== "ready") refusals.push(`Node ${node.name} is ${node.provision.status}, not ready.`);
      destination = { id: devbox.id, name: devbox.name };
    }
  }
  let manifest: MovePlan["manifest"];
  let includeIgnoredExtraBytes: number | undefined;
  if (options.manifest !== false && existsSync(roots.roots[0])) {
    try {
      const base = await deps.buildLocalManifest(roots, !!options.includeIgnored);
      manifest = manifestSummary(base);
      if (!options.includeIgnored) {
        const full = await deps.buildLocalManifest(roots, true);
        includeIgnoredExtraBytes = Math.max(0, full.bytes - base.bytes);
      }
    } catch (error: any) {
      refusals.push(`Could not inventory the working directory: ${error?.message || error}`);
    }
  }
  return {
    ok: refusals.length === 0,
    refusals,
    warnings,
    direction: "out",
    destination,
    harness: { ...resolved.harness, found: resolved.found, description: resolved.description },
    roots: roots.roots,
    gitDir: roots.gitDir?.path,
    manifest,
    includeIgnoredExtraBytes,
    credential: credential.key,
    agentState: agentStateOf(session),
  };
}

export async function planBringHome(sessionId: string): Promise<MovePlan> {
  const session = sessionOf(sessionId);
  const refusals: string[] = [];
  const warnings: string[] = [];
  const move = session.move;
  if (!session.devboxId) refusals.push("This session runs locally.");
  // Valid when the last completed leg went out; a bring-back in progress (or
  // one that failed and is being retried) still counts.
  const wentOut = !!move && (
    (move.direction === "out" && move.state === "done") ||
    (move.direction === "home" && move.history.some((entry) => entry.direction === "out") && move.history.at(-1)?.direction === "out")
  );
  if (!wentOut) refusals.push("No completed move to reverse for this session.");
  if (move && !["done", "error"].includes(move.state)) refusals.push(`A move is already ${move.state}.`);
  const devbox = session.devboxId ? getDevbox(session.devboxId) : null;
  if (session.devboxId && !devbox) refusals.push("The node this session runs on is no longer registered.");
  const node = session.devboxId ? getNode(session.devboxId) : null;
  if (node && node.provision.status !== "ready") refusals.push(`Node ${node.name} is ${node.provision.status}.`);
  let conflicts: string[] = [];
  let manifest: MovePlan["manifest"];
  if (move?.manifest && existsSync(move.roots[0] || "")) {
    try {
      const roots = resolveMoveRoots(move.roots[0]);
      const local = await deps.buildLocalManifest(roots, move.includeIgnored);
      manifest = manifestSummary(local);
      if (local.hash !== move.manifest.hash) {
        // Reconstruct the move-time tree is impossible; report every file that
        // differs from what the node started with, best effort via the node.
        conflicts = ["(local tree changed since the move)"];
        if (devbox) {
          try {
            const remote = await deps.buildRemoteManifest(devbox, roots, move.includeIgnored);
            conflicts = entriesDiffer(local, remote);
          } catch { /* keep the generic marker */ }
        }
      }
    } catch (error: any) {
      warnings.push(`Could not inventory the local directory: ${error?.message || error}`);
    }
  }
  const resolved: MoveHarness = move?.harness ?? { kind: "shell" };
  return {
    ok: refusals.length === 0,
    refusals,
    warnings,
    direction: "home",
    destination: devbox ? { id: devbox.id, name: devbox.name } : undefined,
    harness: { ...resolved, found: resolved.kind !== "shell", description: resolved.kind === "shell" ? "Shell: files only" : `${resolved.kind === "claude" ? "Claude Code" : "Codex"} session ${resolved.sessionId.slice(0, 8)}… resumes locally` },
    roots: move?.roots ?? [],
    manifest,
    agentState: agentStateOf(session),
    conflicts,
  };
}

// ─── the pipeline ──────────────────────────────────────────────────────────

const OUT_ORDER: MoveStep[] = ["waiting-idle", "prepare", "quiesce", "sync-files", "sync-agent", "relaunch", "verify", "done"];
const HOME_ORDER: MoveStep[] = ["waiting-idle", "prepare", "quiesce", "sync-files", "sync-agent", "relaunch", "verify", "done"];

interface MoveContext {
  sessionId: string;
  session: Session;
  devbox: DevboxConfig;
  remoteHome?: string;
  roots: MoveRoots;
  localManifest?: Manifest;
  /** Bring-back into a fresh worktree: where files land locally instead of the original path. */
  worktreeTarget?: string;
}

const inflight = new Map<string, Promise<void>>();

function stepsFrom(order: MoveStep[], start: MoveStep): MoveStep[] {
  const index = order.indexOf(start);
  return index === -1 ? order : order.slice(index);
}

async function runPipeline(sessionId: string, start: MoveStep): Promise<void> {
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const promise = (async () => {
    const session = sessionOf(sessionId);
    const move = session.move;
    if (!move) return;
    const devbox = getDevbox(move.nodeId);
    if (!devbox) {
      fail(session, start, new Error("the node is no longer registered"));
      return;
    }
    const ctx: MoveContext = { sessionId, session, devbox, roots: resolveMoveRoots(move.roots[0] || session.cwd) };
    const order = move.direction === "out" ? OUT_ORDER : HOME_ORDER;
    for (const step of stepsFrom(order, start)) {
      if (step === "done") {
        setMove(session, {
          state: "done",
          failedStep: undefined,
          error: undefined,
          history: [...move.history, { direction: move.direction, nodeId: move.nodeId, at: deps.now(), manifestHash: session.move?.manifest?.hash ?? "" }],
        });
        log(`[move] ${sessionId}: ${move.direction === "out" ? "moved to" : "brought back from"} ${devbox.name}`);
        return;
      }
      setMove(session, { state: step, failedStep: undefined, error: undefined });
      try {
        if (move.direction === "out") await outStep(step, ctx);
        else await homeStep(step, ctx);
      } catch (error) {
        fail(session, step, error);
        return;
      }
    }
  })().finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, promise);
  return promise;
}

async function outStep(step: MoveStep, ctx: MoveContext): Promise<void> {
  const { session, sessionId, devbox } = ctx;
  const move = session.move!;
  switch (step) {
    case "waiting-idle": {
      // A plain shell has no turns to finish, and its inferred status rarely
      // settles to idle over ssh; waiting would park the move indefinitely.
      if (move.harness.kind !== "shell") await waitForIdle(session);
      return;
    }
    case "prepare": {
      const plan = await planMoveOut(sessionId, { nodeId: devbox.id, includeIgnored: move.includeIgnored, manifest: false });
      const refusals = plan.refusals.filter((r) => !r.startsWith("A move is already"));
      if (refusals.length) throw new MoveError(refusals.join(" "), 400, refusals);
      const assets = await deps.ensureNodeAssets(devbox, { credentials: nodeCredentials() });
      if (!assets.ok) throw new Error(`node preflight failed: ${assets.error}`);
      const tools = await deps.runRemote(devbox, 'for t in python3 tar; do command -v "$t" >/dev/null 2>&1 || { echo "missing $t" >&2; exit 1; }; done', { timeoutMs: 30_000 });
      if (tools.code !== 0) throw new Error(`node preflight failed: ${tools.stderr.trim() || "python3/tar missing"}`);
      ctx.remoteHome = await remoteHome(devbox);
      ctx.localManifest = await deps.buildLocalManifest(ctx.roots, move.includeIgnored);
      const harness: MoveHarness = plan.harness.kind === "claude"
        ? { kind: "claude", sessionId: plan.harness.sessionId, transcriptPath: plan.harness.transcriptPath }
        : plan.harness.kind === "codex"
          ? { kind: "codex", sessionId: plan.harness.sessionId, rolloutPath: plan.harness.rolloutPath }
          : { kind: "shell" };
      setMove(session, { harness, roots: manifestRoots(ctx.roots), manifest: manifestSummary(ctx.localManifest) });
      return;
    }
    case "quiesce": {
      await quiesce(sessionId, session, move.harness.kind);
      return;
    }
    case "sync-files": {
      const roots = ctx.roots;
      ctx.localManifest ??= await deps.buildLocalManifest(roots, move.includeIgnored);
      for (const root of manifestRoots(roots)) await deps.transfer.ensureRemoteDirectory(devbox, root);
      const remote = await deps.buildRemoteManifest(devbox, roots, move.includeIgnored);
      const diff = diffManifests(ctx.localManifest, remote);
      const allRoots = manifestRoots(roots);
      const changed = diff.changed.map(([index, rel]) => join(allRoots[index], rel));
      const deleted = diff.deleted.map(([index, rel]) => join(allRoots[index], rel));
      log(`[move] ${sessionId}: sending ${changed.length} files (${diff.bytes} bytes), deleting ${deleted.length}`);
      await deps.transfer.push(devbox, changed);
      await deps.transfer.deleteRemote(devbox, deleted);
      const verify = await deps.buildRemoteManifest(devbox, roots, move.includeIgnored);
      if (verify.hash !== ctx.localManifest.hash) {
        const differing = entriesDiffer(ctx.localManifest, verify).slice(0, 5);
        throw new Error(`the node's copy does not match after the transfer (${differing.join(", ") || "hash mismatch"})`);
      }
      return;
    }
    case "sync-agent": {
      ctx.remoteHome ??= await remoteHome(devbox);
      await syncAgentOut(ctx);
      return;
    }
    case "relaunch": {
      const command = resumeCommand(move.harness.kind, session.command, move.harness.kind === "shell" ? undefined : move.harness.sessionId);
      const result = await deps.relaunch(sessionId, { command, devboxId: devbox.id, remotePath: ctx.roots.roots[0] });
      if (!result.ok) throw new Error(result.error);
      return;
    }
    case "verify": {
      await verifyLaunch(ctx, move.harness);
      return;
    }
    default:
      return;
  }
}

async function syncAgentOut(ctx: MoveContext): Promise<void> {
  const { session, devbox } = ctx;
  const move = session.move!;
  const localHome = deps.localHome();
  const remoteHomeDir = ctx.remoteHome!;
  const files: string[] = [];
  if (move.harness.kind === "claude") {
    const state = findClaudeState({ home: localHome, sessionId: move.harness.sessionId, cwd: session.cwd, transcriptPath: move.harness.transcriptPath });
    if (!state) throw new Error("the Claude transcript disappeared before it could be copied");
    files.push(state.transcript, ...state.todos);
    if (state.subagentsDir) files.push(state.subagentsDir);
    // Claude looks the transcript up under the project directory for the cwd.
    // Resume finds it by id anywhere, but keeping the same name is cheapest.
    const expectedDir = join(remoteHomeDir, ".claude", "projects", claudeProjectDirName(session.cwd));
    await deps.runRemote(devbox, `mkdir -p ${shellQuote(expectedDir)} ${shellQuote(join(remoteHomeDir, ".claude", "todos"))}`, { timeoutMs: 30_000 });
  } else if (move.harness.kind === "codex") {
    files.push(move.harness.rolloutPath);
    if (getComputeConfig().nodeCredentials.syncCodexAuth && existsSync(codexAuthPath(localHome)) && !nodeCredentials().OPENAI_API_KEY) {
      files.push(codexAuthPath(localHome));
    }
  } else {
    return;
  }
  const outside = files.filter((file) => relativeToHome(file, localHome) === null);
  if (outside.length) throw new Error(`agent state outside the home directory cannot be re-rooted: ${outside[0]}`);
  await deps.transfer.push(devbox, files, { memberBase: localHome, localRoot: localHome, remoteRoot: remoteHomeDir });
  if (move.harness.kind === "codex" && files.some((f) => f.endsWith("auth.json"))) {
    await deps.runRemote(devbox, `chmod 600 ${shellQuote(join(remoteHomeDir, ".codex", "auth.json"))}`, { timeoutMs: 30_000 });
  }
}

async function verifyLaunch(ctx: MoveContext, harness: MoveHarness): Promise<void> {
  const { session, sessionId } = ctx;
  const started = deps.now();
  if (session.devboxId) {
    // First prove the shell is on the node at all: a failed ssh leaves the
    // card on a local prompt that would otherwise pass every check below.
    for (;;) {
      const remote = deps.remoteLaunch(sessionId);
      if (remote?.state === "remote") break;
      if (remote?.state === "failed") throw new Error(remote.error || "the session never reached the node");
      if (deps.now() - started > deps.timing.verifyMs) throw new Error("the remote shell did not come up in time");
      await sleep(deps.timing.pollMs);
    }
  }
  while (deps.now() - started < deps.timing.verifyMs) {
    if (!session.pty) throw new Error(`the relaunched process exited (${lastLines(session)})`);
    if (harness.kind === "claude" && session.claudeSessionId === harness.sessionId) return;
    const phase = deps.terminalPhase(sessionId);
    if (harness.kind !== "claude" && (phase === "at_prompt" || session.status === "idle" || session.status === "waiting_input")) return;
    if (harness.kind === "claude" && (session.status === "idle" || session.status === "waiting_input") && deps.now() - started > deps.timing.verifyMs / 3) return;
    await sleep(deps.timing.pollMs);
  }
  if (session.pty && session.status !== "disconnected" && session.status !== "error") {
    // Alive and producing output, but no confirmation: hooks may not be
    // flowing (no tunnel). Treat as launched, noted.
    log(`[move] ${sessionId}: launch not confirmed by hooks within the window; process is alive`);
    return;
  }
  throw new Error(`the agent did not come up within ${Math.round(deps.timing.verifyMs / 1000)} s (${lastLines(session)})`);
}

function lastLines(session: Session): string {
  const text = session.outputBuffer.slice(-5).join("");
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim().split("\n").slice(-3).join(" | ").slice(0, 300) || "no output";
}

// ─── bring back ────────────────────────────────────────────────────────────

async function homeStep(step: MoveStep, ctx: MoveContext): Promise<void> {
  const { session, sessionId, devbox } = ctx;
  const move = session.move!;
  switch (step) {
    case "waiting-idle": {
      // A plain shell has no turns to finish, and its inferred status rarely
      // settles to idle over ssh; waiting would park the move indefinitely.
      if (move.harness.kind !== "shell") await waitForIdle(session);
      return;
    }
    case "prepare": {
      const plan = await planBringHome(sessionId);
      const refusals = plan.refusals.filter((r) => !r.startsWith("A move is already"));
      if (refusals.length) throw new MoveError(refusals.join(" "), 400, refusals);
      if (plan.conflicts?.length && !move.conflict) throw new MoveError("Local files changed since the move; choose Overwrite or a fresh worktree.", 409, plan.conflicts);
      ctx.remoteHome = await remoteHome(devbox);
      if (move.conflict === "worktree") ctx.worktreeTarget = await createReturnWorktree(ctx.roots.roots[0], devbox.name);
      return;
    }
    case "quiesce": {
      await quiesce(sessionId, session, move.harness.kind);
      return;
    }
    case "sync-files": {
      const roots = ctx.roots;
      const remote = await deps.buildRemoteManifest(devbox, roots, move.includeIgnored);
      const allRoots = manifestRoots(roots);
      if (ctx.worktreeTarget) {
        // Stage the node's copy of the working tree, then lay it over the new
        // worktree without touching its own .git pointer or the mother .git.
        const staging = mkdtempSync(join(tmpdir(), "naught-return-"));
        try {
          const wanted = [...remote.roots[0].entries.values()].filter((e) => !e.err && e.rel !== ".git").map((e) => join(allRoots[0], e.rel));
          await deps.transfer.pull(devbox, wanted, { localRoot: staging });
          await copyTree(join(staging, allRoots[0].slice(1)), ctx.worktreeTarget);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
        return;
      }
      const local = await deps.buildLocalManifest(roots, move.includeIgnored);
      const diff = diffManifests(remote, local);
      const changed = diff.changed.map(([index, rel]) => join(allRoots[index], rel));
      const deleted = diff.deleted.map(([index, rel]) => join(allRoots[index], rel));
      log(`[move] ${sessionId}: fetching ${changed.length} files (${diff.bytes} bytes), deleting ${deleted.length} locally`);
      await deps.transfer.pull(devbox, changed);
      deps.transfer.deleteLocal(deleted);
      const verify = await deps.buildLocalManifest(roots, move.includeIgnored);
      if (verify.hash !== remote.hash) {
        const differing = entriesDiffer(remote, verify).slice(0, 5);
        throw new Error(`the local copy does not match after the transfer (${differing.join(", ") || "hash mismatch"})`);
      }
      setMove(session, { manifest: manifestSummary(verify) });
      return;
    }
    case "sync-agent": {
      ctx.remoteHome ??= await remoteHome(devbox);
      await syncAgentHome(ctx);
      return;
    }
    case "relaunch": {
      const cwd = ctx.worktreeTarget ?? ctx.roots.roots[0];
      const command = resumeCommand(move.harness.kind, session.command, move.harness.kind === "shell" ? undefined : move.harness.sessionId);
      const result = await deps.relaunch(sessionId, { command, devboxId: null, remotePath: null, cwd });
      if (!result.ok) throw new Error(result.error);
      return;
    }
    case "verify": {
      await verifyLaunch(ctx, move.harness);
      if (move.terminateNode && attachedSessions(devbox.id).every((item) => item.sessionId === sessionId)) {
        void deps.terminateNode(devbox.id, "bring-back");
      }
      return;
    }
    default:
      return;
  }
}

async function syncAgentHome(ctx: MoveContext): Promise<void> {
  const { session, devbox } = ctx;
  const move = session.move!;
  const localHome = deps.localHome();
  const remoteHomeDir = ctx.remoteHome!;
  const files: string[] = [];
  if (move.harness.kind === "claude") {
    const rel = relativeToHome(move.harness.transcriptPath || join(localHome, ".claude", "projects", claudeProjectDirName(session.cwd), `${move.harness.sessionId}.jsonl`), localHome);
    if (!rel) throw new Error("transcript path is outside the home directory");
    const remotePath = `${remoteHomeDir}/${rel}`;
    const localPath = join(localHome, rel);
    const size = await deps.runRemote(devbox, `stat -c %s ${shellQuote(remotePath)} 2>/dev/null || stat -f %z ${shellQuote(remotePath)}`, { timeoutMs: 30_000 });
    const remoteSize = Number(size.stdout.trim());
    const localSize = existsSync(localPath) ? statSync(localPath).size : 0;
    if (size.code !== 0 || !Number.isFinite(remoteSize)) throw new Error("the transcript was not found on the node");
    if (remoteSize < localSize) throw new Error(`the node's transcript (${remoteSize} bytes) is smaller than the local one (${localSize} bytes); refusing to truncate`);
    files.push(remotePath);
    const dir = dirname(remotePath);
    const subagents = `${dir}/${move.harness.sessionId}`;
    const listing = await deps.runRemote(devbox, `[ -d ${shellQuote(subagents)} ] && echo dir; ls -1 ${shellQuote(`${remoteHomeDir}/.claude/todos`)} 2>/dev/null | grep ${shellQuote(`^${move.harness.sessionId}`)} || true`, { timeoutMs: 30_000 });
    const lines = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines[0] === "dir") files.push(subagents);
    for (const name of lines.filter((l) => l !== "dir")) files.push(`${remoteHomeDir}/.claude/todos/${name}`);
  } else if (move.harness.kind === "codex") {
    const rel = relativeToHome(move.harness.rolloutPath, localHome);
    if (!rel) throw new Error("rollout path is outside the home directory");
    files.push(`${remoteHomeDir}/${rel}`);
  } else {
    return;
  }
  await deps.transfer.pull(devbox, files, { memberBase: remoteHomeDir, remoteRoot: remoteHomeDir, localRoot: localHome });
}

async function createReturnWorktree(original: string, nodeName: string): Promise<string> {
  const repoName = basename(original);
  const parent = dirname(original);
  const target = join(parent, `${repoName}-from-${nodeName.replace(/[^A-Za-z0-9_-]+/g, "-")}`);
  const branch = `${repoName}-from-${nodeName.replace(/[^A-Za-z0-9_-]+/g, "-")}-${Date.now().toString(36)}`;
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["worktree", "add", "-b", branch, target], { cwd: original }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`git worktree add failed: ${String(stderr || error.message).trim()}`));
      else resolve();
    });
  });
  return target;
}

async function copyTree(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await new Promise<void>((resolve, reject) => {
    execFile("sh", ["-c", `cp -a ${shellQuote(`${from}/.`)} ${shellQuote(to)}`], (error, _stdout, stderr) => {
      if (error) reject(new Error(`copy failed: ${String(stderr || error.message).trim()}`));
      else resolve();
    });
  });
}

// ─── public API ────────────────────────────────────────────────────────────

export interface StartMoveOptions {
  nodeId?: string;
  newNode?: NodeRequestInput;
  includeIgnored?: boolean;
  /** Wait for the agent to go idle before stopping it (default true). */
  whenIdle?: boolean;
}

export async function startMove(sessionId: string, options: StartMoveOptions): Promise<{ accepted: true; plan: MovePlan; nodeId: string }> {
  const session = sessionOf(sessionId);
  let nodeId = options.nodeId;
  if (!nodeId && options.newNode) {
    const result = await deps.requestNode(options.newNode, { kind: "session", sessionId });
    nodeId = result.node.id;
    if (result.pending) {
      // The node waits for approval; the move waits for the node.
      log(`[move] ${sessionId}: node ${result.node.name} awaits approval`);
    }
  }
  if (!nodeId) throw new MoveError("A destination node is required.", 400);
  const plan = await planMoveOut(sessionId, { nodeId, includeIgnored: options.includeIgnored, manifest: false });
  const refusals = plan.refusals.filter((r) => !/not ready/.test(r) || !options.newNode);
  if (refusals.length) throw new MoveError(refusals.join(" "), 400, refusals);
  const harness: MoveHarness = plan.harness.kind === "claude"
    ? { kind: "claude", sessionId: plan.harness.sessionId, transcriptPath: plan.harness.transcriptPath }
    : plan.harness.kind === "codex"
      ? { kind: "codex", sessionId: plan.harness.sessionId, rolloutPath: plan.harness.rolloutPath }
      : { kind: "shell" };
  session.move = {
    direction: "out",
    state: "waiting-idle",
    nodeId,
    startedAt: deps.now(),
    updatedAt: deps.now(),
    harness,
    roots: plan.roots,
    includeIgnored: !!options.includeIgnored,
    history: session.move?.history ?? [],
  };
  deps.persist();
  const whenIdle = options.whenIdle !== false;
  void (async () => {
    try {
      if (options.newNode) {
        const node = await deps.waitForNode(nodeId!, 30 * 60_000);
        if (!node || node.provision.status !== "ready") throw new Error(`node ${node?.name ?? nodeId} did not become ready (${node?.provision.error || node?.provision.status || "timeout"})`);
      }
    } catch (error) {
      fail(session, "prepare", error);
      return;
    }
    await runPipeline(sessionId, whenIdle ? "waiting-idle" : "prepare");
  })();
  return { accepted: true, plan, nodeId };
}

export async function bringHome(sessionId: string, options: { conflict?: "overwrite" | "worktree"; terminateNode?: boolean; whenIdle?: boolean } = {}): Promise<{ accepted: true; plan: MovePlan }> {
  const session = sessionOf(sessionId);
  const plan = await planBringHome(sessionId);
  if (!plan.ok) throw new MoveError(plan.refusals.join(" "), 400, plan.refusals);
  if (plan.conflicts?.length && !options.conflict) throw new MoveError("Local files changed since the move; choose Overwrite or a fresh worktree.", 409, plan.conflicts);
  const previous = session.move!;
  session.move = {
    ...previous,
    direction: "home",
    state: "waiting-idle",
    startedAt: deps.now(),
    updatedAt: deps.now(),
    failedStep: undefined,
    error: undefined,
    conflict: options.conflict,
    terminateNode: options.terminateNode !== false,
  };
  deps.persist();
  void runPipeline(sessionId, options.whenIdle !== false ? "waiting-idle" : "prepare");
  return { accepted: true, plan };
}

export async function retryMove(sessionId: string): Promise<MoveState> {
  const session = sessionOf(sessionId);
  const move = session.move;
  if (!move || move.state !== "error") throw new MoveError("Nothing to retry.", 400);
  const from = move.failedStep ?? "prepare";
  // A failed verify means the launch itself did not take; checking it again
  // would only fail again, so relaunch.
  void runPipeline(sessionId, from === "verify" ? "relaunch" : from);
  return session.move!;
}

/** From the error state: forget the attempt. A move out leaves the local tree as it was. */
export async function cancelMove(sessionId: string): Promise<MoveState | undefined> {
  const session = sessionOf(sessionId);
  const move = session.move;
  if (!move) return undefined;
  if (move.state !== "error") throw new MoveError("Only a failed move can be cancelled.", 400);
  const lastDone = move.history.at(-1);
  if (lastDone) {
    // Keep the record of where the session is; drop the failed attempt.
    session.move = { ...move, direction: lastDone.direction, state: "done", failedStep: undefined, error: undefined, updatedAt: deps.now() };
  } else {
    session.move = undefined;
  }
  deps.persist();
  return session.move;
}

export function moveStateOf(sessionId: string): MoveState | undefined {
  return sessionOf(sessionId).move;
}

/** After a restart: a move cut off mid-way either resumes safely or is parked as an error. */
export function resumeInFlightMoves(): void {
  for (const [sessionId, session] of deps.sessions()) {
    const move = session.move;
    if (!move || move.state === "done" || move.state === "error") continue;
    if (move.state === "relaunch" || move.state === "verify") {
      log(`[move] ${sessionId}: resuming ${move.direction} move at ${move.state}`);
      void runPipeline(sessionId, "relaunch");
      continue;
    }
    setMove(session, { state: "error", failedStep: move.state, error: "Naught restarted during the move; retry to continue." });
  }
}
