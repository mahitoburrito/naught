import { existsSync, readdirSync } from "fs";
import { codexRolloutExists } from "./codexSessions";
import { homedir } from "os";
import { join } from "path";

/**
 * Relaunching a saved session. Claude Code reports its own session id through
 * hooks; Codex reports none, so codexSessions.ts finds it from the rollout the
 * submitted prompt landed in. With that id saved on the node, a relaunch runs
 * `claude --resume <id>` or `codex resume <id>` and picks the conversation
 * back up. A devbox command wraps the agent in ssh, so it relaunches fresh.
 */

// Claude ids are UUIDs. Anything else is refused before it reaches a shell.
const RESUMABLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

export function isResumableSessionId(value: unknown): value is string {
  return typeof value === "string" && RESUMABLE_ID.test(value);
}

// Flags that pick a conversation; a resume replaces them with its own.
// --resume and -r take an optional value; --session-id always takes one.
const FLAGS_WITH_OPTIONAL_VALUE = new Set(["--resume", "-r", "--session-id"]);
const BARE_FLAGS = new Set(["--continue", "-c", "--fork-session"]);

interface ShellToken {
  /** The token exactly as written, quotes included, so it can be re-emitted. */
  raw: string;
  /** The token with quoting removed, used only to recognise flags. */
  value: string;
}

/** Split a POSIX-ish command line into words, keeping each word's original quoting. Null on unbalanced quotes. */
function shellTokens(command: string, simpleCommandOnly = false): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let raw = "";
  let value = "";
  let quote: "'" | '"' | null = null;
  let inToken = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      raw += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) { raw += command[++i]; value += command[i]; }
      else value += ch;
      continue;
    }
    // Appending --resume to a pipeline or command list would target the last
    // command, not necessarily Claude. Only rewrite a single invocation.
    if (simpleCommandOnly && /[;&|<>()\r\n]/.test(ch)) return null;
    if (simpleCommandOnly && ch === "#" && !inToken) return null;
    if (/\s/.test(ch)) {
      if (inToken) tokens.push({ raw, value });
      raw = ""; value = ""; inToken = false;
      continue;
    }
    inToken = true;
    raw += ch;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\" && i + 1 < command.length) { raw += command[++i]; value += command[i]; }
    else value += ch;
  }
  if (quote) return null;
  if (inToken) tokens.push({ raw, value });
  return tokens;
}

/**
 * True when the launch command runs Claude Code directly: the built-in agent or
 * a profile, with `claude` (or a path ending in /claude) as the executable. An
 * ssh wrapper or any other program does not count.
 */
export function isClaudeCommand(command: string, agentId: string): boolean {
  if (agentId !== "claude" && !agentId.startsWith("profile:")) return false;
  const first = shellTokens(command)?.[0]?.value || "";
  return first === "claude" || first.endsWith("/claude");
}

/** True when the launch command runs Codex directly (not through ssh or a wrapper). */
export function isCodexCommand(command: string, agentId: string): boolean {
  if (agentId !== "codex" && !agentId.startsWith("profile:")) return false;
  const first = shellTokens(command)?.[0]?.value || "";
  return first === "codex" || first.endsWith("/codex");
}

export type ResumableAgent = "claude" | "codex";

/** Which agent this launch command can resume by id, or null for anything else. */
export function resumableAgentKind(command: string, agentId: string): ResumableAgent | null {
  if (isClaudeCommand(command, agentId)) return "claude";
  if (isCodexCommand(command, agentId)) return "codex";
  return null;
}

// Codex options that take a value. Anything else that is not a flag is a
// positional (a prompt or a subcommand), and `resume <id>` cannot follow it.
const CODEX_FLAGS_WITH_VALUE = new Set([
  "-m", "--model", "-c", "--config", "-p", "--profile", "-C", "--cd", "-s", "--sandbox",
  "-a", "--ask-for-approval", "-i", "--image", "--add-dir", "--enable", "--disable",
  "--local-provider", "--remote", "--remote-auth-token-env",
]);

/** `codex …` plus `resume <id>`, keeping the launch flags (`--yolo`, `-m`, `--no-daemon`). */
function buildCodexResumeCommand(command: string, sessionId: string): string | null {
  const tokens = shellTokens(command.trim(), true);
  if (!tokens || tokens.length === 0) return null;
  const kept = [tokens[0].raw];
  for (let i = 1; i < tokens.length; i++) {
    const { raw, value } = tokens[i];
    // A previous `resume <id>` or `resume --last` is replaced by this one.
    if (value === "resume") {
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].value.startsWith("-")) { if (tokens[j].value !== "--last") kept.push(tokens[j].raw); continue; }
        if (j !== i + 1) return null;
      }
      break;
    }
    if (value.startsWith("-")) {
      kept.push(raw);
      if (CODEX_FLAGS_WITH_VALUE.has(value) && tokens[i + 1]) kept.push(tokens[++i].raw);
      continue;
    }
    return null;
  }
  return [...kept, "resume", sessionId].join(" ");
}

/** The launch command plus a resume of `sessionId`, or null when this command cannot be resumed by id. */
export function buildResumeCommand(command: string, agentId: string, sessionId: string): string | null {
  if (!isResumableSessionId(sessionId)) return null;
  if (isCodexCommand(command, agentId)) return buildCodexResumeCommand(command, sessionId);
  if (!isClaudeCommand(command, agentId)) return null;
  const tokens = shellTokens(command.trim(), true);
  if (!tokens) return null;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const { raw, value } = tokens[i];
    if (FLAGS_WITH_OPTIONAL_VALUE.has(value)) {
      const next = tokens[i + 1];
      if (next && !next.value.startsWith("-")) i++;
      continue;
    }
    if (BARE_FLAGS.has(value)) continue;
    if ([...FLAGS_WITH_OPTIONAL_VALUE].some((flag) => value.startsWith(`${flag}=`))) continue;
    kept.push(raw);
  }
  return [...kept, "--resume", sessionId].join(" ");
}

export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  // Windows sets USERPROFILE, not HOME; os.homedir() covers both.
  return join(env.HOME || homedir(), ".claude");
}

/** Claude keeps one transcript per session under projects/<encoded cwd>/<id>.jsonl. */
export function claudeTranscriptExists(sessionId: string, configDir = defaultClaudeConfigDir()): boolean {
  if (!isResumableSessionId(sessionId)) return false;
  const projects = join(configDir, "projects");
  try {
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

export interface RelaunchPlan {
  command: string;
  resumed: boolean;
}

/** True when the agent still has this conversation on disk. */
export function conversationExists(
  kind: ResumableAgent,
  sessionId: string,
  options: { claudeConfigDir?: string; codexHome?: string } = {},
): boolean {
  return kind === "codex"
    ? codexRolloutExists(sessionId, options.codexHome)
    : claudeTranscriptExists(sessionId, options.claudeConfigDir);
}

/**
 * What to run when a saved session comes back. A resume only happens when the
 * conversation still exists; otherwise the agent starts fresh rather than
 * failing on a conversation the agent no longer has.
 */
export function planRelaunch(
  session: { agentId: string; command: string; resumeSessionId?: string },
  options: { resume: boolean; claudeConfigDir?: string; codexHome?: string },
): RelaunchPlan {
  const fresh = { command: session.command, resumed: false };
  if (!options.resume || !session.resumeSessionId) return fresh;
  const kind = resumableAgentKind(session.command, session.agentId);
  if (!kind) return fresh;
  const command = buildResumeCommand(session.command, session.agentId, session.resumeSessionId);
  if (!command) return fresh;
  if (!conversationExists(kind, session.resumeSessionId, options)) return fresh;
  return { command, resumed: true };
}
