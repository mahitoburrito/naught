import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Relaunching a saved session. Claude Code reports its own session id through
 * hooks; with that id saved on the node, a relaunch can run
 * `claude --resume <id>` and pick the conversation back up. Codex reports no
 * id, and a devbox command wraps the agent in ssh, so those relaunch fresh.
 */

// Claude ids are UUIDs. Anything else is refused before it reaches a shell.
const RESUMABLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

export function isResumableSessionId(value: unknown): value is string {
  return typeof value === "string" && RESUMABLE_ID.test(value);
}

// Flags that pick a conversation; a resume replaces them with its own.
// --resume and -r take an optional value; --session-id always takes one.
const FLAGS_WITH_OPTIONAL_VALUE = new Set(["--resume", "-r", "--session-id"]);
const BARE_FLAGS = new Set(["--continue", "-c"]);

interface ShellToken {
  /** The token exactly as written, quotes included, so it can be re-emitted. */
  raw: string;
  /** The token with quoting removed, used only to recognise flags. */
  value: string;
}

/** Split a POSIX-ish command line into words, keeping each word's original quoting. Null on unbalanced quotes. */
function shellTokens(command: string): ShellToken[] | null {
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

/** `claude …` plus `--resume <id>`, or null when this command cannot be resumed by id. */
export function buildResumeCommand(command: string, agentId: string, sessionId: string): string | null {
  if (!isResumableSessionId(sessionId) || !isClaudeCommand(command, agentId)) return null;
  const tokens = shellTokens(command.trim());
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

/**
 * What to run when a saved session comes back. A resume only happens when the
 * transcript still exists; otherwise the agent starts fresh rather than
 * failing on a conversation Claude no longer has.
 */
export function planRelaunch(
  session: { agentId: string; command: string; resumeSessionId?: string },
  options: { resume: boolean; claudeConfigDir?: string },
): RelaunchPlan {
  const fresh = { command: session.command, resumed: false };
  if (!options.resume || !session.resumeSessionId) return fresh;
  const command = buildResumeCommand(session.command, session.agentId, session.resumeSessionId);
  if (!command) return fresh;
  if (!claudeTranscriptExists(session.resumeSessionId, options.claudeConfigDir)) return fresh;
  return { command, resumed: true };
}
