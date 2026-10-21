import { existsSync, readdirSync } from "fs";
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
const FLAGS_WITH_VALUE = new Set(["--resume", "-r", "--session-id"]);
const BARE_FLAGS = new Set(["--continue", "-c"]);

/** `claude …` plus `--resume <id>`, or null when this command cannot be resumed by id. */
export function buildResumeCommand(command: string, agentId: string, sessionId: string): string | null {
  if (agentId !== "claude" || !isResumableSessionId(sessionId)) return null;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "claude") return null;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (BARE_FLAGS.has(token)) continue;
    if ([...FLAGS_WITH_VALUE].some((flag) => token.startsWith(`${flag}=`))) continue;
    kept.push(token);
  }
  return [...kept, "--resume", sessionId].join(" ");
}

export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME || "", ".claude");
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
