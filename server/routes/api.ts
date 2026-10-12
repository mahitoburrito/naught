import { Hono } from "hono";
import * as pty from "node-pty";
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, rmSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir, tmpdir } from "os";
import { exec as execCb, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execCb);
import type { Agent, AgentChangeSummary, AgentProfileConfig, AgentStatus, CheckpointSummary, TerminalCommandBlock } from "../types";
import {
  sessions,
  createSession,
  deleteSession,
  injectPluginDir,
  resolveAgentLaunchCommand,
  scanReposInDirectory,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  scheduleSessionTitleGeneration,
  getSessionShellLaunch,
  getSessionPtyEnvironment,
  attachSessionPty,
  installShellIntegration,
  startTrackedCommand,
  getTerminalSnapshot,
  resolveTerminalSplitWorkingDirectory,
  getTerminalShellCapabilities,
  getTerminalShellCompletions,
  getTerminalShellEnvironment,
  resetTerminalLifecycle,
  writeTerminalBlockCommand,
  updateTerminalBlock,
  clearTerminalHistory,
  listTerminalFindBlocks,
  readTerminalFindBlock,
  writeTerminalData,
  noteTerminalInput,
  getTerminalCommandQueue,
  dispatchSynchronizedTerminalCommand,
  enqueueTerminalCommand,
  editTerminalQueuedCommand,
  reorderTerminalQueuedCommand,
  removeTerminalQueuedCommand,
  clearPendingTerminalCommands,
  discardTerminalCommandQueue,
} from "../services/sessionManager";
import { TerminalCommandQueueError } from "../services/terminalCommandQueue";
import { loadState, savePersistedState, saveState, savePositions, getDataDir } from "../services/persistence";
import {
  loadConfig,
  saveConfig,
  fetchTeams,
  fetchMyTickets,
  searchTickets,
  fetchTicketByIdentifier,
  validateApiKey,
  getCurrentUser,
} from "../services/linear";
import {
  fetchGitHubIssues,
  fetchGitHubIssue,
  searchGitHubIssues,
  parseGitHubUrl,
} from "../services/github";
import {
  loadTitleGenerationConfig,
  saveTitleGenerationApiKey,
  generateTitleSortGroups,
  type TitleSortGroup,
  type TitleSortInput,
} from "../services/titleGenerator";
import {
  terminalAutomation,
  TerminalAutomationError,
} from "../services/terminalAutomation";
import { getTerminalSuggestionsAsync } from "../services/terminalSuggestions";
import { terminalFind, TerminalFindError } from "../services/terminalFind";
import { sendTerminalMessage } from "../services/terminalTransport";
import {
  applyAgentStatus,
  startAgentStatusTicker,
  statusSourceForHookEvent,
} from "../services/agentStatus";
import {
  createTerminalBlockShare,
  createTerminalSessionShare,
  terminalOutputToPlainText,
  type TerminalShareFormat,
  type TerminalShareOptions,
  type TerminalShareOutputMode,
  type TerminalSharePayload,
  type TerminalShareSession,
} from "../services/terminalSharing";
import { agentProfiles, AgentProfileError } from "../services/agentProfiles";
import { redactTerminalText } from "../services/terminalRedaction";
import {
  adaptAgentProfileCommand,
  buildAgentProfileRuntimePrompt,
  evaluateAgentProfileToolPermission,
  profileRuntimeManifest,
} from "../services/agentProfileRuntime";
import { readPackageScriptManifest } from "../services/terminalManifests";
import { execGit, execGitWithInput } from "../services/gitRuntime";
import { terminalRemoteManager } from "../services/terminalRemote";
import { buildDevboxLaunchCommand, getDevbox } from "../services/devboxes";
import type { DevboxConfig } from "../types";
import { terminalWorkspace, TerminalWorkspaceError } from "../services/terminalWorkspace";
import { terminalFiles, TerminalFilesError } from "../services/terminalFiles";
import { codeWorkspace, CodeWorkspaceError } from "../services/codeWorkspace";
import { terminalGit, TerminalGitError } from "../services/terminalGit";
import { terminalOsc52ClipboardAccess } from "../services/terminalOutputPolicy";

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}
function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const AGENT_STATUSES = new Set<AgentStatus>([
  "running",
  "waiting_input",
  "tool_calling",
  "idle",
  "disconnected",
  "error",
]);

/**
 * Plugin hooks report a few pseudo-statuses (`pre_tool`, `post_tool`) that the
 * caller maps to real ones, and anything unrecognised must not be able to put
 * a card into a state the UI has no rendering for.
 */
function normalizeAgentStatus(reported: unknown, fallback: AgentStatus): AgentStatus {
  return AGENT_STATUSES.has(reported as AgentStatus) ? (reported as AgentStatus) : fallback;
}

const SENSITIVE_TERMINAL_SHARE_CONFIRMATION = "share-sensitive-terminal-data";

function terminalShareOptions(c: any): TerminalShareOptions {
  const rawFormat = textValue(c.req.query("format")) || "markdown";
  const rawOutputMode = textValue(c.req.query("outputMode")) || "plain";
  if (!(["markdown", "text", "json"] as string[]).includes(rawFormat)) {
    throw new Error("format must be markdown, text, or json");
  }
  if (!(["plain", "ansi"] as string[]).includes(rawOutputMode)) {
    throw new Error("outputMode must be plain or ansi");
  }
  return {
    format: rawFormat as TerminalShareFormat,
    outputMode: rawOutputMode as TerminalShareOutputMode,
    includeOutput: c.req.query("includeOutput") !== "false",
  };
}

function terminalShareSession(sessionId: string, session: any): TerminalShareSession {
  return {
    sessionId,
    nodeId: session.nodeId,
    name: session.customName || session.agentName,
    agentName: session.agentName,
    cwd: session.cwd,
    createdAt: session.createdAt,
  };
}

function terminalShareResponse(c: any, payload: TerminalSharePayload) {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.req.query("download") === "true") {
    c.header("Content-Type", payload.contentType);
    c.header("Content-Disposition", `attachment; filename="${payload.filename}"`);
    return c.body(payload.content);
  }
  return c.json(payload);
}

function selectedTerminalShareBlocks(c: any, blocks: TerminalCommandBlock[]): TerminalCommandBlock[] {
  const raw = textValue(c.req.query("blockIds"));
  if (!raw) return blocks;
  const ids = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > 250 || ids.some((id) => id.length > 256)) {
    throw new Error("blockIds must contain 1 to 250 valid block identifiers");
  }
  const requested = new Set(ids);
  const selected = blocks.filter((block) => requested.has(block.id));
  if (selected.length !== requested.size) throw new Error("One or more selected terminal blocks were not found");
  return selected;
}
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
const logError = QUIET ? (..._args: any[]) => {} : console.error.bind(console);

export const apiRoutes = new Hono();

const AGENT_RULES_MAX_CHARS = 12000;

function getAgentRulesFile(): string {
  return join(getDataDir(), "agent-rules.json");
}

function loadAgentRules(): string {
  try {
    const file = getAgentRulesFile();
    if (!existsSync(file)) return "";
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed.rules === "string" ? parsed.rules.slice(0, AGENT_RULES_MAX_CHARS) : "";
  } catch {
    return "";
  }
}

function saveAgentRules(rules: string): string {
  const cleanRules = rules.slice(0, AGENT_RULES_MAX_CHARS);
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(
    getAgentRulesFile(),
    JSON.stringify({ rules: cleanRules, updatedAt: Date.now() }, null, 2),
  );
  return cleanRules;
}

function buildInitialPrompt(initialPrompt: unknown): string | undefined {
  const rules = loadAgentRules().trim();
  const starterPrompt =
    typeof initialPrompt === "string" ? initialPrompt.trim().slice(0, AGENT_RULES_MAX_CHARS) : "";
  const parts = [
    rules ? `Persistent OpenUI agent rules:\n${rules}` : "",
    starterPrompt,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n").slice(0, AGENT_RULES_MAX_CHARS) : undefined;
}

function buildTitlePrompt(initialPrompt: unknown): string | undefined {
  const starterPrompt =
    typeof initialPrompt === "string" ? initialPrompt.trim().slice(0, AGENT_RULES_MAX_CHARS) : "";
  return starterPrompt || undefined;
}

function writePrivateFile(path: string, content: string) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function writeAgentProfileRuntimeFiles(
  sessionId: string,
  profileId: string,
  profileVersion: number,
  config: AgentProfileConfig,
): { manifestPath: string; promptPath?: string; mcpConfigPath?: string; runtimePrompt?: string } {
  const directory = join(getDataDir(), "runtime-profiles");
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, `${sessionId}.json`);
  writePrivateFile(
    manifestPath,
    JSON.stringify(profileRuntimeManifest(profileId, profileVersion, config), null, 2),
  );

  const runtimePrompt = buildAgentProfileRuntimePrompt(profileId, profileVersion, config);
  let promptPath: string | undefined;
  if (runtimePrompt) {
    promptPath = join(directory, `${sessionId}.prompt.md`);
    writePrivateFile(promptPath, runtimePrompt);
  }

  let mcpConfigPath: string | undefined;
  if (config.mcpServers.length) {
    mcpConfigPath = join(directory, `${sessionId}.mcp.json`);
    const mcpServers = Object.fromEntries(config.mcpServers.map((server) => [
      server.name,
      server.url
        ? { type: "http", url: server.url }
        : process.platform === "win32"
          ? { type: "stdio", command: "powershell.exe", args: ["-NoLogo", "-Command", server.command] }
          : { type: "stdio", command: "/bin/sh", args: ["-lc", server.command] },
    ]));
    writePrivateFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
  }
  return { manifestPath, promptPath, mcpConfigPath, runtimePrompt };
}

function newSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

async function startSessionFromApiInput(
  input: any,
  options: { persist?: boolean; sessionId?: string; nodeId?: string; workspace?: "tab" | "defer" } = {},
) {
  let agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
  let agentName = typeof input?.agentName === "string" ? input.agentName.trim() : "";
  let command = typeof input?.command === "string" ? input.command.trim() : "";
  let customColor = input.customColor;
  let combinedInitialPrompt = input.initialPrompt;
  let agentProfileId: string | undefined;
  let agentProfileVersion: number | undefined;
  let profileIcon: string | undefined;
  let agentFallbackCommands: string[] | undefined;
  let resolvedProfileConfig: AgentProfileConfig | undefined;
  let agentRuntimeManifestPath: string | undefined;
  const profileReference = input?.agentProfile && typeof input.agentProfile === "object"
    ? { id: textValue(input.agentProfile.id), version: Number.isSafeInteger(input.agentProfile.version) ? input.agentProfile.version : undefined }
    : input?.agentProfileId
      ? { id: textValue(input.agentProfileId), version: Number.isSafeInteger(input.agentProfileVersion) ? input.agentProfileVersion : undefined }
      : agentId.startsWith("profile:")
        ? { id: agentId.slice("profile:".length), version: undefined }
      : null;
  if (profileReference?.id) {
    const resolved = agentProfiles.resolve(profileReference);
    const config = resolved.version.config;
    agentProfileId = resolved.profile.id;
    agentProfileVersion = resolved.version.version;
    resolvedProfileConfig = config;
    agentId = `profile:${resolved.profile.id}`;
    agentName = config.name;
    command = config.command;
    customColor = customColor || config.color;
    profileIcon = config.icon;
    agentFallbackCommands = config.fallbackCommands;
    combinedInitialPrompt = [config.initialPrompt, input.initialPrompt].filter(Boolean).join("\n\n") || undefined;
  }
  if (!agentId || !agentName || (!command && agentId !== "shell")) {
    throw new Error("agentId, agentName, and command are required unless agentId is shell");
  }

  const sessionId = options.sessionId || newSessionId();
  const nodeId = options.nodeId || input.nodeId || `node-${sessionId}`;
  if (resolvedProfileConfig && agentProfileId && agentProfileVersion) {
    const runtime = writeAgentProfileRuntimeFiles(
      sessionId,
      agentProfileId,
      agentProfileVersion,
      resolvedProfileConfig,
    );
    agentRuntimeManifestPath = runtime.manifestPath;
    const adaptedCommand = adaptAgentProfileCommand(command, resolvedProfileConfig, runtime);
    command = adaptedCommand;
  }
  const workingDir = input.cwd || getLaunchCwd();

  // Running on a devbox wraps the agent command in ssh. The wrapping happens
  // here rather than in the client so the quoting stays in one tested place,
  // and so the local cwd stays a real local directory — pty.spawn needs one,
  // and the ssh client has to run somewhere.
  let devbox: DevboxConfig | null = null;
  if (input.devboxId) {
    devbox = getDevbox(input.devboxId);
    if (!devbox) throw new Error("Devbox not found.");
    command = buildDevboxLaunchCommand(devbox, command, input.remotePath);
  }

  const starterTitlePrompt = buildTitlePrompt(input.initialPrompt);
  const linearConfig = loadConfig();
  let launchCheckpoint: CheckpointSummary | undefined;

  const result = await createSession({
    sessionId,
    agentId,
    agentName,
    command,
    cwd: workingDir,
    nodeId,
    devboxId: devbox?.id,
    remotePath: devbox ? (input.remotePath || devbox.defaultPath) : undefined,
    customName: input.customName,
    customColor,
    ticketId: input.ticketId,
    ticketTitle: input.ticketTitle,
    ticketUrl: input.ticketUrl,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    createWorktreeFlag: input.createWorktree,
    ticketPromptTemplate: linearConfig.ticketPromptTemplate,
    initialPrompt: buildInitialPrompt(combinedInitialPrompt),
    autoCareful: linearConfig.autoCareful,
    multiRepoMode: input.multiRepoMode,
    additionalRepos: input.additionalRepos,
    agentProfileId,
    agentProfileVersion,
    agentPermissionPolicy: resolvedProfileConfig?.permissionPolicy,
    agentAllowedTools: resolvedProfileConfig?.tools,
    agentRuntimeManifestPath,
    agentModel: resolvedProfileConfig?.model,
    agentFallbackCommands,
    registerWorkspace: options.workspace !== "defer",
    beforeStart: async (finalCwd) => {
      try {
        const root = await gitRoot(finalCwd).catch(() => null);
        if (!root) return;
        const checkpoint = await createGitCheckpoint(
          root,
          `Before ${input.customName || agentName} session`,
          { source: "session-launch", sessionId, nodeId },
        );
        launchCheckpoint = summarizeCheckpoint(checkpoint);
      } catch (checkpointError: any) {
        logError(`[api] launch checkpoint failed (session=${sessionId}): ${checkpointError.message}`);
      }
    },
  });

  if (launchCheckpoint) result.session.launchCheckpoint = launchCheckpoint;
  if (profileIcon) result.session.icon = profileIcon;
  if (input.position && Number.isFinite(Number(input.position.x)) && Number.isFinite(Number(input.position.y))) {
    result.session.position = { x: Number(input.position.x), y: Number(input.position.y) };
  }
  if (options.persist !== false) saveState(sessions);
  if (starterTitlePrompt) scheduleSessionTitleGeneration(sessionId, starterTitlePrompt);
  return {
    sessionId,
    nodeId,
    cwd: result.cwd,
    gitBranch: result.gitBranch,
    launchCheckpoint,
    terminalCols: result.session.terminalCols,
    terminalRows: result.session.terminalRows,
  };
}

function terminalAutomationFailure(error: unknown): { message: string; status: 400 | 404 | 409 | 500 } {
  if (error instanceof TerminalAutomationError) {
    const status = error.status === 404 || error.status === 409 ? error.status : 400;
    return { message: error.message, status };
  }
  return {
    message: error instanceof Error ? error.message : "Terminal automation failed",
    status: 500,
  };
}

function terminalWorkspaceFailure(error: unknown): { message: string; status: 400 | 404 | 409 | 500 } {
  if (error instanceof TerminalWorkspaceError) {
    const status = error.status === 404 || error.status === 409 ? error.status : 400;
    return { message: error.message, status };
  }
  return {
    message: error instanceof Error ? error.message : "Terminal workspace operation failed",
    status: 500,
  };
}

function expectedWorkspaceRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TerminalWorkspaceError("expectedRevision must be a nonnegative integer");
  }
  return value;
}

function collectTerminalWorkspaceSessionIds(node: any, output: string[] = []): string[] {
  if (node?.type === "pane" && typeof node.sessionId === "string") output.push(node.sessionId);
  else if (node?.type === "split" && Array.isArray(node.children)) {
    for (const child of node.children) collectTerminalWorkspaceSessionIds(child, output);
  }
  return output;
}

const SORT_STATUS_PRIORITY: Record<string, number> = {
  waiting_input: 0,
  error: 1,
  running: 2,
  tool_calling: 3,
  creating: 4,
  idle: 5,
  disconnected: 6,
};

const TITLE_SORT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "auto",
  "build",
  "can",
  "code",
  "coding",
  "do",
  "fix",
  "for",
  "help",
  "in",
  "investigation",
  "make",
  "of",
  "on",
  "please",
  "review",
  "session",
  "task",
  "the",
  "to",
  "update",
  "work",
]);

const TITLE_SORT_CHANNEL_TOKENS = new Set([
  "bookface",
  "email",
  "emails",
  "github",
  "linear",
  "linkedin",
  "notion",
  "slack",
  "twitter",
  "x",
  "yc",
]);

const TITLE_SORT_OUTBOUND_DIRECT_TOKENS = new Set([
  "lead",
  "leads",
  "outbound",
  "outreach",
  "prospect",
  "prospecting",
  "prospects",
  "reachout",
  "sales",
]);

const TITLE_SORT_OUTBOUND_CONTEXT_TOKENS = new Set([
  "batchmate",
  "batchmates",
  "companies",
  "company",
  "contact",
  "contacts",
  "customer",
  "customers",
  "dm",
  "dms",
  "founder",
  "founders",
  "intro",
  "intros",
  "list",
  "lists",
  "message",
  "messages",
  "messaging",
  "partner",
  "partners",
]);

// Any one of these alone marks a session as IDE/OpenUI work.
const TITLE_SORT_IDE_DIRECT_TOKENS = new Set([
  "ide",
  "openui",
  "openui-desktop",
  "sidebar",
  "keybinding",
  "keybindings",
  "statusline",
]);

// IDE surfaces that need a companion tweak-verb to count (too generic alone).
const TITLE_SORT_IDE_SURFACE_TOKENS = new Set([
  "browser",
  "canvas",
  "dock",
  "editor",
  "notification",
  "notifications",
  "pane",
  "panel",
  "sessions",
  "terminal",
  "title",
  "titles",
  "toolbar",
]);

const TITLE_SORT_IDE_TWEAK_TOKENS = new Set([
  "clean",
  "cleanup",
  "cluster",
  "clusters",
  "clustering",
  "dock",
  "flow",
  "flows",
  "group",
  "grouped",
  "grouping",
  "layout",
  "parse",
  "parsed",
  "parsing",
  "polish",
  "polishing",
  "rename",
  "renaming",
  "sort",
  "sorted",
  "sorting",
  "theme",
  "titling",
  "tweak",
  "tweaking",
  "tweaks",
  "ui",
  "ux",
]);

const TITLE_SORT_EXPERIMENT_TOKENS = new Set([
  "ab-test",
  "ab-tests",
  "eval",
  "evals",
  "experiment",
  "experimentation",
  "experimentations",
  "experiments",
]);

function titleSortPriority(item: TitleSortInput): number {
  return SORT_STATUS_PRIORITY[item.status || ""] ?? 99;
}

function titleTokens(value: string): string[] {
  const ticket = value.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  const words = value
    .toLowerCase()
    .replace(/\bhttps?:\/\/[^\s]+/g, " local-url ")
    .replace(/\breach\s+out\b/g, " reachout ")
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && word.length > 1 && !TITLE_SORT_STOP_WORDS.has(word));
  return ticket ? [ticket[0].toLowerCase(), ...words] : words;
}

function allTitleSortText(item: TitleSortInput): string {
  return [
    item.title,
    item.ticketTitle,
    ...(item.promptHistory || []),
  ]
    .filter(Boolean)
    .join(" ");
}

function titleCaseSortToken(token: string): string {
  const acronym = {
    api: "API",
    cli: "CLI",
    pr: "PR",
    sdk: "SDK",
    ui: "UI",
    yc: "YC",
  }[token];
  if (acronym) return acronym;
  return /^[a-z]+-\d+$/i.test(token)
    ? token.toUpperCase()
    : token.charAt(0).toUpperCase() + token.slice(1);
}

function labelFromTokens(tokens: string[], fallback: string): string {
  const label = tokens
    .slice(0, 3)
    .map(titleCaseSortToken)
    .join(" ");
  return label || fallback || "Related Work";
}

function hasAny(tokenSet: Set<string>, wanted: Set<string>): boolean {
  for (const token of wanted) if (tokenSet.has(token)) return true;
  return false;
}

// Local (no-LLM) intent grouping for session cards. Sessions cluster by the
// content of the work — the durable intent — not by whichever words happen to
// lead their titles. Each rule below is a content signature: either a direct
// token that alone claims the session, or a surface+verb pair for tokens too
// generic on their own. Rules are checked in order; first match wins. Sessions
// matching no rule fall through to ticket-id / repo+token keying.
// NOTE: TITLE_SORT_STOP_WORDS are stripped before matching — rules must not
// rely on filtered words like "fix", "session", "app", or "review".
function semanticTitleSortGroup(tokens: string[]): { key: string; label: string; reason: string } | null {
  const tokenSet = new Set(tokens);

  // Outbound: prospecting/outreach work belongs together regardless of the
  // channel (LinkedIn, Bookface, email, ...) it flows through.
  const hasDirectOutbound = hasAny(tokenSet, TITLE_SORT_OUTBOUND_DIRECT_TOKENS);
  const hasChannel = hasAny(tokenSet, TITLE_SORT_CHANNEL_TOKENS);
  const hasOutboundContext = hasAny(tokenSet, TITLE_SORT_OUTBOUND_CONTEXT_TOKENS);
  if (hasDirectOutbound || (hasChannel && hasOutboundContext)) {
    return {
      key: "intent:outbound",
      label: tokenSet.has("founder") || tokenSet.has("founders") || tokenSet.has("batchmate") || tokenSet.has("batchmates")
        ? "Founder Outreach"
        : "Outbound",
      reason: "Local intent fallback grouped outbound work across channels",
    };
  }

  // Experiments: setting up, running, or managing experimentation/evals.
  if (hasAny(tokenSet, TITLE_SORT_EXPERIMENT_TOKENS)) {
    return {
      key: "intent:experiments",
      label: "Experiments",
      reason: "Local intent fallback grouped experimentation work",
    };
  }

  // IDE tweaks: anything about tweaking OpenUI itself — sidebar, session
  // titles/grouping, notifications, browser dock, terminal, themes. One
  // group whether the session says "ide" outright or pairs an IDE surface
  // with a tweak verb ("session titles sorting", "notification parsing").
  const hasDirectIde = hasAny(tokenSet, TITLE_SORT_IDE_DIRECT_TOKENS);
  const hasIdeSurface = hasAny(tokenSet, TITLE_SORT_IDE_SURFACE_TOKENS);
  const hasIdeTweak = hasAny(tokenSet, TITLE_SORT_IDE_TWEAK_TOKENS);
  if (hasDirectIde || (hasIdeSurface && hasIdeTweak)) {
    return {
      key: "intent:ide-tweaks",
      label: "IDE Tweaks",
      reason: "Local intent fallback grouped IDE/OpenUI tweaking work",
    };
  }

  return null;
}

function fallbackTitleSortGroups(items: TitleSortInput[]): TitleSortGroup[] {
  const sorted = [...items].sort((a, b) => {
    const priority = titleSortPriority(a) - titleSortPriority(b);
    if (priority !== 0) return priority;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  const groups = new Map<string, TitleSortGroup>();
  for (const item of sorted) {
    const tokens = titleTokens(allTitleSortText(item));
    const repoToken = (item.repo || "").split("/").filter(Boolean).pop()?.toLowerCase();
    const semanticGroup = semanticTitleSortGroup(tokens);
    const keyTokens = tokens.filter((token) => !TITLE_SORT_CHANNEL_TOKENS.has(token));
    const key =
      semanticGroup?.key ||
      tokens.find((token) => /^[a-z]+-\d+$/i.test(token)) ||
      (repoToken && keyTokens[0] ? `${repoToken}:${keyTokens[0]}` : keyTokens.slice(0, 2).join(":")) ||
      item.nodeId;
    const existing = groups.get(key);
    if (existing) {
      existing.nodeIds.push(item.nodeId);
    } else {
      groups.set(key, {
        label: semanticGroup?.label || labelFromTokens(keyTokens.length > 0 ? keyTokens : tokens, item.title),
        reason: semanticGroup?.reason || "Local title-token intent fallback",
        nodeIds: [item.nodeId],
      });
    }
  }

  return Array.from(groups.values());
}

function validateTitleSortGroups(
  groups: TitleSortGroup[] | null,
  items: TitleSortInput[],
): TitleSortGroup[] | null {
  if (!groups || groups.length === 0) return null;
  const allowedIds = new Set(items.map((item) => item.nodeId));
  const seen = new Set<string>();
  const cleaned: TitleSortGroup[] = [];

  for (const group of groups) {
    const nodeIds = group.nodeIds.filter((id) => allowedIds.has(id) && !seen.has(id));
    if (nodeIds.length === 0) continue;
    nodeIds.forEach((id) => seen.add(id));
    cleaned.push({
      label: group.label?.trim() || "Related Work",
      reason: group.reason,
      nodeIds,
    });
  }

  for (const item of items) {
    if (!seen.has(item.nodeId)) {
      cleaned.push({ label: item.title || "Related Work", nodeIds: [item.nodeId] });
    }
  }

  return cleaned.length > 0 ? cleaned : null;
}

apiRoutes.get("/config", (c) => {
  return c.json({
    launchCwd: getLaunchCwd(),
    dataDir: getDataDir(),
    terminalOsc52ClipboardAccess: terminalOsc52ClipboardAccess(),
  });
});

apiRoutes.get("/agent-rules", (c) => {
  return c.json({ rules: loadAgentRules(), maxChars: AGENT_RULES_MAX_CHARS });
});

apiRoutes.post("/agent-rules", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rules = saveAgentRules(typeof body.rules === "string" ? body.rules : "");
  return c.json({ rules, maxChars: AGENT_RULES_MAX_CHARS });
});

apiRoutes.get("/title-generation/config", (c) => {
  return c.json(loadTitleGenerationConfig());
});

apiRoutes.post("/title-generation/config", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.apiKey !== undefined) {
    saveTitleGenerationApiKey(typeof body.apiKey === "string" ? body.apiKey : "");
  }
  return c.json(loadTitleGenerationConfig());
});

// Browse directories for file picker
apiRoutes.get("/browse", (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = resolve(path, "..");

    return c.json({
      current: path,
      parent: parentPath !== path ? parentPath : null,
      directories,
    });
  } catch (e: any) {
    return c.json({ error: e.message, current: path }, 400);
  }
});

// Scan a directory for child git repositories
apiRoutes.get("/scan-repos", async (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const repos = await scanReposInDirectory(path);
    return c.json({ repos });
  } catch (e: any) {
    return c.json({ error: e.message, repos: [] }, 400);
  }
});

// Markdown file discovery and reading
const MD_EXTS = new Set(["md", "markdown", "mdx"]);
const MD_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MD_MAX_DEPTH = 4;
const MD_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "coverage", "__pycache__", ".cache", "release", ".venv", "venv",
]);

function expandPath(p: string): string {
  if (p.startsWith("~")) p = p.replace("~", homedir());
  return resolve(p);
}

// ============ Project Tasks ============
// IDE-style task discovery for package scripts. Discovery reads package metadata
// only; scripts are run later through the normal terminal/session path.

apiRoutes.get("/tasks/scripts", (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const requestedPath = expandPath(queryPath);

  if (!existsSync(requestedPath)) {
    return c.json({ error: "Path not found", root: requestedPath, scripts: [] }, 404);
  }

  try {
    const manifest = readPackageScriptManifest(requestedPath);
    if (!manifest) {
      return c.json({ root: requestedPath, packageJsonPath: null, packageManager: "npm", scripts: [] });
    }
    return c.json(manifest);
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to parse package.json", root: requestedPath, scripts: [] }, 400);
  }
});

function isMarkdownPath(p: string): boolean {
  const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase() : "";
  return MD_EXTS.has(ext);
}

function walkMarkdown(
  root: string,
  results: { name: string; path: string; size: number; modified: number }[],
  depth: number,
): void {
  if (depth > MD_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (MD_SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(full, results, depth + 1);
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      try {
        const st = statSync(full);
        results.push({
          name: entry.name,
          path: full,
          size: st.size,
          modified: st.mtimeMs,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

apiRoutes.get("/files/list", (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const root = expandPath(queryPath);

  if (!existsSync(root)) {
    return c.json({ error: "Path not found", root }, 404);
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    return c.json({ error: "Not a directory", root }, 400);
  }

  const files: { name: string; path: string; size: number; modified: number }[] = [];
  walkMarkdown(root, files, 0);
  files.sort((a, b) => b.modified - a.modified);

  return c.json({ root, files });
});

apiRoutes.get("/files/read", (c) => {
  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path required" }, 400);

  const filePath = expandPath(queryPath);

  if (!isMarkdownPath(filePath)) {
    return c.json({ error: "Only markdown files are readable" }, 400);
  }

  if (!existsSync(filePath)) {
    return c.json({ error: "File not found", path: filePath }, 404);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return c.json({ error: "Not a file" }, 400);
  }
  if (stat.size > MD_MAX_BYTES) {
    return c.json({ error: `File too large (>${MD_MAX_BYTES} bytes)` }, 400);
  }

  try {
    const content = readFileSync(filePath, "utf8");
    return c.json({
      path: filePath,
      name: filePath.split("/").pop() || filePath,
      size: stat.size,
      modified: stat.mtimeMs,
      content,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Read failed" }, 500);
  }
});

// Session-scoped file context uses the same contract for local and
// instrumented SSH shells. A remote session never falls through to the local
// filesystem while its command channel is unavailable.
apiRoutes.post("/sessions/:sessionId/files/read", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await terminalFiles.readSessionFiles(sessionId, session, {
      files: body.files,
      maxFileBytes: body.maxFileBytes,
      maxBatchBytes: body.maxBatchBytes,
      includeBinary: body.includeBinary === true,
    });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    if (error instanceof TerminalFilesError) return c.json({ error: error.message }, error.status as any);
    return c.json({ error: error?.message || "File read failed" }, 500);
  }
});

apiRoutes.get("/sessions/:sessionId/files/tree", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  try {
    const result = await codeWorkspace.listSessionFiles(sessionId, session);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    if (error instanceof CodeWorkspaceError) return c.json({ error: error.message }, error.status as any);
    return c.json({ error: error?.message || "Workspace file list failed" }, 500);
  }
});

apiRoutes.put("/sessions/:sessionId/files/write", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await codeWorkspace.writeSessionFile(sessionId, session, {
      path: body.path,
      content: body.content,
      expectedModified: body.expectedModified,
    });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    if (error instanceof CodeWorkspaceError) return c.json({ error: error.message }, error.status as any);
    return c.json({ error: error?.message || "File save failed" }, 500);
  }
});

apiRoutes.post("/sessions/:sessionId/files/apply-patch", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await terminalFiles.applySessionPatch(sessionId, session, {
      patch: body.patch,
      validateOnly: body.validateOnly,
    });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    if (error instanceof TerminalFilesError) return c.json({ error: error.message }, error.status as any);
    return c.json({ error: error?.message || "Patch application failed" }, 500);
  }
});

function sessionGitEnvironment(sessionId: string): NodeJS.ProcessEnv {
  const shellEnvironment = getTerminalShellEnvironment(sessionId) || {};
  return terminalRemoteManager.isConnected(sessionId)
    ? { ...shellEnvironment }
    : { ...process.env, ...shellEnvironment };
}

function terminalGitErrorResponse(c: any, error: any, fallback: string) {
  if (error instanceof TerminalGitError) {
    return c.json({ error: error.message, code: error.code, details: error.details }, error.status as any);
  }
  return c.json({ error: error?.message || fallback, code: "internal" }, 500);
}

apiRoutes.get("/sessions/:sessionId/git/status", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  try {
    const result = await terminalGit.statusSession(sessionId, session, sessionGitEnvironment(sessionId));
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "Git status failed");
  }
});

apiRoutes.get("/sessions/:sessionId/git/diff", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  try {
    const result = await terminalGit.diffSession(sessionId, session, {
      file: c.req.query("file"),
      untracked: c.req.query("untracked") === "1",
    }, sessionGitEnvironment(sessionId));
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "Git diff failed");
  }
});

apiRoutes.post("/sessions/:sessionId/git/discard", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await terminalGit.discardSession(sessionId, session, {
      scope: body.scope,
      file: body.file,
      hunkIndex: body.hunkIndex,
    }, sessionGitEnvironment(sessionId)));
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "Git discard failed");
  }
});

apiRoutes.post("/sessions/:sessionId/git/commit", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await terminalGit.commitSession(sessionId, session, {
      message: body.message,
      includeUnstaged: body.includeUnstaged,
      branch: body.branch,
      mode: body.mode,
    }, sessionGitEnvironment(sessionId)));
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "Git commit failed");
  }
});

apiRoutes.post("/sessions/:sessionId/git/push", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await terminalGit.pushSession(
      sessionId,
      session,
      { branch: body.branch },
      sessionGitEnvironment(sessionId),
    ));
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "Git push failed");
  }
});

apiRoutes.get("/sessions/:sessionId/git/pr", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  try {
    const result = await terminalGit.viewPrSession(sessionId, session, sessionGitEnvironment(sessionId));
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "GitHub PR lookup failed");
  }
});

apiRoutes.post("/sessions/:sessionId/git/pr", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await terminalGit.createPrSession(
      sessionId,
      session,
      { branch: body.branch },
      sessionGitEnvironment(sessionId),
    ));
  } catch (error: any) {
    return terminalGitErrorResponse(c, error, "GitHub PR creation failed");
  }
});

// ============ Git Diff ============
// Reviewing what an agent just wrote: `git diff` on a repo, per-file.

const GIT_MAX_BUFFER = 20 * 1024 * 1024; // 20MB — handles large diffs

// Resolve the git repo root for a path. Returns null if not in a repo.
async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolveGitFile(root: string, file: string): { absPath: string; relPath: string } {
  const absPath = resolve(root, file);
  const relPath = relative(root, absPath);

  if (!relPath || relPath.startsWith("..") || resolve(root, relPath) !== absPath) {
    throw new Error("File must be inside the git repository");
  }

  return { absPath, relPath };
}

async function gitHasHead(root: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--verify", "HEAD"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function gitFileExistsInHead(root: string, relPath: string): Promise<boolean> {
  try {
    await execGit(["cat-file", "-e", `HEAD:${relPath}`], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function discardGitFile(root: string, file: string): Promise<void> {
  const { absPath, relPath } = resolveGitFile(root, file);
  const { stdout } = await execGit(["status", "--porcelain", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });
  const status = stdout.slice(0, 2);

  if (status === "??") {
    rmSync(absPath, { force: true, recursive: true });
    return;
  }

  const hasHead = await gitHasHead(root);
  const existsInHead = hasHead && (await gitFileExistsInHead(root, relPath));

  if (existsInHead) {
    await execGit(["restore", "--source=HEAD", "--staged", "--worktree", "--", relPath], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return;
  }

  await execGit(["reset", "HEAD", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  }).catch(() => undefined);
  rmSync(absPath, { force: true, recursive: true });
}

function extractHunkPatch(diff: string, hunkIndex: number): string | null {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null;

  const lines = diff.split("\n");
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTrailingSplitLine = i === lines.length - 1 && line === "";
    if (isTrailingSplitLine) continue;

    if (line.startsWith("@@")) {
      current = [line];
      hunks.push(current);
      continue;
    }

    if (!current) {
      if (line) header.push(line);
      continue;
    }

    current.push(line);
  }

  const selected = hunks[hunkIndex];
  if (!selected || header.length === 0) return null;
  return `${[...header, ...selected].join("\n")}\n`;
}

async function discardGitHunk(root: string, file: string, hunkIndex: number): Promise<void> {
  const { relPath } = resolveGitFile(root, file);
  const { stdout: statusOut } = await execGit(["status", "--porcelain", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });

  if (statusOut.slice(0, 2) === "??") {
    throw new Error("Rejecting individual hunks is only available for tracked files");
  }

  const { stdout: diff } = await execGit(
    ["diff", "--no-color", "HEAD", "--", relPath],
    { cwd: root, maxBuffer: GIT_MAX_BUFFER },
  );
  const patch = extractHunkPatch(diff, hunkIndex);
  if (!patch) {
    throw new Error("Hunk not found");
  }

  await execGitWithInput(["apply", "--reverse", "--cached", "--whitespace=nowarn"], patch, {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  }).catch(() => undefined);
  await execGitWithInput(["apply", "--reverse", "--whitespace=nowarn"], patch, {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

interface GitChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
  mtime: number;
}

async function getGitChangedFiles(root: string): Promise<GitChangedFile[]> {
  // `git status --porcelain` gives us status letters incl. untracked (??).
  const { stdout: statusOut } = await execGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });

  // `git diff --numstat HEAD` gives added/removed counts for tracked changes.
  // (Falls back gracefully on a repo with no commits.)
  const numstat: Record<string, { added: number; removed: number }> = {};
  try {
    const { stdout } = await execGit(["diff", "--numstat", "HEAD"], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, ...rest] = line.split("\t");
      const file = rest.join("\t");
      numstat[file] = {
        added: added === "-" ? 0 : parseInt(added, 10) || 0,
        removed: removed === "-" ? 0 : parseInt(removed, 10) || 0,
      };
    }
  } catch {
    // no HEAD yet — leave counts at 0
  }

  const files: GitChangedFile[] = [];
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain: XY<space>path  (path may be quoted / renamed "old -> new")
    const xy = line.slice(0, 2);
    let path = line.slice(3).trim();
    const untracked = xy === "??";
    if (path.includes(" -> ")) path = path.split(" -> ")[1];
    path = path.replace(/^"|"$/g, "");
    const counts = numstat[path] || { added: 0, removed: 0 };
    let mtime = 0;
    try {
      mtime = statSync(join(root, path)).mtimeMs;
    } catch {
      // file no longer on disk (deleted) — leave at 0
    }
    files.push({
      path,
      status: xy.trim() || (untracked ? "?" : "M"),
      added: counts.added,
      removed: counts.removed,
      untracked,
      mtime,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function buildCommitMessage(files: GitChangedFile[]): { summary: string; commitMessage: string } {
  if (files.length === 0) {
    return {
      summary: "No uncommitted changes.",
      commitMessage: "",
    };
  }

  const added = files.filter((file) => file.untracked || file.status.includes("A")).length;
  const deleted = files.filter((file) => file.status.includes("D")).length;
  const modified = files.length - added - deleted;
  const directories = Array.from(
    new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean)),
  ).slice(0, 3);

  const verb =
    added > 0 && modified === 0 && deleted === 0
      ? "add"
      : deleted > 0 && modified === 0 && added === 0
      ? "remove"
      : "update";
  const scope = directories.length === 1 ? `(${directories[0]})` : "";
  const subject =
    files.length === 1
      ? `${verb}${scope}: ${files[0].path}`
      : `${verb}${scope}: ${files.length} files`;

  const summary = [
    `${files.length} changed file${files.length === 1 ? "" : "s"}`,
    modified > 0 ? `${modified} modified` : "",
    added > 0 ? `${added} added` : "",
    deleted > 0 ? `${deleted} deleted` : "",
  ].filter(Boolean).join(", ");

  const body = files
    .slice(0, 8)
    .map((file) => `- ${file.path}${file.added || file.removed ? ` (+${file.added}/-${file.removed})` : ""}`)
    .join("\n");

  return {
    summary,
    commitMessage: body ? `${subject}\n\n${body}` : subject,
  };
}

interface GitCheckpointFile {
  path: string;
  exists: boolean;
  contentBase64?: string;
}

interface GitCheckpoint {
  id: string;
  repoRoot: string;
  name: string;
  createdAt: number;
  files: GitCheckpointFile[];
  source?: "manual" | "session-launch";
  sessionId?: string;
  nodeId?: string;
}

function getCheckpointsFile(): string {
  return join(getDataDir(), "checkpoints.json");
}

function loadCheckpoints(): GitCheckpoint[] {
  try {
    const file = getCheckpointsFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((checkpoint) => {
      return (
        checkpoint &&
        typeof checkpoint.id === "string" &&
        typeof checkpoint.repoRoot === "string" &&
        typeof checkpoint.name === "string" &&
        typeof checkpoint.createdAt === "number" &&
        Array.isArray(checkpoint.files)
      );
    });
  } catch {
    return [];
  }
}

function saveCheckpoints(checkpoints: GitCheckpoint[]): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(getCheckpointsFile(), JSON.stringify(checkpoints.slice(0, 100), null, 2));
}

function summarizeCheckpoint(checkpoint: GitCheckpoint): CheckpointSummary {
  return {
    id: checkpoint.id,
    repoRoot: checkpoint.repoRoot,
    name: checkpoint.name,
    createdAt: checkpoint.createdAt,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      exists: file.exists,
    })),
    source: checkpoint.source,
    sessionId: checkpoint.sessionId,
    nodeId: checkpoint.nodeId,
  };
}

async function createGitCheckpoint(
  root: string,
  name?: string,
  metadata: Pick<GitCheckpoint, "source" | "sessionId" | "nodeId"> = {},
): Promise<GitCheckpoint> {
  const changedFiles = await getGitChangedFiles(root);
  const files: GitCheckpointFile[] = [];

  for (const changedFile of changedFiles) {
    const { absPath, relPath } = resolveGitFile(root, changedFile.path);
    const exists = existsSync(absPath);
    if (!exists) {
      files.push({ path: relPath, exists: false });
      continue;
    }

    const stat = statSync(absPath);
    if (!stat.isFile()) {
      files.push({ path: relPath, exists: false });
      continue;
    }

    files.push({
      path: relPath,
      exists: true,
      contentBase64: readFileSync(absPath).toString("base64"),
    });
  }

  const checkpoint: GitCheckpoint = {
    id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    repoRoot: root,
    name: name?.trim().slice(0, 80) || `Checkpoint ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    files,
    ...metadata,
  };

  const existing = loadCheckpoints();
  const rest = existing.filter((item) => item.repoRoot !== root);
  const repoCheckpoints = existing.filter((item) => item.repoRoot === root).slice(0, 19);
  saveCheckpoints([checkpoint, ...repoCheckpoints, ...rest]);
  return checkpoint;
}

async function restoreGitCheckpoint(root: string, checkpointId: string): Promise<GitCheckpoint> {
  const checkpoint = loadCheckpoints().find((item) => item.id === checkpointId && item.repoRoot === root);
  if (!checkpoint) {
    throw new Error("Checkpoint not found for this repository");
  }

  const baselinePaths = new Set(checkpoint.files.map((file) => file.path));
  const currentFiles = await getGitChangedFiles(root);

  for (const currentFile of currentFiles) {
    if (!baselinePaths.has(currentFile.path)) {
      await discardGitFile(root, currentFile.path);
    }
  }

  for (const file of checkpoint.files) {
    const { absPath, relPath } = resolveGitFile(root, file.path);
    await execGit(["reset", "HEAD", "--", relPath], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    }).catch(() => undefined);

    if (!file.exists) {
      rmSync(absPath, { force: true, recursive: true });
      continue;
    }

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, Buffer.from(file.contentBase64 || "", "base64"));
  }

  return checkpoint;
}

apiRoutes.get("/checkpoints", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);
  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  const checkpoints = loadCheckpoints()
    .filter((checkpoint) => checkpoint.repoRoot === root)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(summarizeCheckpoint);

  return c.json({ root, checkpoints });
});

apiRoutes.post("/checkpoints", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const name = body.name as string | undefined;

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const checkpoint = await createGitCheckpoint(root, name);
    return c.json({ root, checkpoint: summarizeCheckpoint(checkpoint) });
  } catch (e: any) {
    logError(`[api] checkpoint create failed (repo=${root}): ${e.message}`);
    return c.json({ error: e.message || "Failed to create checkpoint" }, 500);
  }
});

apiRoutes.post("/checkpoints/:checkpointId/restore", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const checkpointId = c.req.param("checkpointId");

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const checkpoint = await restoreGitCheckpoint(root, checkpointId);
    return c.json({ ok: true, root, checkpoint: summarizeCheckpoint(checkpoint) });
  } catch (e: any) {
    logError(`[api] checkpoint restore failed (repo=${root}, checkpoint=${checkpointId}): ${e.message}`);
    return c.json({ error: e.message || "Failed to restore checkpoint" }, 500);
  }
});

apiRoutes.delete("/checkpoints/:checkpointId", async (c) => {
  const repoQuery = c.req.query("path");
  const checkpointId = c.req.param("checkpointId");

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  const before = loadCheckpoints();
  const after = before.filter((checkpoint) => !(checkpoint.id === checkpointId && checkpoint.repoRoot === root));
  saveCheckpoints(after);
  return c.json({ ok: true, root, deleted: before.length !== after.length });
});

// List changed files in the working tree (unstaged + staged + untracked),
// each annotated with a status letter and added/removed line counts.
apiRoutes.get("/diff/files", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);

  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  try {
    // Current branch (best-effort).
    let branch = "";
    try {
      const r = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
      branch = r.stdout.trim();
    } catch {
      // detached HEAD or empty repo
    }

    const files = await getGitChangedFiles(root);
    return c.json({ root, branch, files });
  } catch (e: any) {
    logError(`[api] git diff files failed (cwd=${root}): ${e.message}`);
    return c.json({ error: e.message || "git diff failed" }, 500);
  }
});

apiRoutes.get("/diff/summary", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);

  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  try {
    const files = await getGitChangedFiles(root);
    return c.json({ root, files, ...buildCommitMessage(files) });
  } catch (e: any) {
    logError(`[api] git diff summary failed (cwd=${root}): ${e.message}`);
    return c.json({ error: e.message || "git diff summary failed" }, 500);
  }
});

// Unified diff for a single file. Untracked files are shown as all-added
// (diff against /dev/null) so new files render in the viewer too.
apiRoutes.get("/diff/file", async (c) => {
  const repoQuery = c.req.query("path");
  const fileQuery = c.req.query("file");
  if (!repoQuery || !fileQuery) {
    return c.json({ error: "path (repo) and file are required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  const untracked = c.req.query("untracked") === "1";

  try {
    const { relPath: file } = resolveGitFile(root, fileQuery);
    let diff: string;
    if (untracked) {
      // New file — diff against the empty tree so the whole file shows as added.
      const r = await execGit(
        ["diff", "--no-color", "--no-index", "--", "/dev/null", file],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      ).catch((err: any) => {
        // --no-index exits 1 when files differ; that's expected, stdout still holds the diff.
        if (err.stdout) return { stdout: err.stdout as string };
        throw err;
      });
      diff = r.stdout;
    } else {
      const r = await execGit(
        ["diff", "--no-color", "HEAD", "--", file],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      );
      diff = r.stdout;
    }
    return c.json({ file, diff });
  } catch (e: any) {
    logError(`[api] git diff file failed (file=${fileQuery}): ${e.message}`);
    return c.json({ error: e.message || "git diff failed" }, 500);
  }
});

apiRoutes.post("/diff/discard", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const file = body.file as string | undefined;
  const scope = body.scope === "all" ? "all" : "file";

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }
  if (scope === "file" && !file) {
    return c.json({ error: "file is required when scope is file" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    if (scope === "all") {
      const hasHead = await gitHasHead(root);
      if (hasHead) {
        await execGit(["reset", "--hard", "HEAD"], {
          cwd: root,
          maxBuffer: GIT_MAX_BUFFER,
        });
      }
      await execGit(["clean", "-fd"], {
        cwd: root,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return c.json({ ok: true, root, scope });
    }

    await discardGitFile(root, file!);
    return c.json({ ok: true, root, scope, file });
  } catch (e: any) {
    logError(`[api] git discard failed (repo=${root}, file=${file || "*"}): ${e.message}`);
    return c.json({ error: e.message || "Failed to discard changes" }, 500);
  }
});

apiRoutes.post("/diff/discard-hunk", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const file = body.file as string | undefined;
  const hunkIndex = Number(body.hunkIndex);

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }
  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
    return c.json({ error: "hunkIndex must be a non-negative integer" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    await discardGitHunk(root, file, hunkIndex);
    return c.json({ ok: true, root, file, hunkIndex });
  } catch (e: any) {
    logError(`[api] git hunk discard failed (repo=${root}, file=${file}, hunk=${hunkIndex}): ${e.message}`);
    return c.json({ error: e.message || "Failed to reject hunk" }, 500);
  }
});

apiRoutes.get("/agents", (c) => {
  const agents: Agent[] = [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      description: "Anthropic's official CLI for Claude",
      color: "#D97757",
      icon: "claude",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      description: "OpenAI's coding agent CLI",
      color: "#7A9DFF",
      icon: "codex",
    },
  ];
  for (const profile of agentProfiles.list(false)) {
    const version = profile.versions.find((item) => item.version === profile.latestVersion);
    if (!version) continue;
    agents.push({
      id: `profile:${profile.id}`,
      name: version.config.name,
      command: version.config.command,
      description: version.config.description,
      color: version.config.color,
      icon: version.config.icon,
      profileId: profile.id,
      profileVersion: version.version,
      profileConfig: version.config,
    });
  }
  return c.json(agents);
});

apiRoutes.get("/agent-profiles", (c) => {
  return c.json({ profiles: agentProfiles.list(c.req.query("includeArchived") === "true") });
});

apiRoutes.post("/agent-profiles", async (c) => {
  try {
    return c.json({ profile: agentProfiles.create(await c.req.json()) }, 201);
  } catch (error) {
    const status = error instanceof AgentProfileError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Failed to create agent profile";
    return c.json({ error: message }, (status === 409 ? 409 : 400));
  }
});

apiRoutes.get("/agent-profiles/:profileId", (c) => {
  try {
    return c.json({ profile: agentProfiles.get(c.req.param("profileId")) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent profile not found";
    return c.json({ error: message }, 404);
  }
});

apiRoutes.post("/agent-profiles/:profileId/versions", async (c) => {
  try {
    return c.json({ profile: agentProfiles.update(c.req.param("profileId"), await c.req.json()) });
  } catch (error) {
    const status = error instanceof AgentProfileError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Failed to update agent profile";
    return c.json({ error: message }, (status === 404 ? 404 : status === 409 ? 409 : 400));
  }
});

apiRoutes.post("/agent-profiles/:profileId/versions/:version/promote", async (c) => {
  try {
    const version = Number(c.req.param("version"));
    if (!Number.isSafeInteger(version) || version < 1) {
      return c.json({ error: "Version must be a positive integer" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    return c.json({
      profile: agentProfiles.promote(c.req.param("profileId"), version, body.changeNote),
    });
  } catch (error) {
    const status = error instanceof AgentProfileError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Failed to promote agent profile version";
    return c.json({ error: message }, (status === 404 ? 404 : status === 409 ? 409 : 400));
  }
});

apiRoutes.post("/agent-profiles/:profileId/archive", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json({
      profile: agentProfiles.archive(c.req.param("profileId"), body.confirmPermanent === true),
    });
  } catch (error) {
    const status = error instanceof AgentProfileError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Failed to archive agent profile";
    return c.json({ error: message }, (status === 404 ? 404 : 409));
  }
});

apiRoutes.get("/sessions", (c) => {
  const sessionList = Array.from(sessions.entries()).filter(([, session]) => !session.pendingDelete).map(([id, session]) => ({
    sessionId: id,
    nodeId: session.nodeId,
    agentId: session.agentId,
    agentName: session.agentName,
    command: session.command,
    createdAt: session.createdAt,
    cwd: session.cwd,
    originalCwd: session.originalCwd,
    devboxId: session.devboxId,
    remotePath: session.remotePath,
    gitBranch: session.gitBranch,
    status: session.status,
    statusChangedAt: session.statusChangedAt,
    customName: session.customName,
    customColor: session.customColor,
    notes: session.notes,
    isRestored: session.isRestored,
    ticketId: session.ticketId,
    ticketTitle: session.ticketTitle,
    worktreePaths: session.worktreePaths,
    launchCheckpoint: session.launchCheckpoint,
    agentProfileId: session.agentProfileId,
    agentProfileVersion: session.agentProfileVersion,
    agentPermissionPolicy: session.agentPermissionPolicy,
    agentModel: session.agentModel,
    terminalCols: session.terminalCols,
    terminalRows: session.terminalRows,
  }));
  return c.json(sessionList);
});

apiRoutes.get("/sessions/changes", async (c) => {
  const rootSummaries = new Map<string, Promise<Omit<AgentChangeSummary, "sessionId" | "nodeId">>>();

  const getRootSummary = (root: string) => {
    const existing = rootSummaries.get(root);
    if (existing) return existing;

    const summaryPromise = getGitChangedFiles(root).then((files) => {
      const commitSummary = buildCommitMessage(files);
      return {
        repoRoot: root,
        changedFileCount: files.length,
        added: files.reduce((total, file) => total + file.added, 0),
        removed: files.reduce((total, file) => total + file.removed, 0),
        summary: commitSummary.summary,
        files: files.slice(0, 12).map((file) => ({
          path: file.path,
          status: file.status,
          added: file.added,
          removed: file.removed,
          untracked: file.untracked,
        })),
      };
    });

    rootSummaries.set(root, summaryPromise);
    return summaryPromise;
  };

  const summaries: AgentChangeSummary[] = [];
  for (const [sessionId, session] of sessions) {
    if (session.pendingDelete || !session.cwd || !existsSync(session.cwd)) continue;
    const root = await gitRoot(session.cwd);
    if (!root) continue;
    try {
      const rootSummary = await getRootSummary(root);
      summaries.push({
        sessionId,
        nodeId: session.nodeId,
        ...rootSummary,
      });
    } catch (e: any) {
      logError(`[api] session changes failed (session=${sessionId}, cwd=${session.cwd}): ${e.message}`);
    }
  }

  return c.json({ summaries });
});

apiRoutes.post("/layout/title-clusters", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nodeInputs = Array.isArray(body.nodes) ? body.nodes : [];

  const items: TitleSortInput[] = nodeInputs
    .map((node: any): TitleSortInput | null => {
      const nodeId = typeof node?.id === "string" ? node.id : "";
      const session = nodeId ? Array.from(sessions.values()).find((item) => item.nodeId === nodeId) : null;
      if (!nodeId || !session || session.pendingDelete) return null;
      const label = typeof node?.label === "string" ? node.label.trim() : "";
      return {
        nodeId,
        title:
          session.customName ||
          session.ticketTitle ||
          (label && label !== session.agentName && label !== session.agentId ? label : "") ||
          session.agentName,
        agentName: session.agentName,
        status: session.status,
        repo: session.originalCwd || session.cwd,
        branch: session.gitBranch,
        ticketTitle: session.ticketTitle,
        promptHistory: session.titlePromptHistory?.slice(-5),
        createdAt: session.createdAt,
      };
    })
    .filter((item: TitleSortInput | null): item is TitleSortInput => Boolean(item));

  if (items.length === 0) {
    return c.json({ source: "empty", groups: [] });
  }

  const judgedGroups = await generateTitleSortGroups(items).catch(() => null);
  const validJudgedGroups = validateTitleSortGroups(judgedGroups, items);
  if (validJudgedGroups) {
    return c.json({ source: "gemini", groups: validJudgedGroups });
  }

  return c.json({ source: "fallback", groups: fallbackTitleSortGroups(items) });
});

apiRoutes.get("/sessions/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({ status: session.status, isRestored: session.isRestored });
});

apiRoutes.get("/terminal/suggestions", async (c) => {
  const query = c.req.query("query") || "";
  const requestedSessionId = c.req.query("sessionId") || "";
  const contextSession = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
  const cwd = c.req.query("cwd") || contextSession?.cwd || getLaunchCwd();
  const rawLimit = Number(c.req.query("limit") || 30);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 30;
  const sessionEntries = Array.from(sessions.entries());
  const contextSnapshot = contextSession
    ? getTerminalSnapshot(requestedSessionId, false)
    : null;
  const shellEnvironment = contextSession
    ? getTerminalShellEnvironment(requestedSessionId) || {}
    : undefined;
  const remoteConnected = Boolean(contextSession && terminalRemoteManager.isConnected(requestedSessionId));
  const suggestionEnvironment = remoteConnected
    ? { ...(shellEnvironment || {}) }
    : shellEnvironment
      ? { ...process.env, ...shellEnvironment }
      : undefined;
  const remotePathCommands = remoteConnected
    ? await terminalRemoteManager.pathCommands(
        requestedSessionId,
        suggestionEnvironment?.PATH || "",
        cwd,
      ) || []
    : undefined;
  const blocks = sessionEntries.flatMap(([sessionId, session]) => {
    const snapshot = getTerminalSnapshot(sessionId, false);
    if (!snapshot) return [];
    return snapshot.blocks.map((block) => ({
      sessionId,
      sessionName: session.customName || session.agentName,
      block,
    }));
  });
  return c.json(await getTerminalSuggestionsAsync({
    query,
    cwd,
    workflows: terminalAutomation.listWorkflows(),
    sessions: sessionEntries,
    blocks,
    limit,
    shell: contextSnapshot?.shellIntegration || contextSession?.shellLaunch?.shell || process.env.SHELL,
    environment: suggestionEnvironment,
    shellCompletions: contextSession
      ? getTerminalShellCompletions(requestedSessionId) || []
      : [],
    shellCapabilities: contextSession
      ? getTerminalShellCapabilities(requestedSessionId) || {}
      : undefined,
    resourceRunner: remoteConnected
      ? terminalRemoteManager.resourceRunner(requestedSessionId)
      : undefined,
    argumentResolver: remoteConnected
      ? (input) => terminalRemoteManager.argumentValues(requestedSessionId, input)
      : undefined,
    pathCommands: remotePathCommands,
    disableLocalFilesystem: remoteConnected,
  }));
});

apiRoutes.post("/terminal/find", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = textValue(body.sessionId);
  if (!sessionId || !sessions.has(sessionId)) return c.json({ error: "Session not found" }, 404);
  try {
    const search = terminalFind.start({
      sessionId,
      clientId: body.clientId,
      query: body.query,
      regex: body.regex === true,
      caseSensitive: body.caseSensitive === true,
      fields: body.fields,
      order: body.order,
      blockIds: body.blockIds,
      hiddenOutputLineRanges: body.hiddenOutputLineRanges,
      limit: body.limit,
      listBlocks: () => listTerminalFindBlocks(sessionId) || [],
      readBlock: (blockId) => readTerminalFindBlock(sessionId, blockId),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ search }, 202);
  } catch (error: any) {
    if (error instanceof TerminalFindError) return c.json({ error: error.message }, error.status);
    return c.json({ error: error?.message || "Terminal search failed" }, 500);
  }
});

apiRoutes.patch("/terminal/find/:searchId/visibility", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const search = terminalFind.updateHiddenOutputLineRanges(
      c.req.param("searchId"),
      body.hiddenOutputLineRanges,
    );
    if (!search) return c.json({ error: "Terminal search not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ search }, search.status === "scanning" ? 202 : 200);
  } catch (error: any) {
    if (error instanceof TerminalFindError) return c.json({ error: error.message }, error.status);
    return c.json({ error: error?.message || "Terminal search visibility update failed" }, 500);
  }
});

apiRoutes.get("/terminal/find/:searchId", async (c) => {
  const searchId = c.req.param("searchId");
  const rawAfterVersion = Number(c.req.query("afterVersion") || -1);
  const afterVersion = Number.isFinite(rawAfterVersion) ? Math.max(-1, Math.floor(rawAfterVersion)) : -1;
  const rawWaitMs = Number(c.req.query("waitMs") || 0);
  const waitMs = Number.isFinite(rawWaitMs) ? Math.max(0, Math.min(25_000, Math.floor(rawWaitMs))) : 0;
  const search = await terminalFind.waitForUpdate(searchId, afterVersion, waitMs);
  if (!search) return c.json({ error: "Terminal search not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ search });
});

apiRoutes.delete("/terminal/find/:searchId", (c) => {
  const search = terminalFind.cancel(c.req.param("searchId"));
  if (!search) return c.json({ error: "Terminal search not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ search });
});

apiRoutes.get("/terminal/history", (c) => {
  const query = (c.req.query("query") || "").trim().toLowerCase();
  const status = (c.req.query("status") || "").trim();
  const cwd = (c.req.query("cwd") || "").trim().toLowerCase();
  const bookmarkedOnly = c.req.query("bookmarked") === "true";
  const searchOutput = c.req.query("searchOutput") === "true";
  const requestedLimit = Number(c.req.query("limit") || 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(250, Math.floor(requestedLimit)))
    : 100;

  const history = Array.from(sessions.entries()).flatMap(([sessionId, session]) => {
    if (session.pendingDelete) return [];
    const snapshot = getTerminalSnapshot(sessionId, searchOutput);
    if (!snapshot) return [];
    return snapshot.blocks.flatMap((block) => {
      if (status && block.status !== status) return [];
      if (cwd && !block.cwd.toLowerCase().includes(cwd)) return [];
      if (bookmarkedOnly && !block.bookmarked) return [];
      if (query) {
        const searchable = [
          block.command,
          block.cwd,
          block.note || "",
          session.customName || "",
          session.agentName,
          searchOutput ? block.output : "",
        ].join("\n").toLowerCase();
        if (!searchable.includes(query)) return [];
      }
      const { output: _output, ...summary } = block;
      return [{
        ...summary,
        sessionId,
        nodeId: session.nodeId,
        sessionName: session.customName || session.agentName,
        agentName: session.agentName,
      }];
    });
  }).sort((a, b) => (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt));

  return c.json({ history: history.slice(0, limit), total: history.length });
});

apiRoutes.get("/terminal/history/export", (c) => {
  const requestedSessionId = textValue(c.req.query("sessionId"));
  if (requestedSessionId && !sessions.has(requestedSessionId)) {
    return c.json({ error: "Session not found" }, 404);
  }
  const includeOutput = c.req.query("includeOutput") === "true";
  const format = c.req.query("format") === "ndjson" ? "ndjson" : "json";
  const exportedAt = Date.now();
  const exportedSessions = [...sessions.entries()].flatMap(([sessionId, session]) => {
    if (session.pendingDelete || (requestedSessionId && sessionId !== requestedSessionId)) return [];
    const snapshot = getTerminalSnapshot(sessionId, includeOutput);
    if (!snapshot) return [];
    return [{
      sessionId,
      nodeId: session.nodeId,
      name: session.customName || session.agentName,
      agentName: session.agentName,
      cwd: session.cwd,
      createdAt: session.createdAt,
      lifecycle: {
        phase: snapshot.phase,
        currentCwd: snapshot.currentCwd,
        shellIntegration: snapshot.shellIntegration,
        shellEpochId: snapshot.shellEpochId,
        shellDepth: snapshot.shellDepth,
        alternateScreen: snapshot.alternateScreen,
        bracketedPasteEnabled: snapshot.bracketedPasteEnabled,
        terminalModes: snapshot.terminalModes,
      },
      blocks: snapshot.blocks,
    }];
  });

  c.header(
    "Content-Disposition",
    `attachment; filename="openui-terminal-history-${new Date(exportedAt).toISOString().slice(0, 10)}.${format === "ndjson" ? "ndjson" : "json"}"`,
  );
  c.header("Cache-Control", "no-store");
  if (format === "ndjson") {
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    const lines = exportedSessions.flatMap((session) => session.blocks.map((block) => JSON.stringify({
      version: 1,
      exportedAt,
      session: {
        sessionId: session.sessionId,
        nodeId: session.nodeId,
        name: session.name,
        agentName: session.agentName,
        cwd: session.cwd,
        createdAt: session.createdAt,
      },
      block,
    })));
    return c.body(lines.length ? `${lines.join("\n")}\n` : "");
  }
  return c.json({ version: 1, exportedAt, includeOutput, sessions: exportedSessions });
});

apiRoutes.delete("/terminal/history", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== "clear-terminal-history") {
    return c.json({
      error: "History clearing requires confirm: clear-terminal-history",
    }, 409);
  }
  const sessionId = textValue(body.sessionId) || undefined;
  if (sessionId && !sessions.has(sessionId)) return c.json({ error: "Session not found" }, 404);
  const before = body.before === undefined ? undefined : Number(body.before);
  if (before !== undefined && (!Number.isFinite(before) || before < 0)) {
    return c.json({ error: "before must be a non-negative timestamp" }, 400);
  }
  return c.json({
    cleared: true,
    scope: sessionId || "all-sessions",
    ...clearTerminalHistory({
      sessionId,
      before,
      includeBookmarked: body.includeBookmarked === true,
    }),
  });
});

apiRoutes.get("/terminal/workflows", (c) => {
  return c.json({ workflows: terminalAutomation.listWorkflows() });
});

apiRoutes.get("/terminal/workflows/export", (c) => {
  try {
    const ids = (c.req.query("ids") || "").split(",").map((id) => id.trim()).filter(Boolean);
    const yaml = terminalAutomation.exportWorkflowsYaml(ids.length ? ids : undefined);
    c.header("Content-Type", "application/yaml; charset=utf-8");
    c.header("Content-Disposition", "attachment; filename=\"openui-workflows.yaml\"");
    c.header("Cache-Control", "no-store");
    return c.body(yaml);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workflows/import", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(terminalAutomation.importWorkflowsYaml(body.yaml, {
      workspacePath: textValue(body.workspacePath) || undefined,
      conflict: body.conflict,
    }), 201);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workflows", async (c) => {
  try {
    const workflow = terminalAutomation.createWorkflow(await c.req.json());
    return c.json({ workflow }, 201);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.get("/terminal/workflows/:workflowId", (c) => {
  try {
    return c.json({ workflow: terminalAutomation.getWorkflow(c.req.param("workflowId")) });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.put("/terminal/workflows/:workflowId", async (c) => {
  try {
    const workflow = terminalAutomation.updateWorkflow(c.req.param("workflowId"), await c.req.json());
    return c.json({ workflow });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.delete("/terminal/workflows/:workflowId", (c) => {
  try {
    terminalAutomation.deleteWorkflow(c.req.param("workflowId"));
    return c.json({ deleted: true });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workflows/:workflowId/render", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(terminalAutomation.renderWorkflow(c.req.param("workflowId"), body.values || {}));
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workflows/:workflowId/parameters/:parameterName/options", async (c) => {
  try {
    const workflow = terminalAutomation.getWorkflow(c.req.param("workflowId"));
    const parameter = workflow.parameters.find((item) => item.name === c.req.param("parameterName"));
    if (!parameter) return c.json({ error: "Workflow parameter not found" }, 404);
    if (!parameter.dynamicOptionsCommand) {
      return c.json({ error: "Workflow parameter has no dynamic options command" }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    if (body.confirm !== "run-dynamic-options") {
      return c.json({ error: "Dynamic options require confirm: run-dynamic-options" }, 409);
    }
    const cwd = textValue(body.cwd) || workflow.workspacePath || getLaunchCwd();
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return c.json({ error: "Dynamic options require an existing absolute cwd" }, 400);
    }
    const { stdout } = await execFileAsync(parameter.dynamicOptionsCommand, {
      cwd,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const redacted = redactTerminalText(String(stdout)).text;
    const options = [...new Set(redacted.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
    return c.json({ options, cwd, truncated: options.length >= 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dynamic options command failed";
    return c.json({ error: message }, 400);
  }
});

apiRoutes.get("/terminal/launch-configurations", (c) => {
  return c.json({ launchConfigurations: terminalAutomation.listLaunchConfigurations() });
});

apiRoutes.post("/terminal/launch-configurations/import", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(terminalAutomation.importLaunchConfigurationsYaml(body.yaml, {
      defaultCwd: textValue(body.defaultCwd) || getLaunchCwd(),
      conflict: body.conflict,
    }), 201);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/launch-configurations", async (c) => {
  try {
    const launchConfiguration = terminalAutomation.createLaunchConfiguration(await c.req.json());
    return c.json({ launchConfiguration }, 201);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.get("/terminal/launch-configurations/:configurationId", (c) => {
  try {
    const launchConfiguration = terminalAutomation.getLaunchConfiguration(c.req.param("configurationId"));
    return c.json({ launchConfiguration });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.get("/terminal/launch-configurations/:configurationId/export", (c) => {
  try {
    const format = c.req.query("format") === "warp" ? "warp" : "openui";
    const yaml = terminalAutomation.exportLaunchConfigurationYaml(
      c.req.param("configurationId"),
      format,
    );
    c.header("Content-Type", "application/yaml; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="openui-launch-${format}.yaml"`);
    c.header("Cache-Control", "no-store");
    return c.body(yaml);
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.put("/terminal/launch-configurations/:configurationId", async (c) => {
  try {
    const launchConfiguration = terminalAutomation.updateLaunchConfiguration(
      c.req.param("configurationId"),
      await c.req.json(),
    );
    return c.json({ launchConfiguration });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.delete("/terminal/launch-configurations/:configurationId", (c) => {
  try {
    terminalAutomation.deleteLaunchConfiguration(c.req.param("configurationId"));
    return c.json({ deleted: true });
  } catch (error) {
    const failure = terminalAutomationFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/launch-configurations/:configurationId/launch", async (c) => {
  const configurationId = c.req.param("configurationId");
  const started: Array<{ ref: string; sessionId: string; nodeId: string; cwd: string; gitBranch?: string }> = [];
  const failures: Array<{ ref: string; error: string }> = [];
  try {
    const configuration = terminalAutomation.getLaunchConfiguration(configurationId);
    for (let index = 0; index < configuration.sessions.length; index++) {
      const launchSession = configuration.sessions[index];
      try {
        if (!existsSync(launchSession.cwd)) {
          throw new TerminalAutomationError(`Working directory does not exist: ${launchSession.cwd}`);
        }
        let workflowPrompt = "";
        if (launchSession.workflowId) {
          const rendered = terminalAutomation.renderWorkflow(
            launchSession.workflowId,
            launchSession.workflowValues || {},
          );
          if (rendered.sensitive) {
            throw new TerminalAutomationError(
              `Launch session ${launchSession.ref} uses sensitive workflow values and requires interactive confirmation`,
            );
          }
          workflowPrompt = rendered.command;
        }
        const initialPrompt = [launchSession.initialPrompt, workflowPrompt].filter(Boolean).join("\n\n") || undefined;
        const position = launchSession.position || {
          x: (index % 4) * 460,
          y: Math.floor(index / 4) * 360,
        };
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await startSessionFromApiInput(
          { ...launchSession, initialPrompt, position },
          {
            persist: false,
            sessionId: `session-${unique}`,
            nodeId: `node-${configuration.id}-${launchSession.ref}-${unique}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
            workspace: "defer",
          },
        );
        started.push({ ref: launchSession.ref, ...result });
      } catch (error) {
        failures.push({
          ref: launchSession.ref,
          error: error instanceof Error ? error.message : "Session launch failed",
        });
        if (configuration.launchMode === "atomic") throw error;
      }
    }

    const activeSessionId = started.find((item) => item.ref === configuration.activeSessionRef)?.sessionId;
    const workspace = terminalWorkspace.addLaunchTab({
      layout: configuration.layout,
      sessionIdsByRef: new Map(started.map((item) => [item.ref, item.sessionId])),
      activeSessionId,
      title: configuration.name,
    });
    saveState(sessions);
    return c.json({
      configurationId,
      launchMode: configuration.launchMode,
      layout: configuration.layout,
      started,
      failures,
      activeSessionId,
      workspace,
      partial: failures.length > 0,
    });
  } catch (error) {
    for (const item of started) deleteSession(item.sessionId);
    saveState(sessions);
    const failure = error instanceof TerminalWorkspaceError
      ? terminalWorkspaceFailure(error)
      : terminalAutomationFailure(error);
    return c.json({
      error: failure.message,
      rolledBack: started.map((item) => item.sessionId),
      failures,
    }, failure.status);
  }
});

apiRoutes.get("/terminal/workspace", (c) => {
  try {
    const activeSessionIds = [...sessions.keys()];
    const workspace = terminalWorkspace.reconcile(activeSessionIds, { addMissing: true });
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/synchronized-input/dispatch", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const sourceSessionId = textValue(body.sourceSessionId);
    const scope = body.scope === "all-tabs" ? "all-tabs"
      : body.scope === "current-tab" ? "current-tab"
      : null;
    if (!scope) return c.json({ error: "scope must be current-tab or all-tabs" }, 400);

    const workspace = terminalWorkspace.reconcile([...sessions.keys()], { addMissing: true });
    const sourceTab = workspace.tabs.find((tab) =>
      collectTerminalWorkspaceSessionIds(tab.root).includes(sourceSessionId)
    );
    if (!sourceTab) return c.json({ error: "Synchronized input source is not in the terminal workspace" }, 409);
    const targetSessionIds = scope === "all-tabs"
      ? workspace.tabs.flatMap((tab) => collectTerminalWorkspaceSessionIds(tab.root))
      : collectTerminalWorkspaceSessionIds(sourceTab.root);
    const result = dispatchSynchronizedTerminalCommand(
      sourceSessionId,
      targetSessionIds,
      body.command,
    );
    return c.json({ ...result, scope, targetSessionIds });
  } catch (error) {
    if (error instanceof TerminalCommandQueueError) {
      return c.json({ error: error.message }, error.status as any);
    }
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/tabs", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = textValue(body.sessionId);
    const session = sessions.get(sessionId);
    if (!session || session.pendingDelete) return c.json({ error: "Session not found" }, 404);
    const workspace = terminalWorkspace.addTab(sessionId, {
      title: body.title,
      activate: body.activate !== false,
      expectedRevision: expectedWorkspaceRevision(body.expectedRevision),
    });
    return c.json({ workspace }, 201);
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.patch("/terminal/workspace/tabs/:tabId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.renameTab(
      c.req.param("tabId"),
      body.title,
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/tabs/:tabId/activate", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.activateTab(
      c.req.param("tabId"),
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.delete("/terminal/workspace/tabs/:tabId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.closeTab(
      c.req.param("tabId"),
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace, sessionsRetained: true });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/panes/:sessionId/split", async (c) => {
  const sourceSessionId = c.req.param("sessionId");
  let createdSessionId: string | undefined;
  try {
    const source = sessions.get(sourceSessionId);
    if (!source || source.pendingDelete) return c.json({ error: "Source session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const expectedRevision = expectedWorkspaceRevision(body.expectedRevision);
    const existingSessionId = textValue(body.sessionId);
    if (existingSessionId) {
      if (body.session !== undefined) {
        throw new TerminalWorkspaceError("Use either sessionId or session when splitting, not both");
      }
      const existing = sessions.get(existingSessionId);
      if (!existing || existing.pendingDelete) throw new TerminalWorkspaceError("New pane session was not found", 404);
      const workspace = terminalWorkspace.splitPane({
        targetSessionId: sourceSessionId,
        newSessionId: existingSessionId,
        direction: body.direction,
        expectedRevision,
      });
      return c.json({ workspace, sessionId: existingSessionId, created: false });
    }

    const requestedSession = body.session && typeof body.session === "object" ? body.session : {};
    const cwd = resolveTerminalSplitWorkingDirectory(sourceSessionId, requestedSession.cwd);
    const sessionInput = {
      agentId: source.agentId,
      agentName: source.agentName,
      command: source.command,
      agentProfileId: source.agentProfileId,
      agentProfileVersion: source.agentProfileVersion,
      customColor: source.customColor,
      customName: `${source.customName || source.agentName} Split`.slice(0, 120),
      ...requestedSession,
      cwd: cwd.cwd,
    };
    const result = await startSessionFromApiInput(sessionInput, {
      persist: false,
      workspace: "defer",
    });
    createdSessionId = result.sessionId;
    const workspace = terminalWorkspace.splitPane({
      targetSessionId: sourceSessionId,
      newSessionId: result.sessionId,
      direction: body.direction,
      expectedRevision,
    });
    saveState(sessions);
    return c.json({
      workspace,
      sessionId: result.sessionId,
      nodeId: result.nodeId,
      created: true,
      cwd: result.cwd,
      cwdSource: cwd.source,
    }, 201);
  } catch (error) {
    if (createdSessionId) {
      deleteSession(createdSessionId);
      saveState(sessions);
    }
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/panes/:sessionId/move", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.movePane({
      sessionId: c.req.param("sessionId"),
      targetSessionId: body.targetSessionId,
      direction: body.direction,
      expectedRevision: expectedWorkspaceRevision(body.expectedRevision),
    });
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/panes/:sessionId/focus", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = body.direction === undefined
      ? terminalWorkspace.focusPane(
          c.req.param("sessionId"),
          expectedWorkspaceRevision(body.expectedRevision),
        )
      : terminalWorkspace.focusDirection({
          sessionId: c.req.param("sessionId"),
          direction: body.direction,
          expectedRevision: expectedWorkspaceRevision(body.expectedRevision),
        });
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/panes/:sessionId/zoom", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.toggleZoom(
      c.req.param("sessionId"),
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.patch("/terminal/workspace/splits/:splitId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.resizeSplit({
      splitId: c.req.param("splitId"),
      sizes: body.sizes,
      expectedRevision: expectedWorkspaceRevision(body.expectedRevision),
    });
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.delete("/terminal/workspace/panes/:sessionId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const workspace = terminalWorkspace.closePane(
      c.req.param("sessionId"),
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace, sessionRetained: true });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.post("/terminal/workspace/undo-close", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const activeSessionIds = [...sessions.keys()];
    const workspace = terminalWorkspace.undoClose(
      activeSessionIds,
      expectedWorkspaceRevision(body.expectedRevision),
    );
    return c.json({ workspace });
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});

apiRoutes.get("/sessions/:sessionId/blocks", (c) => {
  const sessionId = c.req.param("sessionId");
  const includeOutput = c.req.query("includeOutput") === "true";
  const snapshot = getTerminalSnapshot(sessionId, includeOutput);
  if (!snapshot) return c.json({ error: "Session not found" }, 404);
  const rawLimit = Number(c.req.query("limit") || 0);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.max(1, Math.min(250, Math.floor(rawLimit)))
    : snapshot.blocks.length;
  const totalBlocks = snapshot.blocks.length;
  const selectedBlocks = snapshot.blocks.slice(-limit);
  const plainOutput = includeOutput && c.req.query("plainOutput") === "true";
  const maxOutputChars = 40_000;
  const blocks = selectedBlocks.map((block) => {
    if (!plainOutput) return block;
    const plain = terminalOutputToPlainText(block.output, {
      frameRedrawsInPlace: block.frameRedrawsInPlace,
    });
    if (plain.length <= maxOutputChars) return { ...block, output: plain, uiOutputTruncated: false };
    const half = Math.floor((maxOutputChars - 58) / 2);
    return {
      ...block,
      output: `${plain.slice(0, half)}\n… [middle of output hidden in block view] …\n${plain.slice(-half)}`,
      uiOutputTruncated: true,
    };
  });
  return c.json({
    ...snapshot,
    blocks,
    totalBlocks,
    returnedBlocks: blocks.length,
    hasOlderBlocks: blocks.length < totalBlocks,
  });
});

apiRoutes.get("/sessions/:sessionId/share", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session || session.pendingDelete) return c.json({ error: "Session not found" }, 404);
  const snapshot = getTerminalSnapshot(sessionId, true);
  if (!snapshot) return c.json({ error: "Session not found" }, 404);
  try {
    const selectedBlocks = selectedTerminalShareBlocks(c, snapshot.blocks);
    if (
      selectedBlocks.some((block) => block.sensitive) &&
      c.req.query("confirm") !== SENSITIVE_TERMINAL_SHARE_CONFIRMATION
    ) {
      return c.json({
        error: `Sensitive terminal data requires confirm: ${SENSITIVE_TERMINAL_SHARE_CONFIRMATION}`,
      }, 409);
    }
    return terminalShareResponse(c, createTerminalSessionShare(
      terminalShareSession(sessionId, session),
      selectedBlocks,
      terminalShareOptions(c),
    ));
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiRoutes.get("/sessions/:sessionId/blocks/:blockId/share", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session || session.pendingDelete) return c.json({ error: "Session not found" }, 404);
  const snapshot = getTerminalSnapshot(sessionId, true);
  if (!snapshot) return c.json({ error: "Session not found" }, 404);
  const block = snapshot.blocks.find((item) => item.id === c.req.param("blockId"));
  if (!block) return c.json({ error: "Terminal block not found" }, 404);
  if (block.sensitive && c.req.query("confirm") !== SENSITIVE_TERMINAL_SHARE_CONFIRMATION) {
    return c.json({
      error: `Sensitive terminal data requires confirm: ${SENSITIVE_TERMINAL_SHARE_CONFIRMATION}`,
    }, 409);
  }
  try {
    return terminalShareResponse(c, createTerminalBlockShare(
      terminalShareSession(sessionId, session),
      block,
      terminalShareOptions(c),
    ));
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiRoutes.get("/sessions/:sessionId/blocks/:blockId", (c) => {
  const sessionId = c.req.param("sessionId");
  const blockId = c.req.param("blockId");
  const snapshot = getTerminalSnapshot(sessionId, true);
  if (!snapshot) return c.json({ error: "Session not found" }, 404);
  const block = snapshot.blocks.find((item) => item.id === blockId);
  if (!block) return c.json({ error: "Terminal block not found" }, 404);
  return c.json({ block });
});

apiRoutes.patch("/sessions/:sessionId/blocks/:blockId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const blockId = c.req.param("blockId");
  const body = await c.req.json().catch(() => ({}));
  const updates: { bookmarked?: boolean; note?: string } = {};
  if (typeof body.bookmarked === "boolean") updates.bookmarked = body.bookmarked;
  if (typeof body.note === "string") updates.note = body.note;
  const result = updateTerminalBlock(sessionId, blockId, updates);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ block: result.block });
});

apiRoutes.post("/sessions/:sessionId/blocks/:blockId/command", async (c) => {
  const sessionId = c.req.param("sessionId");
  const blockId = c.req.param("blockId");
  const body = await c.req.json().catch(() => ({}));
  const mode = body.mode === "queue" ? "queue" : body.mode === "execute" ? "execute" : "insert";
  const result = writeTerminalBlockCommand(sessionId, blockId, mode);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ success: true, mode });
});

function terminalCommandQueueError(c: any, error: unknown) {
  if (error instanceof TerminalCommandQueueError) {
    return c.json({ error: error.message }, error.status as any);
  }
  throw error;
}

apiRoutes.get("/sessions/:sessionId/command-queue", (c) => {
  try {
    return c.json({ queue: getTerminalCommandQueue(c.req.param("sessionId")) });
  } catch (error) {
    return terminalCommandQueueError(c, error);
  }
});

apiRoutes.post("/sessions/:sessionId/command-queue", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(enqueueTerminalCommand(c.req.param("sessionId"), body.command));
  } catch (error) {
    return terminalCommandQueueError(c, error);
  }
});

apiRoutes.patch("/sessions/:sessionId/command-queue/:commandId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const commandId = c.req.param("commandId");
  const body = await c.req.json().catch(() => ({}));
  const hasCommand = Object.prototype.hasOwnProperty.call(body, "command");
  const hasBeforeId = Object.prototype.hasOwnProperty.call(body, "beforeId");
  if (!hasCommand && !hasBeforeId) {
    return c.json({ error: "command or beforeId is required" }, 400);
  }
  if (hasBeforeId && body.beforeId !== null && typeof body.beforeId !== "string") {
    return c.json({ error: "beforeId must be a queued command ID or null" }, 400);
  }
  try {
    let queue = hasCommand
      ? editTerminalQueuedCommand(sessionId, commandId, body.command)
      : getTerminalCommandQueue(sessionId);
    if (hasBeforeId) {
      queue = reorderTerminalQueuedCommand(sessionId, commandId, body.beforeId);
    }
    return c.json({ queue });
  } catch (error) {
    return terminalCommandQueueError(c, error);
  }
});

apiRoutes.delete("/sessions/:sessionId/command-queue/:commandId", (c) => {
  try {
    return c.json({
      queue: removeTerminalQueuedCommand(
        c.req.param("sessionId"),
        c.req.param("commandId"),
      ),
    });
  } catch (error) {
    return terminalCommandQueueError(c, error);
  }
});

apiRoutes.delete("/sessions/:sessionId/command-queue", (c) => {
  try {
    return c.json({ queue: clearPendingTerminalCommands(c.req.param("sessionId")) });
  } catch (error) {
    return terminalCommandQueueError(c, error);
  }
});

apiRoutes.get("/state", (c) => {
  const state = loadState();
  const nodes = state.nodes.map(node => {
    const session = sessions.get(node.sessionId);
    return {
      ...node,
      status: session?.status || "disconnected",
      isAlive: !!session,
      isRestored: session?.isRestored,
    };
  }).filter(n => n.isAlive);
  return c.json({ nodes });
});

apiRoutes.post("/state/positions", async (c) => {
  const { positions } = await c.req.json();

  for (const [nodeId, pos] of Object.entries(positions)) {
    for (const [, session] of sessions) {
      if (session.nodeId === nodeId) {
        session.position = pos as { x: number; y: number };
        break;
      }
    }
  }

  savePositions(positions);
  return c.json({ success: true });
});

apiRoutes.post("/sessions", async (c) => {
  const body = await c.req.json();
  try {
    return c.json(await startSessionFromApiInput(body));
  } catch (e: any) {
    logError(`[api] Failed to create session: ${e.message}`);
    if (e instanceof AgentProfileError) {
      const status = e.status === 404 ? 404 : e.status === 409 ? 409 : 400;
      return c.json({ error: e.message }, status);
    }
    if (e instanceof TerminalWorkspaceError) {
      const failure = terminalWorkspaceFailure(e);
      return c.json({ error: failure.message }, failure.status);
    }
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.post("/sessions/:sessionId/restart", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.pty) return c.json({ error: "Session already running" }, 400);

  const { shell, args: shellArgs } = getSessionShellLaunch(session);
  const cwd = existsSync(session.cwd) ? session.cwd : homedir();

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cwd,
      env: getSessionPtyEnvironment(sessionId, session),
      cols: session.terminalCols || DEFAULT_PTY_COLS,
      rows: session.terminalRows || DEFAULT_PTY_ROWS,
    });
  } catch (e: any) {
    logError(`[session] Failed to restart PTY (shell=${shell}, cwd=${cwd}): ${e.message}`);
    return c.json({ error: `Failed to spawn terminal: ${e.message}` }, 500);
  }

  session.pty = ptyProcess;
  session.isRestored = false;
  // Existing clients will receive this PTY epoch live. If none are attached,
  // let the first future renderer reconstruct it from the bounded raw buffer.
  session.terminalClientConnected = session.clients.size > 0;
  session.lastOutputTime = Date.now();
  session.cwd = cwd;
  session.shellLaunch = { shell, args: [...shellArgs] };
  resetTerminalLifecycle(sessionId, cwd);
  session.agentFallbackIndex = 0;
  session.agentAttemptCommand = undefined;
  session.agentAttemptBlockId = undefined;
  session.agentAttemptStartedAt = undefined;

  startAgentStatusTicker(sessionId, session, sessions);

  // Reset plugin status tracking for a fresh process. Everything createSession
  // initialises has to be reset here too, or the new PTY inherits the old
  // one's inference state.
  session.pluginReportedStatus = false;
  session.lastPluginStatusTime = undefined;
  session.lastHookEvent = undefined;
  session.claudeSessionId = undefined;
  session.currentTool = undefined;
  session.preToolTime = undefined;
  session.recentOutputSize = 0;
  applyAgentStatus(session, "running", { source: "authoritative", immediate: true });
  session.statusChangedAt = Date.now();

  attachSessionPty(sessionId, session, ptyProcess, "Restarted PTY");

  const finalCommand = injectPluginDir(
    resolveAgentLaunchCommand(session.command, session.agentId),
    session.agentId,
  );
  setTimeout(() => {
    if (session.pty === ptyProcess) installShellIntegration(sessionId, session, ptyProcess, shell);
  }, 150);
  setTimeout(() => {
    if (finalCommand) startTrackedCommand(sessionId, session, ptyProcess, finalCommand);
  }, 450);

  log(`[session] Restarted ${sessionId}`);
  return c.json({ success: true });
});

apiRoutes.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const updates = await c.req.json();
  if (updates.customName !== undefined) {
    session.customName = updates.customName;
    if (!updates.customName) {
      session.generatedTitle = undefined;
      session.nameGenerated = false;
    }
  }
  if (updates.customColor !== undefined) session.customColor = updates.customColor;
  if (updates.notes !== undefined) session.notes = updates.notes;

  saveState(sessions);
  return c.json({ success: true });
});

apiRoutes.delete("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const success = deleteSession(sessionId);

  if (success) {
    saveState(sessions);
    return c.json({ success: true });
  }
  return c.json({ error: "Session not found" }, 404);
});

// Soft delete - marks session for deletion, actual delete after timeout
apiRoutes.post("/sessions/:sessionId/soft-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  let workspace;
  try {
    workspace = terminalWorkspace.closePane(sessionId);
  } catch (error) {
    if (!(error instanceof TerminalWorkspaceError) || error.status !== 404) {
      const failure = terminalWorkspaceFailure(error);
      return c.json({ error: failure.message }, failure.status);
    }
    workspace = terminalWorkspace.snapshot();
  }
  session.pendingDelete = true;
  discardTerminalCommandQueue(sessionId);

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
  }

  // Grace period must comfortably exceed the client's 5s undo window: bulk
  // deletes fan out N requests and the client toast only starts after they
  // all settle, so a tight server timer can hard-kill sessions the user can
  // still "undo" on screen.
  session.deleteTimeout = setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.pendingDelete) {
      deleteSession(sessionId);
      saveState(sessions);
      log(`[session] Hard-deleted ${sessionId} after timeout`);
    }
  }, 15000);

  saveState(sessions);
  return c.json({ success: true, workspace });
});

// Undo soft delete - restores a pending-delete session
apiRoutes.post("/sessions/:sessionId/undo-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  let workspace;
  try {
    workspace = terminalWorkspace.restoreDetachedSession(sessionId, sessions.keys());
  } catch (error) {
    const failure = terminalWorkspaceFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
    session.deleteTimeout = undefined;
  }
  session.pendingDelete = false;

  saveState(sessions);
  log(`[session] Restored ${sessionId} from soft-delete`);
  return c.json({ success: true, workspace });
});

apiRoutes.get("/sessions/:sessionId/permissions", (c) => {
  const session = sessions.get(c.req.param("sessionId"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({
    profileId: session.agentProfileId,
    profileVersion: session.agentProfileVersion,
    permissionPolicy: session.agentPermissionPolicy,
    allowedTools: session.agentAllowedTools || [],
    events: session.agentPermissionEvents || [],
  });
});

// Status update endpoint for Claude Code plugin
apiRoutes.post("/status-update", async (c) => {
  const body = await c.req.json();
  const { status, openuiSessionId, claudeSessionId, hookEvent, toolName } = body;
  const userPrompt = typeof body.userPrompt === "string" ? body.userPrompt.trim() : "";

  log(`[plugin-hook] ${hookEvent || "unknown"}: status=${status} tool=${toolName || "none"} openui=${openuiSessionId || "none"}`);

  if (!status) {
    return c.json({ error: "status is required" }, 400);
  }

  let session = null;
  let matchedSessionId = typeof openuiSessionId === "string" ? openuiSessionId : "";

  if (openuiSessionId) {
    session = sessions.get(openuiSessionId);
  }

  if (!session && claudeSessionId) {
    for (const [id, s] of sessions) {
      if (s.claudeSessionId === claudeSessionId) {
        session = s;
        matchedSessionId = id;
        break;
      }
    }
  }

  if (session) {
    // Bind the agent's own session id, and re-bind it when a new agent session
    // starts in the same terminal. Binding once and never clearing lets two
    // OpenUI sessions carry the same id after a `--resume`, and the id-matching
    // fallback below then routes hooks to whichever one the map yields first.
    if (claudeSessionId && (!session.claudeSessionId || hookEvent === "SessionStart")) {
      session.claudeSessionId = claudeSessionId;
    }
    if (hookEvent === "SessionEnd") {
      session.claudeSessionId = undefined;
    }

    if (userPrompt && matchedSessionId) {
      scheduleSessionTitleGeneration(matchedSessionId, userPrompt);
    }

    let effectiveStatus: AgentStatus = normalizeAgentStatus(status, session.status);
    let nextTool: string | null | undefined;
    let hookDecision: { permissionDecision: "deny"; reason: string } | null = null;

    if (status === "pre_tool") {
      if (
        session.agentProfileId &&
        session.agentProfileVersion &&
        session.agentPermissionPolicy &&
        typeof toolName === "string"
      ) {
        hookDecision = evaluateAgentProfileToolPermission(
          session.agentPermissionPolicy,
          session.agentAllowedTools || [],
          toolName,
        );
        session.agentPermissionEvents ||= [];
        session.agentPermissionEvents.push({
          id: `permission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
          toolName,
          decision: hookDecision ? "deny" : "provider-flow",
          reason: hookDecision?.reason || "Deferred to the provider permission flow",
          profileId: session.agentProfileId,
          profileVersion: session.agentProfileVersion,
        });
        if (session.agentPermissionEvents.length > 200) session.agentPermissionEvents.shift();
      }

      effectiveStatus = "running";
      nextTool = hookDecision ? null : toolName || null;
      // The tool is outstanding from here until post_tool. The watchdog pairs
      // that with terminal silence to tell a slow tool apart from a prompt
      // that is waiting on the user.
      session.preToolTime = hookDecision ? undefined : Date.now();
    } else if (status === "post_tool") {
      effectiveStatus = "running";
      // The tool finished. Leaving its name set makes the card go on reporting
      // "Working · Bash" through the model's think time before the next call.
      nextTool = null;
      session.preToolTime = undefined;
    } else {
      if (status !== "tool_calling" && status !== "running") nextTool = null;
      session.preToolTime = undefined;
    }

    // A subagent finishing is not the turn ending — the parent agent is still
    // working, and reporting idle here was flipping cards mid-run. hooks.json
    // now sends "running" directly, so this only catches an already-installed
    // copy of the plugin still on the old mapping.
    if (hookEvent === "SubagentStop" && effectiveStatus === "idle") {
      effectiveStatus = "running";
    }

    session.lastPluginStatusTime = Date.now();
    session.lastHookEvent = hookEvent;
    // Keep pluginReportedStatus true while plugin is actively reporting
    // but reset it on terminal states so auto-detect can recover if plugin dies
    if (effectiveStatus === "idle" || effectiveStatus === "disconnected" || effectiveStatus === "error") {
      session.pluginReportedStatus = false;
    } else {
      session.pluginReportedStatus = true;
    }

    applyAgentStatus(session, effectiveStatus, {
      source: statusSourceForHookEvent(hookEvent, status),
      hookEvent,
      currentTool: nextTool,
    });

    if (status === "pre_tool" && session.agentProfileId) saveState(sessions);
    return c.json({ success: true, ...(hookDecision ? { hookDecision } : {}) });
  }

  return c.json({ success: true, warning: "No matching session found" });
});

// Image upload endpoint - saves image to temp dir and returns the path
apiRoutes.post("/sessions/:sessionId/upload-image", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["image"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No image file provided" }, 400);
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: "Unsupported image type" }, 400);
  }

  // Save to a session-specific temp directory
  const uploadDir = join(tmpdir(), "openui-uploads", sessionId);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const ext = file.name.split(".").pop() || "png";
  const safeName = `image-${Date.now()}.${ext}`;
  const filePath = join(uploadDir, safeName);

  const arrayBuffer = await file.arrayBuffer();
  writeFileSync(filePath, Buffer.from(arrayBuffer));

  log(`[upload] Saved image for ${sessionId}: ${filePath}`);
  return c.json({ success: true, filePath });
});

// General file upload — saves any file type into the session's cwd under
// .openui-uploads/, then types the resulting paths into the PTY so the agent
// can reference them. Accepts one or more files under the field name "files".
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50MB per file
const UPLOAD_MAX_FILES = 20;
const UPLOAD_BLOCKED_EXTS = new Set(["exe", "dmg", "app", "pkg", "msi"]);

function quoteUploadPath(path: string): string {
  if (/^[A-Za-z0-9_\-./~@+:=]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

apiRoutes.post("/sessions/:sessionId/upload", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody({ all: true });
  const raw = body["files"];
  const files: File[] = Array.isArray(raw)
    ? raw.filter((f): f is File => f instanceof File)
    : raw instanceof File
      ? [raw]
      : [];

  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }
  if (files.length > UPLOAD_MAX_FILES) {
    return c.json({ error: `Too many files (max ${UPLOAD_MAX_FILES})` }, 400);
  }

  const uploadDir = join(session.cwd, ".openui-uploads");
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const saved: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      skipped.push({ name: file.name, reason: "too large (>50MB)" });
      continue;
    }

    const rawName = file.name || `file-${Date.now()}`;
    const ext = rawName.includes(".") ? rawName.split(".").pop()!.toLowerCase() : "";
    if (ext && UPLOAD_BLOCKED_EXTS.has(ext)) {
      skipped.push({ name: rawName, reason: `blocked type (.${ext})` });
      continue;
    }

    // Sanitize: strip path components and collapse anything that isn't safe.
    // Collision-proof by prefixing a short timestamp.
    const basename = rawName.replace(/^.*[\\/]/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${basename}`;
    const filePath = join(uploadDir, safeName);

    try {
      const arrayBuffer = await file.arrayBuffer();
      writeFileSync(filePath, Buffer.from(arrayBuffer));
      saved.push(filePath);
    } catch (e: any) {
      skipped.push({ name: rawName, reason: e.message || "write failed" });
    }
  }

  // Inject the saved paths into the PTY so the agent sees them as an attachment.
  // No trailing Enter — the user types their question and submits themselves.
  let injected = false;
  if (saved.length > 0 && session.pty) {
    const injection = saved.map((p) => `${quoteUploadPath(p)} `).join("");
    if (!writeTerminalData(sessionId, injection, {
      kind: "upload",
      proxySafe: true,
      bracketedPaste: true,
      beforeWrite: () => {
        noteTerminalInput(sessionId, injection);
        session.lastInputTime = Date.now();
      },
    })) {
      return c.json({ error: "Terminal input queue is full", saved, skipped }, 409);
    }
    injected = true;
  }

  log(`[upload] Saved ${saved.length}/${files.length} files for ${sessionId} in ${uploadDir}`);
  return c.json({
    success: saved.length > 0,
    saved,
    skipped,
    uploadDir,
    injected,
  });
});

// Categories
apiRoutes.get("/categories", (c) => {
  const state = loadState();
  return c.json(state.categories || []);
});

apiRoutes.post("/categories", async (c) => {
  const state = loadState();
  const category = await c.req.json();

  if (!state.categories) state.categories = [];
  state.categories.push(category);

  try {
    savePersistedState(state);
  } catch (error: any) {
    return c.json({ error: error.message || "Invalid category" }, 400);
  }
  if (!category?.id || !loadState().categories?.some((item) => item.id === category.id)) {
    return c.json({ error: "Invalid category" }, 400);
  }

  return c.json({ success: true });
});

apiRoutes.patch("/categories/:categoryId", async (c) => {
  const categoryId = c.req.param("categoryId");
  const updates = await c.req.json();
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const category = state.categories.find(cat => cat.id === categoryId);
  if (!category) return c.json({ error: "Category not found" }, 404);

  Object.assign(category, updates);

  try {
    savePersistedState(state);
  } catch (error: any) {
    return c.json({ error: error.message || "Invalid category update" }, 400);
  }
  if (!loadState().categories?.some((item) => item.id === categoryId)) {
    return c.json({ error: "Invalid category update" }, 400);
  }

  return c.json({ success: true });
});

apiRoutes.delete("/categories/:categoryId", (c) => {
  const categoryId = c.req.param("categoryId");
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const index = state.categories.findIndex(cat => cat.id === categoryId);
  if (index === -1) return c.json({ error: "Category not found" }, 404);

  state.categories.splice(index, 1);

  savePersistedState(state);

  return c.json({ success: true });
});

// ============ Linear Integration ============

const DEFAULT_TICKET_PROMPT = "Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work.";

apiRoutes.get("/linear/config", (c) => {
  const config = loadConfig();
  return c.json({
    hasApiKey: !!config.apiKey,
    defaultTeamId: config.defaultTeamId,
    defaultBaseBranch: config.defaultBaseBranch || "main",
    createWorktree: config.createWorktree ?? false,
    autoCareful: config.autoCareful ?? false,
    ticketPromptTemplate: config.ticketPromptTemplate || DEFAULT_TICKET_PROMPT,
    initialPrompt: config.initialPrompt || "",
    defaultStartingDirectory: config.defaultStartingDirectory || "",
    rememberLastDirectory: config.rememberLastDirectory ?? true,
    defaultAgentId: config.defaultAgentId || "",
  });
});

apiRoutes.post("/linear/config", async (c) => {
  const body = await c.req.json();
  const config = loadConfig();

  if (body.apiKey !== undefined) config.apiKey = body.apiKey;
  if (body.defaultTeamId !== undefined) config.defaultTeamId = body.defaultTeamId;
  if (body.defaultBaseBranch !== undefined) config.defaultBaseBranch = body.defaultBaseBranch;
  if (body.createWorktree !== undefined) config.createWorktree = body.createWorktree;
  if (body.autoCareful !== undefined) config.autoCareful = body.autoCareful;
  if (body.ticketPromptTemplate !== undefined) config.ticketPromptTemplate = body.ticketPromptTemplate;
  if (body.initialPrompt !== undefined) config.initialPrompt = body.initialPrompt;
  if (body.defaultStartingDirectory !== undefined) config.defaultStartingDirectory = body.defaultStartingDirectory;
  if (body.rememberLastDirectory !== undefined) config.rememberLastDirectory = body.rememberLastDirectory;
  if (body.defaultAgentId !== undefined) config.defaultAgentId = body.defaultAgentId;

  saveConfig(config);
  return c.json({ success: true });
});

apiRoutes.post("/linear/validate", async (c) => {
  const { apiKey } = await c.req.json();
  if (!apiKey) return c.json({ valid: false, error: "No API key provided" });

  try {
    const valid = await validateApiKey(apiKey);
    if (valid) {
      const user = await getCurrentUser(apiKey);
      return c.json({ valid: true, user });
    }
    return c.json({ valid: false, error: "Invalid API key" });
  } catch (e: any) {
    return c.json({ valid: false, error: e.message });
  }
});

apiRoutes.get("/linear/teams", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  try {
    const teams = await fetchTeams(config.apiKey);
    return c.json(teams);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/tickets", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await fetchMyTickets(config.apiKey, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/search", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Search query required" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await searchTickets(config.apiKey, query, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/ticket/:identifier", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const identifier = c.req.param("identifier");

  try {
    const ticket = await fetchTicketByIdentifier(config.apiKey, identifier);
    if (!ticket) return c.json({ error: "Ticket not found" }, 404);
    return c.json(ticket);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ GitHub Integration ============

apiRoutes.get("/github/issues", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const repoUrl = c.req.query("repoUrl");

  let resolvedOwner = owner;
  let resolvedRepo = repo;

  if (repoUrl && !owner && !repo) {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) return c.json({ error: "Invalid GitHub URL" }, 400);
    resolvedOwner = parsed.owner;
    resolvedRepo = parsed.repo;
  }

  if (!resolvedOwner || !resolvedRepo) {
    return c.json({ error: "owner and repo are required (or provide repoUrl)" }, 400);
  }

  try {
    const issues = await fetchGitHubIssues(resolvedOwner, resolvedRepo);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/search", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const q = c.req.query("q");

  if (!owner || !repo) return c.json({ error: "owner and repo are required" }, 400);
  if (!q) return c.json({ error: "Search query (q) is required" }, 400);

  try {
    const issues = await searchGitHubIssues(owner, repo, q);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/issue/:owner/:repo/:number", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const number = parseInt(c.req.param("number"), 10);

  if (isNaN(number)) return c.json({ error: "Invalid issue number" }, 400);

  try {
    const issue = await fetchGitHubIssue(owner, repo, number);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    return c.json(issue);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
