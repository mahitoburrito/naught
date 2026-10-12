import * as pty from "node-pty";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, basename, delimiter, isAbsolute, resolve } from "path";
import { homedir, tmpdir } from "os";
import { createHash, randomBytes } from "crypto";
import type {
  Session,
  DetectedRepo,
  TerminalCommandBlock,
  TerminalLifecycleSnapshot,
  TerminalShellCapabilities,
  TerminalShellCompletionEntry,
  TerminalShellEnvironment,
} from "../types";
import {
  deletePersistedSession,
  loadBuffer,
  loadState,
  loadTerminalBlocks,
  saveState,
  saveTerminalBlocks,
} from "./persistence";
import { generateSessionTitle } from "./titleGenerator";
import { reapProcessTreeDetached } from "./processTree";
import { TerminalLifecycle } from "./terminalLifecycle";
import { terminalFind, type TerminalFindBlockIndexEntry } from "./terminalFind";
import { sendTerminalMessage } from "./terminalTransport";
import {
  applyAgentStatus,
  disposeAgentStatus,
  MAX_RECENT_OUTPUT_BYTES,
  noteAgentOutputActivity,
  startAgentStatusTicker,
  stopAgentStatusTicker,
} from "./agentStatus";
import {
  decorateTerminalPtyWrite,
  TerminalPtyWriteCoordinator,
  type TerminalPtyWriteOptions,
} from "./terminalPtyWrites";
import {
  terminalCommandQueue,
  TerminalCommandQueueError,
  type TerminalCommandQueueSnapshot,
  type TerminalQueuedCommand,
} from "./terminalCommandQueue";
import { execGit } from "./gitRuntime";
import { terminalRemoteAssetVersion, terminalRemoteManager } from "./terminalRemote";
import { terminalWorkspace, TerminalWorkspaceError } from "./terminalWorkspace";

const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
const logError = QUIET ? (..._args: any[]) => {} : console.error.bind(console);

export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;

// A PTY spawned at 80x24 hard-wraps everything the shell prints before the client's
// first resize lands — startup banners, the first prompt, an agent's opening TUI
// frame — and that wrapping is baked into the scrollback for good. Remember the
// geometry clients report so later sessions start closer to the size they will be
// read at.
//
// High-water mark, not last-writer-wins, for two reasons. A client sends its
// pre-fit 80x24 the moment its socket opens, so tracking the latest report would
// reset the preference on every terminal that opens. And spawning too WIDE is
// cheap — the client's first resize narrows it and the emulator re-wraps — while
// spawning too narrow bakes hard line breaks into the buffer permanently.
//
// Process-global, and seeded at startup from persisted session geometry so the first
// session of a launch is not stuck at the default. It only grows and never decays, so
// a single session opened on a large external display keeps raising the floor for
// every later session, including across restarts. That is tolerable because spawning
// wide only costs a re-wrap once a client attaches, but it is why the ceiling here is
// a plausible-terminal size rather than the transport's much looser 1000-cell clamp:
// one outlier should not be able to set the default forever.
const MAX_REPORTED_PTY_DIMENSION = 300;
let preferredPtyCols = DEFAULT_PTY_COLS;
let preferredPtyRows = DEFAULT_PTY_ROWS;

export function notePreferredTerminalSize(cols: number, rows: number) {
  if (Number.isFinite(cols) && cols > preferredPtyCols && cols <= MAX_REPORTED_PTY_DIMENSION) {
    preferredPtyCols = Math.floor(cols);
  }
  if (Number.isFinite(rows) && rows > preferredPtyRows && rows <= MAX_REPORTED_PTY_DIMENSION) {
    preferredPtyRows = Math.floor(rows);
  }
}

export function preferredTerminalSize(): { cols: number; rows: number } {
  return { cols: preferredPtyCols, rows: preferredPtyRows };
}

// Test seam: the preference only ever grows, so a test that raises it would leak
// into every later session created in the same process.
export function resetPreferredTerminalSize() {
  preferredPtyCols = DEFAULT_PTY_COLS;
  preferredPtyRows = DEFAULT_PTY_ROWS;
}

const POSIX_FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/fish", "/bin/sh"] as const;

function executableFile(pathOrCommand: string, pathValue: string): string | null {
  if (!pathOrCommand) return null;
  if (!isAbsolute(pathOrCommand)) return executableOnPath(pathOrCommand, pathValue);
  try {
    accessSync(pathOrCommand, fsConstants.X_OK);
    const stat = lstatSync(pathOrCommand);
    return stat.isFile() || stat.isSymbolicLink() ? pathOrCommand : null;
  } catch {
    return null;
  }
}

function loginShellArgs(shell: string): string[] {
  return basename(shell).toLowerCase() === "sh" ? ["-l"] : ["--login"];
}

export function resolvePosixShellLaunch(
  preferredShell: string | undefined,
  pathValue: string,
  fallbackShells: readonly string[] = POSIX_FALLBACK_SHELLS,
): { shell: string; args: string[] } | null {
  const preferred = preferredShell ? executableFile(preferredShell, pathValue) : null;
  if (preferred) return { shell: preferred, args: loginShellArgs(preferred) };
  for (const candidate of fallbackShells) {
    const resolved = executableFile(candidate, pathValue);
    if (resolved) return { shell: resolved, args: loginShellArgs(resolved) };
  }
  return null;
}

export function getDefaultShellLaunch(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: "powershell.exe", args: ["-NoLogo"] };
  }
  const launch = resolvePosixShellLaunch(process.env.SHELL, process.env.PATH || "");
  if (!launch) {
    throw new Error(
      `No executable login shell was found (checked SHELL, ${POSIX_FALLBACK_SHELLS.join(", ")})`,
    );
  }
  return launch;
}

export function getPtyEnvironment(
  sessionId: string,
  profile?: {
    id?: string;
    version?: number;
    permissionPolicy?: string;
    allowedTools?: string[];
    manifestPath?: string;
    model?: string;
  },
): Record<string, string> {
  // NO_COLOR makes agent CLIs monochrome even though xterm supports full ANSI.
  const { NO_COLOR: _noColor, ...rest } = process.env;
  const shimEnvironment = prepareShellShimEnvironment(sessionId, rest as Record<string, string | undefined>);
  return {
    ...rest,
    ...shimEnvironment,
    TERM: "xterm-256color",
    TERM_PROGRAM: "OpenUI",
    TERM_PROGRAM_VERSION: process.env.npm_package_version || "dev",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    OPENUI_SESSION_ID: sessionId,
    OPENUI_PORT: String(serverPort),
    ...(profile?.id ? { OPENUI_AGENT_PROFILE_ID: profile.id } : {}),
    ...(profile?.version ? { OPENUI_AGENT_PROFILE_VERSION: String(profile.version) } : {}),
    ...(profile?.permissionPolicy ? { OPENUI_PERMISSION_POLICY: profile.permissionPolicy } : {}),
    ...(profile?.allowedTools?.length ? { OPENUI_ALLOWED_TOOLS: profile.allowedTools.join(",") } : {}),
    ...(profile?.manifestPath ? { OPENUI_AGENT_PROFILE_PATH: profile.manifestPath } : {}),
    ...(profile?.model ? { OPENUI_AGENT_MODEL: profile.model } : {}),
  } as Record<string, string>;
}

export function getSessionPtyEnvironment(sessionId: string, session: Session): Record<string, string> {
  return getPtyEnvironment(sessionId, {
    id: session.agentProfileId,
    version: session.agentProfileVersion,
    permissionPolicy: session.agentPermissionPolicy,
    allowedTools: session.agentAllowedTools,
    manifestPath: session.agentRuntimeManifestPath,
    model: session.agentModel,
  });
}

// Get the OpenUI plugin directory path
function getPluginDir(): string | null {
  const homePluginDir = join(homedir(), ".openui", "claude-code-plugin");
  const homePluginJson = join(homePluginDir, ".claude-plugin", "plugin.json");
  if (existsSync(homePluginJson)) {
    return homePluginDir;
  }

  // Packaged Electron app: extraResources copies plugin to process.resourcesPath
  try {
    const resourcesPlugin = join(process.resourcesPath, "claude-code-plugin");
    const resourcesPluginJson = join(resourcesPlugin, ".claude-plugin", "plugin.json");
    if (existsSync(resourcesPluginJson)) {
      return resourcesPlugin;
    }
  } catch {
    // process.resourcesPath may not exist outside Electron
  }

  // Dev mode / npm package: walk up from compiled output to find project root
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = join(dir, "..");
    const candidate = join(dir, "claude-code-plugin", ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) {
      return join(dir, "claude-code-plugin");
    }
  }

  return null;
}

// Inject --plugin-dir flag for Claude commands if plugin is available
export function injectPluginDir(command: string, agentId: string): string {
  const commandName = commandExecutableName(command);
  if (agentId !== "claude" && commandName !== "claude") return command;

  const pluginDir = getPluginDir();
  if (!pluginDir) return command;

  if (command.includes("--plugin-dir")) return command;

  const parts = command.trim().split(/\s+/);
  if (commandName === "claude") {
    parts.splice(1, 0, `--plugin-dir`, quotePosix(pluginDir));
    const finalCmd = parts.join(" ");
    log(`[plugin] Injecting plugin-dir: ${pluginDir}`);
    return finalCmd;
  }

  return command;
}

function commandExecutableName(command: string): string {
  const token = command.trim().split(/\s+/)[0] || "";
  const unquoted = (
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) ? token.slice(1, -1) : token;
  return basename(unquoted);
}

/**
 * Agent CLIs are often installed beside the Node binary that launched Electron
 * (for example through nvm). A login shell may replace PATH before the startup
 * command runs, so pin known agent executables while the parent PATH is intact.
 */
export function resolveAgentLaunchCommand(
  command: string,
  agentId: string,
  pathValue = process.env.PATH || "",
): string {
  const trimmed = command.trim();
  const token = trimmed.split(/\s+/)[0] || "";
  const expected = agentId === "claude" || agentId === "codex" ? agentId : "";
  if (!expected || token !== expected) return command;
  const executable = executableOnPath(expected, pathValue);
  if (!executable) return command;
  return `${quotePosix(executable)}${trimmed.slice(token.length)}`;
}

// Get git branch for a directory
async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Get git root directory
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Get the main worktree (mother repo) path
async function getMainWorktree(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(["worktree", "list", "--porcelain"], { cwd });
    const match = stdout.match(/^worktree (.+)$/m);
    if (match) {
      return match[1];
    }
  } catch {
    // Not a git repo
  }
  return null;
}

async function validGitBranchName(cwd: string, branchName: string): Promise<boolean> {
  if (!branchName || branchName.length > 255 || /[\0\r\n]/.test(branchName)) return false;
  try {
    await execGit(["check-ref-format", "--branch", branchName], { cwd });
    return true;
  } catch {
    return false;
  }
}

// Create a git worktree for a branch
export async function createWorktree(params: {
  cwd: string;
  branchName: string;
  baseBranch: string;
}): Promise<{ success: boolean; worktreePath?: string; error?: string }> {
  const { cwd, branchName, baseBranch } = params;
  const gitRoot = await getGitRoot(cwd);

  if (!gitRoot) {
    return { success: false, error: "Not a git repository" };
  }
  if (
    !(await validGitBranchName(gitRoot, branchName)) ||
    !(await validGitBranchName(gitRoot, baseBranch))
  ) {
    return { success: false, error: "Invalid Git branch name" };
  }

  const repoName = basename(gitRoot);
  const worktreesDir = join(gitRoot, "..", `${repoName}-worktrees`);

  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  const dirName = branchName.replace(/\//g, "-");
  const worktreePath = join(worktreesDir, dirName);

  if (existsSync(worktreePath)) {
    try {
      const { stdout } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
      const currentBranch = stdout.trim();
      if (currentBranch === branchName) {
        return { success: true, worktreePath };
      }
      return { success: false, error: `Worktree directory already exists at ${worktreePath} but is on branch '${currentBranch}', not '${branchName}'` };
    } catch {
      return { success: false, error: `Worktree directory exists at ${worktreePath} but is not a valid git worktree` };
    }
  }

  try {
    await execGit(["fetch", "origin"], { cwd: gitRoot });
  } catch {
    // Ignore fetch errors
  }

  try {
    // Try local branch first
    try {
      await execGit(["rev-parse", "--verify", `refs/heads/${branchName}`], { cwd: gitRoot });
      await execGit(["worktree", "add", worktreePath, branchName], { cwd: gitRoot });
    } catch {
      // Try remote branch
      try {
        await execGit(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], { cwd: gitRoot });
        await execGit(["worktree", "add", "--track", "-b", branchName, worktreePath, `origin/${branchName}`], { cwd: gitRoot });
      } catch {
        // Create new branch from base
        await execGit(["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`], { cwd: gitRoot });
      }
    }

    return { success: true, worktreePath };
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError("[PRBE_ERROR_EgPYEx] [worktree] Failed:", e.message);
    return { success: false, error: e.message };
  }
}

// Preserve working state by stashing uncommitted changes
async function preserveWorkingState(gitRoot: string): Promise<{ method: 'stash' | 'commit' | 'clean'; stashRef?: string }> {
  try {
    const { stdout } = await execGit(["status", "--porcelain"], { cwd: gitRoot });
    const statusOutput = stdout.trim();

    if (!statusOutput) {
      return { method: 'clean' };
    }

    const stashMsg = `openui-preserve-${Date.now()}`;
    try {
      await execGit(["stash", "push", "-m", stashMsg, "--include-untracked"], { cwd: gitRoot });
      log(`[worktree] Stashed changes in ${gitRoot}: ${stashMsg}`);
      return { method: 'stash', stashRef: stashMsg };
    } catch {
      try {
        await execGit(["add", "-A"], { cwd: gitRoot });
        await execGit(["commit", "-am", "openui: preserve WIP [skip ci]"], { cwd: gitRoot });
        log(`[worktree] Auto-committed changes in ${gitRoot}`);
        return { method: 'commit' };
      } catch {
        // Probe Agent Error Log Trigger
        logError(`[PRBE_ERROR_jT5sFi] [worktree] Failed to preserve state in ${gitRoot}`);
        return { method: 'clean' };
      }
    }
  } catch {
    return { method: 'clean' };
  }
}

// Scan a directory for child git repositories
export async function scanReposInDirectory(dirPath: string): Promise<DetectedRepo[]> {
  const repos: DetectedRepo[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryPath = join(dirPath, entry.name);
      const gitPath = join(entryPath, ".git");

      if (!existsSync(gitPath)) continue;

      const name = entry.name;
      const branch = (await getGitBranch(entryPath)) || "unknown";

      let dirty = false;
      try {
        const { stdout } = await execGit(["status", "--porcelain"], { cwd: entryPath });
        dirty = stdout.trim().length > 0;
      } catch {}

      let defaultBranch = "main";
      try {
        const { stdout } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: entryPath });
        defaultBranch = stdout.trim().replace("refs/remotes/origin/", "");
      } catch {}

      repos.push({ name, path: entryPath, branch, dirty, defaultBranch });
    }
  } catch (e) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_qf7a3F] [scan] Failed to scan ${dirPath}:`, e);
  }

  return repos;
}

// Create worktrees across multiple repos
export async function createMultiRepoWorktrees(params: {
  repos: { name: string; path: string; defaultBranch?: string }[];
  branchName: string;
  mode: 'current' | 'main';
  baseBranch: string;
}): Promise<{
  worktreePaths: Record<string, string>;
  stashRefs: Record<string, string>;
  errors: Record<string, string>;
}> {
  const { repos, branchName, mode, baseBranch } = params;
  const worktreePaths: Record<string, string> = {};
  const stashRefs: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const repo of repos) {
    const preserveResult = await preserveWorkingState(repo.path);
    if (preserveResult.stashRef) {
      stashRefs[repo.name] = preserveResult.stashRef;
    }

    let repoBaseBranch: string;
    if (mode === 'current') {
      repoBaseBranch = (await getGitBranch(repo.path)) || baseBranch;
    } else {
      repoBaseBranch = repo.defaultBranch || baseBranch;
    }

    const result = await createWorktree({
      cwd: repo.path,
      branchName,
      baseBranch: repoBaseBranch,
    });

    if (result.success && result.worktreePath) {
      worktreePaths[repo.name] = result.worktreePath;
      log(`[multi-worktree] Created worktree for ${repo.name}: ${result.worktreePath}`);
    } else {
      errors[repo.name] = result.error || "Unknown error";
      // Probe Agent Error Log Trigger
      logError(`[PRBE_ERROR_DaKFLF] [multi-worktree] Failed for ${repo.name}: ${result.error}`);
    }
  }

  return { worktreePaths, stashRefs, errors };
}

const MAX_BUFFER_CHUNKS = 5000;
const MAX_OUTPUT_BUFFER_CHARS = 2_000_000;
const TITLE_PROMPT_HISTORY_LIMIT = 8;
const TITLE_UPDATE_DEBOUNCE_MS = 1200;
const INITIAL_MULTILINE_READY_TIMEOUT_MS = 10_000;
const INITIAL_MULTILINE_READY_POLL_MS = 25;

export const sessions = new Map<string, Session>();
const terminalLifecycles = new Map<string, TerminalLifecycle>();
const terminalPtyWriters = new Map<string, { pty: pty.IPty; writer: TerminalPtyWriteCoordinator }>();
const titleGenerationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function replaceTerminalPtyWriter(sessionId: string, session: Session, ptyProcess: pty.IPty) {
  terminalPtyWriters.get(sessionId)?.writer.dispose();
  terminalPtyWriters.set(sessionId, {
    pty: ptyProcess,
    writer: new TerminalPtyWriteCoordinator(
      ptyProcess,
      () => sessions.get(sessionId) === session && session.pty === ptyProcess,
    ),
  });
}

function disposeTerminalPtyWriter(sessionId: string, ptyProcess?: pty.IPty) {
  const current = terminalPtyWriters.get(sessionId);
  if (!current || (ptyProcess && current.pty !== ptyProcess)) return;
  current.writer.dispose();
  terminalPtyWriters.delete(sessionId);
}

function activeCommandUsesProxyPty(sessionId: string, session: Session): boolean {
  const snapshot = terminalLifecycleFor(sessionId, session).snapshot(false);
  const active = snapshot.activeBlockId
    ? snapshot.blocks.find((block) => block.id === snapshot.activeBlockId)
    : undefined;
  return /^(?:sudo\s+)?(?:ssh|mosh|docker\s+exec|podman\s+exec|kubectl\s+exec)\b/i.test(
    active?.command.trim() || "",
  );
}

export function writeTerminalData(
  sessionId: string,
  data: string,
  options: TerminalPtyWriteOptions & {
    proxySafe?: boolean;
    bracketedPaste?: boolean;
    clearLine?: boolean;
    submit?: boolean;
  } = {},
): boolean {
  const session = sessions.get(sessionId);
  const current = terminalPtyWriters.get(sessionId);
  if (!session?.pty || !current || current.pty !== session.pty) return false;
  const {
    proxySafe,
    bracketedPaste,
    clearLine,
    submit,
    ...writeOptions
  } = options;
  const payload = decorateTerminalPtyWrite(data, {
    bracketedPaste: Boolean(
      bracketedPaste && terminalLifecycleFor(sessionId, session).isBracketedPasteEnabled()
    ),
    clearLine,
    submit,
  });
  const proxyDelay = proxySafe && Buffer.byteLength(payload, "utf8") > 4_096 &&
    activeCommandUsesProxyPty(sessionId, session)
    ? 50
    : undefined;
  const accepted = current.writer.enqueue(payload, {
    ...writeOptions,
    interChunkDelayMs: writeOptions.interChunkDelayMs ?? proxyDelay,
  });
  if (!accepted) logError(`[terminal-write] Rejected ${writeOptions.kind || "user"} write for ${sessionId}`);
  return accepted;
}

export function getTerminalWriteQueueState(sessionId: string): { bytes: number; writes: number } {
  const writer = terminalPtyWriters.get(sessionId)?.writer;
  return { bytes: writer?.pendingBytes || 0, writes: writer?.pendingWrites || 0 };
}

function appendOutputBuffer(session: Session, data: string) {
  if (!data) return;
  session.outputBufferRev = (session.outputBufferRev || 0) + 1;
  if (!Number.isFinite(session.outputBufferChars)) {
    session.outputBufferChars = session.outputBuffer.reduce((total, chunk) => total + chunk.length, 0);
  }
  session.outputBuffer.push(data);
  session.outputBufferChars += data.length;

  while (session.outputBuffer.length > MAX_BUFFER_CHUNKS) {
    const removed = session.outputBuffer.shift();
    if (removed) session.outputBufferChars -= removed.length;
    session.outputBufferTruncated = true;
  }
  while (session.outputBufferChars > MAX_OUTPUT_BUFFER_CHARS && session.outputBuffer.length > 0) {
    const overflow = session.outputBufferChars - MAX_OUTPUT_BUFFER_CHARS;
    const first = session.outputBuffer[0];
    if (first.length > overflow) {
      session.outputBuffer[0] = first.slice(overflow);
      session.outputBufferChars -= overflow;
    } else {
      session.outputBuffer.shift();
      session.outputBufferChars -= first.length;
    }
    session.outputBufferTruncated = true;
  }
}

function terminalLifecycleFor(sessionId: string, session: Session): TerminalLifecycle {
  let lifecycle = terminalLifecycles.get(sessionId);
  if (!lifecycle) {
    lifecycle = new TerminalLifecycle(
      sessionId,
      session.terminalBlocks,
      session.cwd,
    );
    terminalLifecycles.set(sessionId, lifecycle);
  }
  return lifecycle;
}

function terminalBlockSummary(snapshot: TerminalLifecycleSnapshot) {
  return {
    ...snapshot,
    blocks: snapshot.blocks.map(({ output: _output, ...block }) => block),
  };
}

function broadcastTerminalState(sessionId: string, session: Session) {
  const lifecycle = terminalLifecycleFor(sessionId, session);
  const message = {
    type: "terminalState",
    ...terminalBlockSummary(lifecycle.snapshot(false)),
  };
  for (const client of session.clients) sendTerminalMessage(client, message);
}

export function getTerminalSnapshot(
  sessionId: string,
  includeOutput = false,
): TerminalLifecycleSnapshot | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return terminalLifecycleFor(sessionId, session).snapshot(includeOutput);
}

export function getTerminalRootWorkingDirectory(sessionId: string): string | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return terminalLifecycleFor(sessionId, session).rootWorkingDirectory();
}

export type TerminalSplitWorkingDirectorySource =
  | "explicit"
  | "latest"
  | "local-root"
  | "stored"
  | "home";

export function resolveTerminalSplitWorkingDirectory(
  sessionId: string,
  requested?: unknown,
): { cwd: string; source: TerminalSplitWorkingDirectorySource } {
  const existingDirectory = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value)) return undefined;
    try {
      if (!lstatSync(value).isDirectory()) return undefined;
      return realpathSync(value);
    } catch {
      return undefined;
    }
  };
  if (requested !== undefined) {
    const cwd = existingDirectory(requested);
    if (!cwd) {
      throw new TerminalWorkspaceError("Split panes require an existing absolute cwd");
    }
    return { cwd, source: "explicit" };
  }
  const session = sessions.get(sessionId);
  if (!session || session.pendingDelete) {
    throw new TerminalWorkspaceError("Source session was not found", 404);
  }
  const snapshot = getTerminalSnapshot(sessionId, false);
  const remote = terminalRemoteManager.snapshot(sessionId);
  if (remote?.target && snapshot && snapshot.shellDepth > 0) {
    const localRoot = getTerminalRootWorkingDirectory(sessionId);
    const cwd = existingDirectory(localRoot);
    if (cwd) return { cwd, source: "local-root" };
  } else if (snapshot) {
    const cwd = existingDirectory(snapshot.currentCwd);
    if (cwd) return { cwd, source: "latest" };
  }
  const stored = existingDirectory(session.cwd);
  if (stored) return { cwd: stored, source: "stored" };
  return { cwd: homedir(), source: "home" };
}

export function getTerminalShellCompletions(sessionId: string): TerminalShellCompletionEntry[] | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return terminalLifecycleFor(sessionId, session).getShellCompletions();
}

export function getTerminalShellCapabilities(sessionId: string): TerminalShellCapabilities | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return terminalLifecycleFor(sessionId, session).getShellCapabilities();
}

export function getTerminalShellEnvironment(sessionId: string): TerminalShellEnvironment | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const environment = terminalLifecycleFor(sessionId, session).getShellEnvironment();
  const shimDirectory = shellShimDirectories.get(sessionId);
  if (environment.PATH === undefined || !shimDirectory) return environment;

  const identity = (value: string) => {
    const normalized = isAbsolute(value) ? resolve(value) : value;
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const shimIdentity = identity(shimDirectory);
  return {
    ...environment,
    PATH: environment.PATH
      .split(delimiter)
      .filter((entry) => identity(entry) !== shimIdentity)
      .join(delimiter),
  };
}

export function listTerminalFindBlocks(sessionId: string): TerminalFindBlockIndexEntry[] | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return terminalLifecycleFor(sessionId, session).snapshot(false).blocks.map((block) => ({
    id: block.id,
    sequence: block.sequence,
  }));
}

export function readTerminalFindBlock(sessionId: string, blockId: string): TerminalCommandBlock | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const lifecycle = terminalLifecycleFor(sessionId, session);
  const block = lifecycle.getBlock(blockId);
  if (!block) return null;
  return { ...block, output: lifecycle.sanitizeForSearch(block.output) };
}

export function resetTerminalLifecycle(sessionId: string, cwd: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  terminalCommandQueue.clear(sessionId);
  session.cwd = cwd;
  terminalLifecycleFor(sessionId, session).resetForRestart(cwd);
  terminalFind.refreshSession(sessionId);
}

function terminalCommandQueueSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session || session.pendingDelete) {
    throw new TerminalCommandQueueError("Session not found", 404);
  }
  if (!session.pty) {
    throw new TerminalCommandQueueError("Session is disconnected", 409);
  }
  return session;
}

function shouldDeferQueuedCommandForAgentFallback(
  session: Session,
  lifecycle: TerminalLifecycle,
): boolean {
  const fallbackCommands = session.agentFallbackCommands || [];
  const fallback = fallbackCommands[session.agentFallbackIndex || 0];
  if (!fallback || !session.agentAttemptBlockId || !session.agentAttemptStartedAt) return false;
  const attempt = lifecycle.getBlock(session.agentAttemptBlockId);
  return Boolean(
    attempt?.status === "failed" && session.lastInputTime <= session.agentAttemptStartedAt,
  );
}

function maybeDrainTerminalCommandQueue(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  lifecycle: TerminalLifecycle,
): boolean {
  if (
    session.pty !== ptyProcess ||
    !lifecycle.canAcceptCommand() ||
    terminalPtyWriters.get(sessionId)?.writer.pendingWrites ||
    shouldDeferQueuedCommandForAgentFallback(session, lifecycle)
  ) return false;

  const item = terminalCommandQueue.beginDispatch(sessionId);
  if (!item) return false;
  const accepted = startTrackedCommand(sessionId, session, ptyProcess, item.command, {
    kind: "queued-command",
    onStarted: (block) => {
      if (!terminalCommandQueue.markStarted(sessionId, item.id, block.id)) {
        throw new Error("Queued command dispatch lost its in-flight owner");
      }
    },
    onError: () => {
      // A write that started may already have reached the shell. Never replay it
      // automatically; the next prompt will conservatively recover its block.
      terminalCommandQueue.abandonDispatch(sessionId, item.id);
    },
  });
  if (!accepted) terminalCommandQueue.rollbackDispatch(sessionId, item.id);
  return accepted;
}

function reconcileTerminalCommandQueue(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  lifecycle: TerminalLifecycle,
) {
  const inFlight = terminalCommandQueue.snapshot(sessionId).inFlight;
  if (inFlight?.blockId) {
    const block = lifecycle.getBlock(inFlight.blockId);
    if (block && block.status !== "running") {
      terminalCommandQueue.completeBlock(sessionId, block.id);
    }
  }
  maybeDrainTerminalCommandQueue(sessionId, session, ptyProcess, lifecycle);
}

export function getTerminalCommandQueue(sessionId: string): TerminalCommandQueueSnapshot {
  terminalCommandQueueSession(sessionId);
  return terminalCommandQueue.snapshot(sessionId);
}

export function enqueueTerminalCommand(
  sessionId: string,
  command: unknown,
): {
  item: TerminalQueuedCommand;
  state: "queued" | "running";
  queue: TerminalCommandQueueSnapshot;
} {
  const session = terminalCommandQueueSession(sessionId);
  const item = terminalCommandQueue.enqueue(sessionId, command);
  maybeDrainTerminalCommandQueue(
    sessionId,
    session,
    session.pty!,
    terminalLifecycleFor(sessionId, session),
  );
  const queue = terminalCommandQueue.snapshot(sessionId);
  return {
    item,
    state: queue.inFlight?.id === item.id ? "running" : "queued",
    queue,
  };
}

export function editTerminalQueuedCommand(
  sessionId: string,
  commandId: string,
  command: unknown,
): TerminalCommandQueueSnapshot {
  terminalCommandQueueSession(sessionId);
  terminalCommandQueue.edit(sessionId, commandId, command);
  return terminalCommandQueue.snapshot(sessionId);
}

export function reorderTerminalQueuedCommand(
  sessionId: string,
  commandId: string,
  beforeId?: string | null,
): TerminalCommandQueueSnapshot {
  terminalCommandQueueSession(sessionId);
  terminalCommandQueue.reorder(sessionId, commandId, beforeId);
  return terminalCommandQueue.snapshot(sessionId);
}

export function removeTerminalQueuedCommand(
  sessionId: string,
  commandId: string,
): TerminalCommandQueueSnapshot {
  terminalCommandQueueSession(sessionId);
  terminalCommandQueue.remove(sessionId, commandId);
  return terminalCommandQueue.snapshot(sessionId);
}

export function clearPendingTerminalCommands(sessionId: string): TerminalCommandQueueSnapshot {
  terminalCommandQueueSession(sessionId);
  terminalCommandQueue.clearPending(sessionId);
  return terminalCommandQueue.snapshot(sessionId);
}

export function discardTerminalCommandQueue(sessionId: string): number {
  return terminalCommandQueue.clear(sessionId);
}

export function noteTerminalInput(sessionId: string, data: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const lifecycle = terminalLifecycleFor(sessionId, session);
  const block = lifecycle.noteInput(data);
  if (block) {
    terminalFind.invalidateBlock(sessionId, block.id);
    broadcastTerminalState(sessionId, session);
  }
}

export function writeTerminalBlockCommand(
  sessionId: string,
  blockId: string,
  mode: "insert" | "execute" | "queue",
): { ok: true } | { ok: false; error: string; status: number } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found", status: 404 };
  if (!session.pty) return { ok: false, error: "Session is disconnected", status: 409 };

  const lifecycle = terminalLifecycleFor(sessionId, session);
  const block = lifecycle.getBlock(blockId);
  if (!block) return { ok: false, error: "Terminal block not found", status: 404 };
  const replayCommand = lifecycle.commandForReplay(blockId);
  if (!replayCommand) {
    return {
      ok: false,
      error: "Sensitive command cannot be replayed after its secret was discarded",
      status: 409,
    };
  }
  if (mode === "queue") {
    if (block.sensitive) {
      return { ok: false, error: "Sensitive commands cannot be stored in the command queue", status: 409 };
    }
    try {
      enqueueTerminalCommand(sessionId, replayCommand);
      return { ok: true };
    } catch (error) {
      if (error instanceof TerminalCommandQueueError) {
        return { ok: false, error: error.message, status: error.status };
      }
      throw error;
    }
  }
  if (!lifecycle.canAcceptCommand()) {
    return { ok: false, error: "Terminal is busy; wait for the shell prompt", status: 409 };
  }

  if (mode === "execute") {
    if (!startTrackedCommand(sessionId, session, session.pty, replayCommand, {
      frameRedrawsInPlace: Boolean(block.frameRedrawsInPlace),
      kind: "replay",
    })) {
      return { ok: false, error: "Terminal input queue is full", status: 409 };
    }
  } else {
    if (!writeTerminalData(sessionId, replayCommand, {
      kind: "replay",
      proxySafe: true,
      bracketedPaste: true,
      beforeWrite: () => lifecycle.noteInput(replayCommand),
    })) {
      return { ok: false, error: "Terminal input queue is full", status: 409 };
    }
  }
  return { ok: true };
}

export function updateTerminalBlock(
  sessionId: string,
  blockId: string,
  updates: { bookmarked?: boolean; note?: string },
): { ok: true; block: ReturnType<TerminalLifecycle["getBlock"]> } | { ok: false; error: string; status: number } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found", status: 404 };
  const block = terminalLifecycleFor(sessionId, session).getBlock(blockId);
  if (!block) return { ok: false, error: "Terminal block not found", status: 404 };
  if (updates.bookmarked !== undefined) block.bookmarked = updates.bookmarked;
  if (updates.note !== undefined) {
    block.note = updates.note.trim().slice(0, 2000) || undefined;
    terminalFind.invalidateBlock(sessionId, block.id);
  }
  // Persist immediately rather than waiting for the periodic save. These are
  // user-authored annotations on a block that may be far from the tail, and a
  // crash between here and the next tick would lose them.
  saveTerminalBlocks(sessionId, session.terminalBlocks);
  broadcastTerminalState(sessionId, session);
  return { ok: true, block };
}

export function clearTerminalHistory(options: {
  sessionId?: string;
  before?: number;
  includeBookmarked?: boolean;
}): { removed: number; sessionsChanged: number; preservedRunning: number; preservedBookmarked: number } {
  const entries = options.sessionId
    ? (() => {
        const session = sessions.get(options.sessionId!);
        return session ? [[options.sessionId!, session] as const] : [];
      })()
    : [...sessions.entries()];
  let removed = 0;
  let sessionsChanged = 0;
  let preservedRunning = 0;
  let preservedBookmarked = 0;

  for (const [sessionId, session] of entries) {
    const lifecycle = terminalLifecycleFor(sessionId, session);
    const beforeBlocks = lifecycle.snapshot(false).blocks;
    preservedRunning += beforeBlocks.filter((block) => block.status === "running").length;
    if (!options.includeBookmarked) {
      preservedBookmarked += beforeBlocks.filter((block) => block.bookmarked).length;
    }
    const sessionRemoved = lifecycle.clearHistory(options);
    if (sessionRemoved === 0) continue;
    removed += sessionRemoved;
    sessionsChanged++;
    saveTerminalBlocks(sessionId, session.terminalBlocks);
    terminalFind.refreshSession(sessionId);
    broadcastTerminalState(sessionId, session);
  }

  return { removed, sessionsChanged, preservedRunning, preservedBookmarked };
}

function maybeStartAgentFallback(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  lifecycle: TerminalLifecycle,
) {
  const fallbackCommands = session.agentFallbackCommands || [];
  if (fallbackCommands.length === 0 || lifecycle.snapshot(false).phase !== "at_prompt") return;
  if (!session.agentAttemptBlockId || !session.agentAttemptStartedAt) return;
  const attempt = lifecycle.getBlock(session.agentAttemptBlockId);
  if (!attempt || attempt.status !== "failed") return;
  if (session.lastInputTime > session.agentAttemptStartedAt) return;

  const fallbackIndex = session.agentFallbackIndex || 0;
  const fallback = fallbackCommands[fallbackIndex];
  if (!fallback) return;
  session.agentFallbackIndex = fallbackIndex + 1;
  const previousCommand = session.agentAttemptCommand || attempt.command;
  const fallbackAgentId = fallback.trim().split(/\s+/)[0] === "claude" ? "claude" : session.agentId;
  const finalFallback = injectPluginDir(
    resolveAgentLaunchCommand(fallback, fallbackAgentId),
    fallbackAgentId,
  );

  for (const client of session.clients) {
    sendTerminalMessage(client, {
      type: "agentFallback",
      fromCommand: previousCommand,
      toCommand: finalFallback,
      attempt: session.agentFallbackIndex,
      exitCode: attempt.exitCode,
    });
  }

  setTimeout(() => {
    if (session.pty !== ptyProcess || !lifecycle.canAcceptCommand()) return;
    startTrackedCommand(sessionId, session, ptyProcess, finalFallback);
  }, 80);
}

export function attachSessionPty(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  label = "PTY",
) {
  const lifecycle = terminalLifecycleFor(sessionId, session);
  replaceTerminalPtyWriter(sessionId, session, ptyProcess);

  ptyProcess.onExit(({ exitCode, signal }) => {
    // A late exit from an old PTY must not disconnect a replacement process.
    if (session.pty !== ptyProcess) return;
    log(`[session] ${label} exited for ${sessionId} (code=${exitCode}, signal=${signal})`);
    stopAgentStatusTicker(session);
    session.preToolTime = undefined;
    applyAgentStatus(session, "disconnected", { source: "authoritative", immediate: true });
    session.pty = null;
    terminalCommandQueue.clear(sessionId);
    disposeTerminalPtyWriter(sessionId, ptyProcess);
    const changedBlockIds = lifecycle.terminate(exitCode, signal);
    cleanupShellShimEnvironment(sessionId);
    for (const blockId of changedBlockIds) terminalFind.invalidateBlock(sessionId, blockId);
    broadcastTerminalState(sessionId, session);

    for (const client of session.clients) sendTerminalMessage(client, { type: "exit", exitCode, signal });
  });

  ptyProcess.onData((rawData: string) => {
    if (session.pty !== ptyProcess) return;
    const result = lifecycle.feed(rawData);
    for (const payload of result.remoteControlPayloads) {
      terminalRemoteManager.handleControlPayload(sessionId, payload);
    }
    const data = result.data;
    for (const blockId of result.changedBlockIds) terminalFind.invalidateBlock(sessionId, blockId);

    if (data) {
      appendOutputBuffer(session, lifecycle.sanitizeForPersistence(result.persistenceData));
      session.lastOutputTime = Date.now();
      session.recentOutputSize = Math.min(
        MAX_RECENT_OUTPUT_BYTES,
        session.recentOutputSize + data.length,
      );

      noteAgentOutputActivity(session);

      for (const client of session.clients) sendTerminalMessage(client, { type: "output", data });
    }

    if (result.stateChanged) {
      const currentCwd = lifecycle.snapshot(false).currentCwd;
      if (currentCwd) session.cwd = currentCwd;
      broadcastTerminalState(sessionId, session);
      maybeStartAgentFallback(sessionId, session, ptyProcess, lifecycle);
      reconcileTerminalCommandQueue(sessionId, session, ptyProcess, lifecycle);
    }
  });
}

function getShellIntegrationPath(shell: string): string | null {
  const shellName = basename(shell).toLowerCase();
  const filename = shellName.includes("zsh")
    ? "openui.zsh"
    : shellName.includes("fish")
      ? "openui.fish"
      : shellName.includes("bash")
        ? "openui.bash"
        : shellName.includes("pwsh") || shellName.includes("powershell")
          ? "openui.ps1"
          : null;
  if (!filename) return null;

  const candidates: string[] = [];
  try {
    candidates.push(join(process.resourcesPath, "shell-integration", filename));
    candidates.push(join(process.resourcesPath, "resources", "shell-integration", filename));
  } catch {
    // process.resourcesPath is Electron-only.
  }
  candidates.push(join(process.cwd(), "resources", "shell-integration", filename));

  let dir = __dirname;
  for (let i = 0; i < 7; i++) {
    candidates.push(join(dir, "resources", "shell-integration", filename));
    dir = join(dir, "..");
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const shellShimDirectories = new Map<string, string>();
const sshControlDirectories = new Map<string, string>();

function getTerminalResourceRoot(): string | null {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(process.resourcesPath);
    candidates.push(join(process.resourcesPath, "resources"));
  }
  candidates.push(join(process.cwd(), "resources"));
  let directory = __dirname;
  for (let index = 0; index < 7; index++) {
    candidates.push(join(directory, "resources"));
    directory = join(directory, "..");
  }
  return candidates.find((candidate) =>
    existsSync(join(candidate, "remote-terminal", "openui_ssh_wrapper.cjs")) &&
    existsSync(join(candidate, "remote-terminal", "openui_container_wrapper.cjs")) &&
    existsSync(join(candidate, "remote-terminal", "openui_environment_wrapper.cjs")) &&
    existsSync(join(candidate, "remote-terminal", "openui_remote_server.py")) &&
    existsSync(join(candidate, "remote-terminal", "openui_remote_shell.py")) &&
    existsSync(join(candidate, "shell-integration", "openui.zsh")) &&
    existsSync(join(candidate, "shell-integration", "openui.bash")) &&
    existsSync(join(candidate, "shell-integration", "openui.fish")),
  ) || null;
}

function executableOnPath(name: string, pathValue: string): string | null {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

export function getSessionShellLaunch(session: Session): { shell: string; args: string[] } {
  const persisted = session.shellLaunch;
  if (!persisted?.shell || !Array.isArray(persisted.args)) return getDefaultShellLaunch();
  try {
    if (isAbsolute(persisted.shell)) {
      accessSync(persisted.shell, fsConstants.X_OK);
      const stat = lstatSync(persisted.shell);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return { shell: persisted.shell, args: [...persisted.args] };
      }
    } else {
      const resolvedShell = executableOnPath(persisted.shell, process.env.PATH || "");
      if (resolvedShell) return { shell: resolvedShell, args: [...persisted.args] };
    }
  } catch {
    // A removed or inaccessible persisted shell falls back safely.
  }
  return getDefaultShellLaunch();
}

function ensurePrivateDirectory(path: string): boolean {
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } else {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
  }
}

function writePrivateRuntimeFile(path: string, content: string, executable = false) {
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
    mode: executable ? 0o700 : 0o600,
  });
  chmodSync(path, executable ? 0o700 : 0o600);
}

const SUBSHELL_CONFIG_VERSION = 1;
const MAX_SUBSHELL_CONFIG_BYTES = 64 * 1024;
const MAX_SUBSHELL_PATTERNS = 64;
const MAX_SUBSHELL_PATTERN_TOKENS = 32;
const MAX_SUBSHELL_PATTERN_TOKEN_BYTES = 256;
const SUBSHELL_TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const RESERVED_SUBSHELL_TOOLS = new Set([
  "bash", "zsh", "fish", "pwsh", "powershell", "docker", "podman", "kubectl", "ssh",
]);

type SubshellArgvPattern = {
  argv: string[];
  match: "exact" | "prefix";
};

type SubshellPolicyByTool = Map<string, {
  added: Array<{ args: string[]; match: "exact" | "prefix" }>;
  denied: Array<{ args: string[]; match: "exact" | "prefix" }>;
}>;

function validSubshellPattern(value: unknown): SubshellArgvPattern | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.argv) || record.argv.length < 1 ||
      record.argv.length > MAX_SUBSHELL_PATTERN_TOKENS) return null;
  if (record.match !== "exact" && record.match !== "prefix") return null;
  const argv = record.argv;
  if (!argv.every((token) => typeof token === "string" && !token.includes("\0") &&
      Buffer.byteLength(token, "utf8") <= MAX_SUBSHELL_PATTERN_TOKEN_BYTES)) return null;
  if (!SUBSHELL_TOOL_PATTERN.test(argv[0])) return null;
  if (argv.slice(1).some((token) => token.length === 0 || (token.includes("*") && token !== "*"))) return null;
  return { argv: [...argv], match: record.match };
}

/**
 * Loads bounded, declarative argv patterns from ~/.openui-desktop/terminal-subshells.json.
 * A literal `*` matches one argv token; no shell source or backtracking regex is accepted.
 */
function loadSubshellPolicies(home: string): SubshellPolicyByTool {
  const policies: SubshellPolicyByTool = new Map();
  const path = join(home, ".openui-desktop", "terminal-subshells.json");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUBSHELL_CONFIG_BYTES ||
        (info.mode & 0o022) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) return policies;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!parsed || parsed.version !== SUBSHELL_CONFIG_VERSION) return policies;
    const addedRaw = Array.isArray(parsed.addedSubshellCommands) ? parsed.addedSubshellCommands : [];
    const deniedRaw = Array.isArray(parsed.subshellCommandsDenylist) ? parsed.subshellCommandsDenylist : [];
    if (addedRaw.length + deniedRaw.length > MAX_SUBSHELL_PATTERNS) return policies;
    const add = (raw: unknown, field: "added" | "denied") => {
      const pattern = validSubshellPattern(raw);
      if (!pattern || RESERVED_SUBSHELL_TOOLS.has(pattern.argv[0])) return;
      const tool = pattern.argv[0];
      const policy = policies.get(tool) || { added: [], denied: [] };
      policy[field].push({ args: pattern.argv.slice(1), match: pattern.match });
      policies.set(tool, policy);
    };
    addedRaw.forEach((pattern) => add(pattern, "added"));
    deniedRaw.forEach((pattern) => add(pattern, "denied"));
  } catch {
    // Missing, malformed, unsafe, and unsupported config files fail closed.
  }
  return policies;
}

/**
 * Creates process-private PATH shims for ordinary interactive child shells.
 * The shims never edit user startup files and dispatch command/script/no-rc
 * invocations to the original executable unchanged.
 */
export function prepareShellShimEnvironment(
  sessionId: string,
  baseEnvironment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (process.platform === "win32") return {};
  if (shellShimDirectories.has(sessionId) || sshControlDirectories.has(sessionId)) {
    cleanupShellShimEnvironment(sessionId);
  }

  const home = baseEnvironment.HOME || homedir();
  const openuiHome = join(home, ".openui-desktop");
  const runtimeRoot = join(openuiHome, "runtime-shell-shims");
  if (!ensurePrivateDirectory(openuiHome) || !ensurePrivateDirectory(runtimeRoot)) return {};

  const safeId = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const shimDirectory = join(runtimeRoot, safeId);
  try {
    if (existsSync(shimDirectory)) {
      const stat = lstatSync(shimDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return {};
      rmSync(shimDirectory, { recursive: true, force: true });
    }
    mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
    chmodSync(shimDirectory, 0o700);
  } catch {
    return {};
  }

  const originalPath = baseEnvironment.PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const subshellPolicies = loadSubshellPolicies(home);
  let created = 0;

  const zsh = executableOnPath("zsh", originalPath);
  const zshIntegration = zsh ? getShellIntegrationPath(zsh) : null;
  if (zsh && zshIntegration) {
    const zshDotDirectory = join(shimDirectory, "zsh-dotfiles");
    mkdirSync(zshDotDirectory, { recursive: true, mode: 0o700 });
    chmodSync(zshDotDirectory, 0o700);
    const rawUserZdotdir = baseEnvironment.ZDOTDIR || home;
    const userZdotdir = isAbsolute(rawUserZdotdir)
      ? rawUserZdotdir
      : resolve(home, rawUserZdotdir);
    const sourceUserFile = (filename: string) => {
      const file = join(userZdotdir, filename);
      return `[[ -r ${quotePosix(file)} ]] && source ${quotePosix(file)}`;
    };
    writePrivateRuntimeFile(join(zshDotDirectory, ".zshenv"), [
      sourceUserFile(".zshenv"),
      `export ZDOTDIR=${quotePosix(zshDotDirectory)}`,
    ].join("\n"));
    writePrivateRuntimeFile(join(zshDotDirectory, ".zprofile"), sourceUserFile(".zprofile"));
    writePrivateRuntimeFile(join(zshDotDirectory, ".zshrc"), [
      sourceUserFile(".zshrc"),
      `source ${quotePosix(zshIntegration)}`,
    ].join("\n"));
    writePrivateRuntimeFile(join(zshDotDirectory, ".zlogin"), sourceUserFile(".zlogin"));
    writePrivateRuntimeFile(join(zshDotDirectory, ".zlogout"), sourceUserFile(".zlogout"));
    writePrivateRuntimeFile(join(shimDirectory, "zsh"), [
      "#!/bin/sh",
      "interactive=0",
      '[ "$#" -eq 0 ] && interactive=1',
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    -c|-[^-]*c*|--no-rcs|-f|-[^-]*f*) exec ${quotePosix(zsh)} "$@" ;;`,
      "    -i|-[^-]*i*) interactive=1 ;;",
      "  esac",
      "done",
      `[ "$interactive" -eq 1 ] || exec ${quotePosix(zsh)} "$@"`,
      `export ZDOTDIR=${quotePosix(zshDotDirectory)}`,
      `exec ${quotePosix(zsh)} "$@"`,
    ].join("\n"), true);
    created++;
  }

  const bash = executableOnPath("bash", originalPath);
  const bashIntegration = bash ? getShellIntegrationPath(bash) : null;
  if (bash && bashIntegration) {
    const bashRc = join(shimDirectory, "bashrc");
    const userBashRc = join(home, ".bashrc");
    writePrivateRuntimeFile(bashRc, [
      `[[ -r ${quotePosix(userBashRc)} ]] && source ${quotePosix(userBashRc)}`,
      `source ${quotePosix(bashIntegration)}`,
    ].join("\n"));
    writePrivateRuntimeFile(join(shimDirectory, "bash"), [
      "#!/bin/sh",
      "interactive=0",
      '[ "$#" -eq 0 ] && interactive=1',
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    -c|-[^-]*c*|--norc|--rcfile) exec ${quotePosix(bash)} "$@" ;;`,
      "    -i|-[^-]*i*) interactive=1 ;;",
      "  esac",
      "done",
      `[ "$interactive" -eq 1 ] || exec ${quotePosix(bash)} "$@"`,
      `exec ${quotePosix(bash)} --rcfile ${quotePosix(bashRc)} "$@"`,
    ].join("\n"), true);
    created++;
  }

  const fish = executableOnPath("fish", originalPath);
  const fishIntegration = fish ? getShellIntegrationPath(fish) : null;
  if (fish && fishIntegration) {
    writePrivateRuntimeFile(join(shimDirectory, "fish"), [
      "#!/bin/sh",
      "interactive=0",
      '[ "$#" -eq 0 ] && interactive=1',
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    -c|--command|--command=*|-N|--no-config) exec ${quotePosix(fish)} "$@" ;;`,
      "    -i|--interactive) interactive=1 ;;",
      "  esac",
      "done",
      `[ "$interactive" -eq 1 ] || exec ${quotePosix(fish)} "$@"`,
      `exec ${quotePosix(fish)} --init-command ${quotePosix(`source ${quotePosix(fishIntegration)}`)} "$@"`,
    ].join("\n"), true);
    created++;
  }

  for (const executableName of ["pwsh", "powershell"]) {
    const executable = executableOnPath(executableName, originalPath);
    const integration = executable ? getShellIntegrationPath(executable) : null;
    if (!executable || !integration) continue;
    const initCommand = `. ${quotePowerShell(integration)}`;
    writePrivateRuntimeFile(join(shimDirectory, executableName), [
      "#!/bin/sh",
      "interactive=1",
      'for arg in "$@"; do',
      '  lower=$(printf "%s" "$arg" | tr "[:upper:]" "[:lower:]")',
      '  case "$lower" in',
      `    -c|-command|-commandwithargs|-e|-encodedcommand|-f|-file|-noninteractive|-h|-help|-'?'|-v|-version) exec ${quotePosix(executable)} "$@" ;;`,
      "    -*) ;;",
      `    *) exec ${quotePosix(executable)} "$@" ;;`,
      "  esac",
      "done",
      `exec ${quotePosix(executable)} "$@" -NoExit -Command ${quotePosix(initCommand)}`,
    ].join("\n"), true);
    created++;
  }

  const resourceRoot = getTerminalResourceRoot();
  const containerWrapper = resourceRoot
    ? join(resourceRoot, "remote-terminal", "openui_container_wrapper.cjs")
    : null;
  if (containerWrapper && isAbsolute(process.execPath)) {
    for (const tool of ["docker", "podman", "kubectl"]) {
      const executable = executableOnPath(tool, originalPath);
      if (!executable) continue;
      writePrivateRuntimeFile(join(shimDirectory, tool), [
        "#!/bin/sh",
        [
          `OPENUI_CONTAINER_REAL_EXECUTABLE=${quotePosix(executable)}`,
          `OPENUI_CONTAINER_TOOL=${quotePosix(tool)}`,
          `OPENUI_CONTAINER_ASSET_DIR=${quotePosix(resourceRoot!)}`,
          "ELECTRON_RUN_AS_NODE=1",
          `exec ${quotePosix(process.execPath)} ${quotePosix(containerWrapper)} \"$@\"`,
        ].join(" "),
      ].join("\n"), true);
      created++;
    }
  }

  const environmentWrapper = resourceRoot
    ? join(resourceRoot, "remote-terminal", "openui_environment_wrapper.cjs")
    : null;
  if (environmentWrapper && isAbsolute(process.execPath)) {
    const builtInTools = ["poetry", "pipenv", "aws-vault", "flox"];
    const customTools = [...subshellPolicies.entries()]
      .filter(([, policy]) => policy.added.length > 0)
      .map(([tool]) => tool);
    for (const tool of [...new Set([...builtInTools, ...customTools])]) {
      const executable = executableOnPath(tool, originalPath);
      if (!executable) continue;
      const policy = subshellPolicies.get(tool) || { added: [], denied: [] };
      const policyPath = join(shimDirectory, `subshell-policy-${tool}.json`);
      writePrivateRuntimeFile(policyPath, JSON.stringify({
        version: SUBSHELL_CONFIG_VERSION,
        tool,
        added: policy.added,
        denied: policy.denied,
      }));
      writePrivateRuntimeFile(join(shimDirectory, tool), [
        "#!/bin/sh",
        [
          `OPENUI_SUBSHELL_REAL_EXECUTABLE=${quotePosix(executable)}`,
          `OPENUI_SUBSHELL_TOOL=${quotePosix(tool)}`,
          `OPENUI_SUBSHELL_POLICY_FILE=${quotePosix(policyPath)}`,
          "ELECTRON_RUN_AS_NODE=1",
          `exec ${quotePosix(process.execPath)} ${quotePosix(environmentWrapper)} "$@"`,
        ].join(" "),
      ].join("\n"), true);
      created++;
    }
  }

  const realSsh = executableOnPath("ssh", originalPath);
  const remoteAssetVersion = resourceRoot ? terminalRemoteAssetVersion(resourceRoot) : null;
  let remoteEnvironment: Record<string, string> = {};
  if (realSsh && resourceRoot && remoteAssetVersion && isAbsolute(process.execPath)) {
    try {
      const controlDirectory = mkdtempSync(join(tmpdir(), `openui-ssh-${safeId.slice(0, 8)}-`));
      chmodSync(controlDirectory, 0o700);
      const token = randomBytes(32).toString("hex");
      const wrapper = join(resourceRoot, "remote-terminal", "openui_ssh_wrapper.cjs");
      writePrivateRuntimeFile(join(shimDirectory, "ssh"), [
        "#!/bin/sh",
        `ELECTRON_RUN_AS_NODE=1 exec ${quotePosix(process.execPath)} ${quotePosix(wrapper)} "$@"`,
      ].join("\n"), true);
      sshControlDirectories.set(sessionId, controlDirectory);
      terminalRemoteManager.registerRuntime(sessionId, {
        token,
        controlDirectory,
        sshExecutable: realSsh,
        assetVersion: remoteAssetVersion,
      });
      remoteEnvironment = {
        OPENUI_REMOTE_CONTROL_TOKEN: token,
        OPENUI_SSH_CONTROL_DIR: controlDirectory,
        OPENUI_SSH_REAL_EXECUTABLE: realSsh,
        OPENUI_SSH_WRAPPER: wrapper,
        OPENUI_REMOTE_ASSET_DIR: resourceRoot,
        OPENUI_NODE_RUNTIME: process.execPath,
      };
      created++;
    } catch {
      terminalRemoteManager.deregister(sessionId);
      const controlDirectory = sshControlDirectories.get(sessionId);
      sshControlDirectories.delete(sessionId);
      if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
    }
  }

  if (!created) {
    rmSync(shimDirectory, { recursive: true, force: true });
    return {};
  }
  shellShimDirectories.set(sessionId, shimDirectory);
  return {
    OPENUI_ORIGINAL_PATH: originalPath,
    OPENUI_SHELL_SHIM_DIR: shimDirectory,
    PATH: `${shimDirectory}${delimiter}${originalPath}`,
    ...remoteEnvironment,
  };
}

export function cleanupShellShimEnvironment(sessionId: string) {
  const directory = shellShimDirectories.get(sessionId);
  shellShimDirectories.delete(sessionId);
  const controlDirectory = sshControlDirectories.get(sessionId);
  sshControlDirectories.delete(sessionId);
  terminalRemoteManager.deregister(sessionId);
  if (controlDirectory) {
    try {
      const stat = lstatSync(controlDirectory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        rmSync(controlDirectory, { recursive: true, force: true });
      }
    } catch {
      // Runtime cleanup is best effort.
    }
  }
  if (!directory) return;
  try {
    const stat = lstatSync(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    // Runtime cleanup is best effort.
  }
}

export function installShellIntegration(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  shell: string,
) {
  if (session.pty !== ptyProcess) return false;
  const integrationPath = getShellIntegrationPath(shell);
  if (!integrationPath) return false;
  const shellName = basename(shell).toLowerCase();
  const command = shellName.includes("pwsh") || shellName.includes("powershell")
    ? `. ${quotePowerShell(integrationPath)}`
    : `source ${quotePosix(integrationPath)}`;
  return writeTerminalData(sessionId, command, {
    kind: "bootstrap",
    bracketedPaste: true,
    submit: true,
  });
}

export function startTrackedCommand(
  sessionId: string,
  session: Session,
  ptyProcess: pty.IPty,
  command: string,
  options: {
    clearLine?: boolean;
    frameRedrawsInPlace?: boolean;
    kind?: TerminalPtyWriteOptions["kind"];
    onStarted?: (block: TerminalCommandBlock) => void;
    onError?: (error: unknown) => void;
  } = {},
): boolean {
  if (session.pty !== ptyProcess) return false;
  const lifecycle = terminalLifecycleFor(sessionId, session);
  return writeTerminalData(sessionId, command, {
    kind: options.kind || "command",
    bracketedPaste: true,
    clearLine: options.clearLine,
    submit: true,
    beforeWrite: () => {
      if (session.pty !== ptyProcess) throw new Error("PTY was replaced before command write");
      const block = lifecycle.startCommand(
        command,
        "inferred",
        options.frameRedrawsInPlace ?? session.terminalFrameRedrawsInPlace,
      );
      options.onStarted?.(block);
      terminalFind.invalidateBlock(sessionId, block.id);
      if (options.kind !== "queued-command" && session.agentFallbackCommands?.length) {
        session.agentAttemptCommand = command;
        session.agentAttemptBlockId = block.id;
        session.agentAttemptStartedAt = Date.now();
      }
      broadcastTerminalState(sessionId, session);
    },
    onError: (error) => {
      logError(`[terminal-write] Command write failed for ${sessionId}:`, error);
      options.onError?.(error);
    },
  });
}

export const TERMINAL_SYNCHRONIZED_INPUT_MAX_TARGETS = 32;
export const TERMINAL_SYNCHRONIZED_INPUT_MAX_COMMAND_CHARS = 4_096;

export interface TerminalSynchronizedInputSkip {
  sessionId: string;
  reason: "missing" | "disconnected" | "busy" | "alternate-screen" | "write-pending" | "write-rejected";
}

export function dispatchSynchronizedTerminalCommand(
  sourceSessionId: string,
  targetSessionIds: string[],
  rawCommand: unknown,
): {
  sourceSessionId: string;
  command: string;
  dispatchedSessionIds: string[];
  skipped: TerminalSynchronizedInputSkip[];
} {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    throw new TerminalCommandQueueError("Synchronized command is required");
  }
  if (rawCommand.length > TERMINAL_SYNCHRONIZED_INPUT_MAX_COMMAND_CHARS) {
    throw new TerminalCommandQueueError(
      `Synchronized command exceeds ${TERMINAL_SYNCHRONIZED_INPUT_MAX_COMMAND_CHARS} characters`,
    );
  }
  if (rawCommand.includes("\0") || /[\r\n]/.test(rawCommand)) {
    throw new TerminalCommandQueueError("Synchronized command must be a single line without NUL bytes");
  }
  if (typeof sourceSessionId !== "string" || !sourceSessionId.trim()) {
    throw new TerminalCommandQueueError("Synchronized input source is required");
  }
  if (!Array.isArray(targetSessionIds)) {
    throw new TerminalCommandQueueError("Synchronized input targets are required");
  }

  const uniqueTargets = [...new Set(targetSessionIds.filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim())
  ))];
  if (!uniqueTargets.includes(sourceSessionId)) uniqueTargets.unshift(sourceSessionId);
  if (uniqueTargets.length > TERMINAL_SYNCHRONIZED_INPUT_MAX_TARGETS) {
    throw new TerminalCommandQueueError(
      `Synchronized input may target at most ${TERMINAL_SYNCHRONIZED_INPUT_MAX_TARGETS} sessions`,
    );
  }

  const skipped: TerminalSynchronizedInputSkip[] = [];
  const ready: Array<{ sessionId: string; session: Session }> = [];
  for (const sessionId of uniqueTargets) {
    const session = sessions.get(sessionId);
    if (!session || session.pendingDelete) {
      skipped.push({ sessionId, reason: "missing" });
      continue;
    }
    if (!session.pty) {
      skipped.push({ sessionId, reason: "disconnected" });
      continue;
    }
    const lifecycle = terminalLifecycleFor(sessionId, session);
    const snapshot = lifecycle.snapshot(false);
    if (snapshot.alternateScreen) {
      skipped.push({ sessionId, reason: "alternate-screen" });
      continue;
    }
    if (snapshot.phase !== "at_prompt" || !lifecycle.canAcceptCommand()) {
      skipped.push({ sessionId, reason: "busy" });
      continue;
    }
    if (terminalPtyWriters.get(sessionId)?.writer.pendingWrites) {
      skipped.push({ sessionId, reason: "write-pending" });
      continue;
    }
    ready.push({ sessionId, session });
  }

  if (!ready.some((entry) => entry.sessionId === sourceSessionId)) {
    const sourceReason = skipped.find((entry) => entry.sessionId === sourceSessionId)?.reason || "busy";
    throw new TerminalCommandQueueError(`Synchronized input source is not ready (${sourceReason})`, 409);
  }

  const dispatchedSessionIds: string[] = [];
  const ordered = [
    ready.find((entry) => entry.sessionId === sourceSessionId)!,
    ...ready.filter((entry) => entry.sessionId !== sourceSessionId),
  ];
  for (const { sessionId, session } of ordered) {
    const accepted = startTrackedCommand(sessionId, session, session.pty!, rawCommand, {
      clearLine: true,
      kind: "automation",
    });
    if (!accepted) {
      skipped.push({ sessionId, reason: "write-rejected" });
      if (sessionId === sourceSessionId) {
        throw new TerminalCommandQueueError("Synchronized input source rejected the command", 409);
      }
      continue;
    }
    dispatchedSessionIds.push(sessionId);
  }

  return {
    sourceSessionId,
    command: rawCommand,
    dispatchedSessionIds,
    skipped,
  };
}

// Actual port the server is listening on — set by setServerPort() after bind
let serverPort: number = 6968;
export function setServerPort(port: number) { serverPort = port; }
export function getServerPort(): number { return serverPort; }

function broadcastSessionName(sessionId: string, name: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  for (const client of session.clients) {
    sendTerminalMessage(client, { type: "nameGenerated", name });
  }
}

export function scheduleSessionTitleGeneration(sessionId: string, prompt: string) {
  const session = sessions.get(sessionId);
  const titlePrompt = prompt.trim();
  if (!session || !titlePrompt) return;

  // A user-edited name lives in the same field as generated titles. Only keep
  // ripening while the visible name is still the title OpenUI generated.
  if (session.customName && session.customName !== session.generatedTitle) return;

  const history = session.titlePromptHistory ?? [];
  if (history[history.length - 1] !== titlePrompt) {
    session.titlePromptHistory = [...history, titlePrompt].slice(-TITLE_PROMPT_HISTORY_LIMIT);
  }
  session.nameGenerated = true;

  const existingTimer = titleGenerationTimers.get(sessionId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    titleGenerationTimers.delete(sessionId);
    const currentAtStart = sessions.get(sessionId);
    if (!currentAtStart) return;

    void generateSessionTitle({
      prompt: titlePrompt,
      promptHistory: currentAtStart.titlePromptHistory,
      agentName: currentAtStart.agentName,
      cwd: currentAtStart.cwd,
      ticketTitle: currentAtStart.ticketTitle,
      gitBranch: currentAtStart.gitBranch,
    }).then((name) => {
      const current = sessions.get(sessionId);
      if (!current) return;
      if (current.customName && current.customName !== current.generatedTitle) return;
      if (!name || name === current.generatedTitle) return;

      current.customName = name;
      current.generatedTitle = name;
      current.nameGenerated = true;
      saveState(sessions);
      broadcastSessionName(sessionId, name);
    }).catch((error: any) => {
      logError(`[PRBE_ERROR_titleGeneration] [session] Failed to generate title for ${sessionId}: ${error?.message || error}`);
    });
  }, TITLE_UPDATE_DEBOUNCE_MS);

  titleGenerationTimers.set(sessionId, timer);
}

export function getActiveSessionCount(): number {
  let count = 0;
  for (const [, session] of sessions) {
    if (session.pty) count++;
  }
  return count;
}

export async function createSession(params: {
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  nodeId: string;
  customName?: string;
  customColor?: string;
  ticketId?: string;
  ticketTitle?: string;
  ticketUrl?: string;
  branchName?: string;
  baseBranch?: string;
  createWorktreeFlag?: boolean;
  ticketPromptTemplate?: string;
  initialPrompt?: string;
  autoCareful?: boolean;
  multiRepoMode?: 'current' | 'main';
  additionalRepos?: { name: string; path: string; defaultBranch?: string }[];
  agentProfileId?: string;
  agentProfileVersion?: number;
  agentPermissionPolicy?: Session["agentPermissionPolicy"];
  agentAllowedTools?: string[];
  agentRuntimeManifestPath?: string;
  agentModel?: string;
  agentFallbackCommands?: string[];
  registerWorkspace?: boolean;
  /** Set when the session runs on a remote devbox rather than this machine. */
  devboxId?: string;
  remotePath?: string;
  beforeStart?: (cwd: string) => Promise<void>;
}): Promise<{ session: Session; cwd: string; gitBranch?: string }> {
  const {
    devboxId,
    remotePath,
    sessionId,
    agentId,
    agentName,
    command,
    cwd: originalCwd,
    nodeId,
    customName,
    customColor,
    ticketId,
    ticketTitle,
    ticketUrl,
    branchName,
    baseBranch,
    createWorktreeFlag,
    ticketPromptTemplate,
    initialPrompt,
    autoCareful,
    multiRepoMode,
    additionalRepos,
    agentProfileId,
    agentProfileVersion,
    agentPermissionPolicy,
    agentAllowedTools,
    agentRuntimeManifestPath,
    agentModel,
    agentFallbackCommands,
    registerWorkspace = true,
    beforeStart,
  } = params;

  let workingDir = originalCwd;
  let worktreePath: string | undefined;
  let mainRepoPath: string | undefined;
  let gitBranch: string | null = null;
  let worktreePaths: Record<string, string> | undefined;
  let stashRefs: Record<string, string> | undefined;
  let worktreeMode: 'current' | 'main' | undefined;

  if (createWorktreeFlag && branchName && baseBranch) {
    if (additionalRepos && additionalRepos.length > 0 && multiRepoMode) {
      const multiResult = await createMultiRepoWorktrees({
        repos: additionalRepos,
        branchName,
        mode: multiRepoMode,
        baseBranch,
      });

      worktreePaths = multiResult.worktreePaths;
      stashRefs = Object.keys(multiResult.stashRefs).length > 0 ? multiResult.stashRefs : undefined;
      worktreeMode = multiRepoMode;
      gitBranch = branchName;

      log(`[session] Multi-repo worktrees created: ${Object.keys(worktreePaths).join(', ')}`);

      for (const [repoName, error] of Object.entries(multiResult.errors)) {
        // Probe Agent Error Log Trigger
        logError(`[PRBE_ERROR_H1Xq5O] [session] Worktree failed for ${repoName}: ${error}`);
      }
    } else {
      const result = await createWorktree({ cwd: originalCwd, branchName, baseBranch });
      if (result.success && result.worktreePath) {
        workingDir = result.worktreePath;
        worktreePath = result.worktreePath;
        mainRepoPath = originalCwd;
        gitBranch = branchName;
      }
    }
  }

  if (!mainRepoPath) {
    const detectedMainRepo = await getMainWorktree(workingDir);
    if (detectedMainRepo && detectedMainRepo !== workingDir) {
      mainRepoPath = detectedMainRepo;
    }
  }

  if (!gitBranch) {
    gitBranch = await getGitBranch(workingDir);
  }

  // Validate working directory exists before spawning
  if (!existsSync(workingDir)) {
    log(`[session] Working directory does not exist: ${workingDir}, falling back to home`);
    workingDir = homedir();
  }

  if (beforeStart) {
    await beforeStart(workingDir);
  }

  // Use the user's default shell and spawn as login shell to source their profile
  const { shell, args: shellArgs } = getDefaultShellLaunch();

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cwd: workingDir,
      env: getPtyEnvironment(sessionId, {
        id: agentProfileId,
        version: agentProfileVersion,
        permissionPolicy: agentPermissionPolicy,
        allowedTools: agentAllowedTools,
        manifestPath: agentRuntimeManifestPath,
        model: agentModel,
      }),
      cols: preferredTerminalSize().cols,
      rows: preferredTerminalSize().rows,
    });
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_nsfUhY] [session] Failed to spawn PTY (shell=${shell}, cwd=${workingDir}): ${e.message}`);
    throw new Error(`Failed to spawn terminal: ${e.message}. Shell: ${shell}, CWD: ${workingDir}`);
  }

  const now = Date.now();
  const session: Session = {
    pty: ptyProcess,
    agentId,
    agentName,
    command,
    cwd: workingDir,
    originalCwd: mainRepoPath,
    gitBranch: gitBranch || undefined,
    worktreePath,
    worktreePaths,
    worktreeMode,
    stashRefs,
    devboxId,
    remotePath,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    outputBuffer: [],
    outputBufferChars: 0,
    outputBufferTruncated: false,
    shellLaunch: { shell, args: [...shellArgs] },
    terminalCols: preferredTerminalSize().cols,
    terminalRows: preferredTerminalSize().rows,
    terminalFrameRedrawsInPlace: agentId !== "shell" && agentId !== "test",
    status: "idle",
    statusChangedAt: now,
    lastOutputTime: now,
    lastInputTime: 0,
    recentOutputSize: 0,
    customName,
    customColor,
    nodeId,
    isRestored: false,
    ticketId,
    ticketTitle,
    ticketUrl,
    terminalBlocks: [],
    agentProfileId,
    agentProfileVersion,
    agentPermissionPolicy,
    agentAllowedTools,
    agentRuntimeManifestPath,
    agentModel,
    agentPermissionEvents: [],
    agentFallbackCommands,
    agentFallbackIndex: 0,
  };

  sessions.set(sessionId, session);
  try {
    if (registerWorkspace) terminalWorkspace.addTab(sessionId, { title: customName || agentName });
  } catch (error) {
    sessions.delete(sessionId);
    ptyProcess.kill();
    cleanupShellShimEnvironment(sessionId);
    throw error;
  }
  attachSessionPty(sessionId, session, ptyProcess);

  startAgentStatusTicker(sessionId, session, sessions);

  // Run the command
  const finalCommand = injectPluginDir(resolveAgentLaunchCommand(command, agentId), agentId);
  const isClaudeCommand = commandExecutableName(finalCommand) === "claude";
  const ownsCurrentPty = () =>
    sessions.get(sessionId) === session && session.pty === ptyProcess;
  if (finalCommand) log(`[pty-write] Writing command: ${finalCommand}`);
  setTimeout(() => {
    if (ownsCurrentPty()) installShellIntegration(sessionId, session, ptyProcess, shell);
  }, 150);
  const initialCommandDispatchStartedAt = Date.now();
  const dispatchInitialCommand = () => {
    if (!finalCommand || !ownsCurrentPty()) return;
    const needsBracketedPaste = /[\r\n]/.test(finalCommand);
    const lifecycle = terminalLifecycleFor(sessionId, session);
    if (
      needsBracketedPaste &&
      !lifecycle.isBracketedPasteEnabled() &&
      Date.now() - initialCommandDispatchStartedAt < INITIAL_MULTILINE_READY_TIMEOUT_MS
    ) {
      // Shell startup and integration sourcing complete asynchronously. A
      // fixed startup delay can race a slower shell and turn one multiline
      // launch command into several independent submissions. Wait for the
      // shell's advertised bracketed-paste mode before writing it atomically.
      setTimeout(dispatchInitialCommand, INITIAL_MULTILINE_READY_POLL_MS);
      return;
    }
    if (!startTrackedCommand(sessionId, session, ptyProcess, finalCommand)) return;

    // Enable /careful for Claude Code sessions on startup (opt-in; off by default)
    if (isClaudeCommand && autoCareful === true) {
      setTimeout(() => {
        if (!ownsCurrentPty()) return;
        writeTerminalData(sessionId, "/careful", {
          kind: "automation",
          bracketedPaste: true,
          submit: true,
        });
      }, 2000);
    }

    let promptDelay = isClaudeCommand ? 4000 : 1200;

    if (ticketUrl) {
      setTimeout(() => {
        if (!ownsCurrentPty()) return;
        const defaultTemplate = "Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work.";
        const template = ticketPromptTemplate || defaultTemplate;
        const ticketPrompt = template
          .replace(/\{\{url\}\}/g, ticketUrl)
          .replace(/\{\{id\}\}/g, ticketId || "")
          .replace(/\{\{title\}\}/g, ticketTitle || "");
        writeTerminalData(sessionId, ticketPrompt, {
          kind: "automation",
          bracketedPaste: true,
          submit: true,
        });
      }, promptDelay);
      promptDelay += 1800;
    }

    // If multi-repo worktrees were created, inject context
    if (worktreePaths && Object.keys(worktreePaths).length > 1) {
      setTimeout(() => {
        if (!ownsCurrentPty()) return;
        const repoLines = Object.entries(worktreePaths!)
          .map(([name, path]) => `- ${name}: ${path}`)
          .join("\n");
        const contextPrompt = `This session has worktrees across multiple repos:\n${repoLines}\n\nAll repos are on branch: ${branchName}\nCoordinate changes across all repos as needed.`;
        writeTerminalData(sessionId, contextPrompt, {
          kind: "automation",
          bracketedPaste: true,
          submit: true,
        });
      }, promptDelay);
      promptDelay += 1800;
    }

    const starterPrompt = initialPrompt?.trim();
    if (starterPrompt) {
      setTimeout(() => {
        if (!ownsCurrentPty()) return;
        writeTerminalData(sessionId, starterPrompt.slice(0, 12000), {
          kind: "automation",
          bracketedPaste: true,
          submit: true,
        });
      }, promptDelay);
    }
  };
  setTimeout(dispatchInitialCommand, 450);

  log(`[session] Created ${sessionId} for ${agentName}${ticketId ? ` (ticket: ${ticketId})` : ""}`);
  return { session, cwd: workingDir, gitBranch: gitBranch || undefined };
}

export function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  terminalWorkspace.removeSession(sessionId);

  disposeAgentStatus(session);
  if (session.deleteTimeout) clearTimeout(session.deleteTimeout);
  session.deleteTimeout = undefined;

  const activePty = session.pty;
  const stateTrackerPty = session.stateTrackerPty;
  session.pty = null;
  session.stateTrackerPty = null;
  terminalLifecycles.get(sessionId)?.terminate(undefined);
  terminalCommandQueue.clear(sessionId);
  // Reap before the pty dies. `pty.kill()` SIGHUPs the shell only; the agent
  // CLI sits in its own process group and anything it daemonized sits in its
  // own session, so once the shell exits those are reparented to init with
  // nothing left to identify them by. The pty still owns the root kill so its
  // onExit handler fires as usual.
  //
  // Gated on there being a LIVE pty, which matters beyond the obvious. A
  // session restored from disk has pty === null, so a second instance pointed
  // at the same LAUNCH_CWD (a dev build defaulting to the same home directory)
  // reaps nothing for sessions it did not itself spawn, and cannot tear down
  // the trees belonging to the app that actually owns them.
  if (activePty) {
    reapProcessTreeDetached(activePty.pid, {
      label: sessionId,
      killRoot: false,
      sessionMarker: sessionId,
    });
  }
  if (stateTrackerPty) {
    reapProcessTreeDetached(stateTrackerPty.pid, {
      label: `${sessionId}:state-tracker`,
      killRoot: false,
    });
  }
  if (activePty) activePty.kill();
  if (stateTrackerPty) stateTrackerPty.kill();

  sessions.delete(sessionId);
  terminalLifecycles.delete(sessionId);
  terminalFind.cancelSession(sessionId);
  disposeTerminalPtyWriter(sessionId);
  cleanupShellShimEnvironment(sessionId);
  deletePersistedSession(sessionId);
  log(`[session] Killed ${sessionId}`);
  return true;
}

export async function restoreSessions() {
  const state = loadState();

  log(`[restore] Found ${state.nodes.length} saved sessions`);

  // Carry the remembered spawn geometry across the restart, so the first session of
  // a launch spawns at the size the user reads terminals at rather than at 80x24.
  for (const node of state.nodes) {
    notePreferredTerminalSize(
      node.terminalCols || DEFAULT_PTY_COLS,
      node.terminalRows || DEFAULT_PTY_ROWS,
    );
  }

  for (const node of state.nodes) {
    const buffer = loadBuffer(node.sessionId);
    const gitBranch = await getGitBranch(node.cwd);

    const session: Session = {
      pty: null,
      agentId: node.agentId,
      agentName: node.agentName,
      command: node.command,
      cwd: node.cwd,
      originalCwd: node.originalCwd,
      devboxId: node.devboxId,
      remotePath: node.remotePath,
      move: node.move,
      gitBranch: gitBranch || undefined,
      createdAt: node.createdAt,
      clients: new Set(),
      outputBuffer: buffer.chunks,
      outputBufferChars: buffer.chunks.reduce((total, chunk) => total + chunk.length, 0),
      outputBufferTruncated: buffer.truncated,
      shellLaunch: node.shellLaunch,
      terminalCols: node.terminalCols || DEFAULT_PTY_COLS,
      terminalRows: node.terminalRows || DEFAULT_PTY_ROWS,
      terminalFrameRedrawsInPlace: node.terminalFrameRedrawsInPlace ??
        (node.agentId !== "shell" && node.agentId !== "test"),
      status: "disconnected",
      statusChangedAt: Date.now(),
      lastOutputTime: 0,
      lastInputTime: 0,
      recentOutputSize: 0,
      customName: node.customName,
      generatedTitle: node.generatedTitle,
      titlePromptHistory: node.titlePromptHistory,
      customColor: node.customColor,
      notes: node.notes,
      nodeId: node.nodeId,
      isRestored: true,
      worktreePaths: node.worktreePaths,
      launchCheckpoint: node.launchCheckpoint,
      terminalBlocks: loadTerminalBlocks(node.sessionId),
      agentProfileId: node.agentProfileId,
      agentProfileVersion: node.agentProfileVersion,
      agentPermissionPolicy: node.agentPermissionPolicy,
      agentAllowedTools: node.agentAllowedTools,
      agentRuntimeManifestPath: node.agentRuntimeManifestPath,
      agentModel: node.agentModel,
      agentPermissionEvents: node.agentPermissionEvents,
    };

    sessions.set(node.sessionId, session);
    log(`[restore] Restored ${node.sessionId} (${node.agentName}) branch: ${gitBranch || "none"}`);
  }
  terminalWorkspace.reconcile(sessions.keys(), { addMissing: true });
}
