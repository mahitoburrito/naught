import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";

/**
 * Where each agent harness keeps the state that makes `resume` work, and the
 * commands that start and stop it. The move never edits these files; it
 * copies them whole to the same path relative to the node user's home.
 */

export type HarnessKind = "claude" | "codex" | "shell";

export function harnessKindFor(agentId: string, command: string): HarnessKind {
  const token = (command || "").trim().split(/\s+/)[0] || "";
  const base = token.split("/").pop() || "";
  if (agentId === "claude" || base === "claude") return "claude";
  if (agentId === "codex" || base === "codex") return "codex";
  return "shell";
}

/**
 * Claude Code names a project directory after the cwd with every
 * non-alphanumeric character turned into `-`. Past 200 characters it keeps
 * the first 200 and appends a hash of the full path; the exact hash is not
 * documented, so paths that long are flagged rather than trusted.
 */
export function claudeProjectDirName(cwd: string): string {
  const escaped = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (escaped.length <= 200) return escaped;
  return `${escaped.slice(0, 200)}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
}

export interface ClaudeState {
  kind: "claude";
  sessionId: string;
  projectDir: string;
  transcript: string;
  subagentsDir?: string;
  todos: string[];
  /** True when the project directory name had to be shortened: resume may not find it. */
  longPath: boolean;
}

export function findClaudeState(input: { home?: string; sessionId: string; cwd: string; transcriptPath?: string }): ClaudeState | null {
  const home = input.home ?? homedir();
  const dirName = claudeProjectDirName(input.cwd);
  let projectDir = join(home, ".claude", "projects", dirName);
  let transcript = join(projectDir, `${input.sessionId}.jsonl`);
  if (input.transcriptPath && existsSync(input.transcriptPath)) {
    transcript = input.transcriptPath;
    projectDir = resolve(transcript, "..");
  }
  if (!existsSync(transcript)) return null;
  const subagentsDir = join(projectDir, input.sessionId);
  const todosDir = join(home, ".claude", "todos");
  let todos: string[] = [];
  try {
    todos = readdirSync(todosDir)
      .filter((name) => name.startsWith(input.sessionId))
      .map((name) => join(todosDir, name));
  } catch { /* no todos */ }
  return {
    kind: "claude",
    sessionId: input.sessionId,
    projectDir,
    transcript,
    subagentsDir: existsSync(subagentsDir) && statSync(subagentsDir).isDirectory() ? subagentsDir : undefined,
    todos,
    longPath: input.cwd.replace(/[^A-Za-z0-9]/g, "-").length > 200,
  };
}

export interface CodexState {
  kind: "codex";
  sessionId: string;
  rolloutPath: string;
  timestamp: number;
}

function readFirstLine(path: string, max = 64 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    const read = readSync(fd, buffer, 0, max, 0);
    const text = buffer.subarray(0, read).toString("utf-8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    closeSync(fd);
  }
}

function walkRollouts(dir: string, out: string[]): void {
  let entries: import("fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkRollouts(path, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(path);
  }
}

/**
 * Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; the
 * first line is `session_meta` with the cwd. The newest rollout for this cwd
 * started after the session is the one to carry.
 */
export function findCodexState(input: { home?: string; cwd: string; since: number; sessionId?: string }): CodexState | null {
  const home = input.home ?? homedir();
  const sessionsDir = join(home, ".codex", "sessions");
  const files: string[] = [];
  walkRollouts(sessionsDir, files);
  let best: CodexState | null = null;
  for (const path of files) {
    let meta: any;
    try { meta = JSON.parse(readFirstLine(path)); } catch { continue; }
    const payload = meta?.payload ?? meta;
    if (meta?.type !== "session_meta" || !payload || typeof payload !== "object") continue;
    if (typeof payload.id !== "string") continue;
    if (input.sessionId && payload.id !== input.sessionId) continue;
    if (!input.sessionId) {
      if (payload.cwd !== input.cwd) continue;
      const timestamp = Date.parse(payload.timestamp || meta.timestamp || "");
      if (!Number.isFinite(timestamp) || timestamp < input.since - 60_000) continue;
      if (best && best.timestamp >= timestamp) continue;
      best = { kind: "codex", sessionId: payload.id, rolloutPath: path, timestamp };
    } else {
      const timestamp = Date.parse(payload.timestamp || meta.timestamp || "") || 0;
      best = { kind: "codex", sessionId: payload.id, rolloutPath: path, timestamp };
      break;
    }
  }
  return best;
}

export function codexAuthPath(home: string = homedir()): string {
  return join(home, ".codex", "auth.json");
}

export function resumeCommand(kind: HarnessKind, originalCommand: string, sessionId?: string): string {
  if (kind === "claude" && sessionId) return `claude --resume ${sessionId}`;
  if (kind === "codex" && sessionId) return `codex resume ${sessionId}`;
  return originalCommand;
}

export function exitCommand(kind: HarnessKind): string {
  if (kind === "claude") return "/exit";
  if (kind === "codex") return "/quit";
  return "exit";
}

/** `/Users/me/.claude/projects/x/y.jsonl` → `.claude/projects/x/y.jsonl` for re-rooting under the node's home. */
export function relativeToHome(path: string, home: string = homedir()): string | null {
  const rel = relative(home, path);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep + "..")) return null;
  return rel.split(sep).join("/");
}

export function remoteHomePath(remoteHome: string, relFromHome: string): string {
  return `${remoteHome.replace(/\/$/, "")}/${relFromHome}`;
}
