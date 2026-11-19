import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Finding which conversation a node was in, from what the agent wrote to disk.
 *
 * Codex reports no session id to OpenUI, and its TUIs share one background
 * server, so neither its environment nor its open files say which terminal a
 * thread belongs to. What does: the prompt typed into the node lands as a user
 * message in exactly one rollout, `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
 *
 * The same prompt matching recovers ids for nodes saved before ids were kept
 * (Claude nodes from older builds, and every Codex node), using the prompts
 * OpenUI remembered for titles.
 */

const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

function rolloutFiles(codexHome: string, sinceMs = 0): string[] {
  const root = join(codexHome, "sessions");
  const out: string[] = [];
  // Day directories older than `since` cannot hold a rollout written after it
  // (a day of slack covers time zones), so skip them without listing.
  const cutoff = sinceMs > 0 ? new Date(sinceMs - 86_400_000) : null;
  const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
  for (const year of list(root)) {
    if (cutoff && Number(year) < cutoff.getFullYear()) continue;
    for (const month of list(join(root, year))) {
      for (const day of list(join(root, year, month))) {
        if (cutoff && new Date(Number(year), Number(month) - 1, Number(day) + 1) < cutoff) continue;
        for (const name of list(join(root, year, month, day))) {
          if (name.startsWith("rollout-") && name.endsWith(".jsonl")) out.push(join(root, year, month, day, name));
        }
      }
    }
  }
  return out;
}

/** True when Codex still has a rollout for this thread id. */
export function codexRolloutExists(sessionId: string, codexHome = defaultCodexHome()): boolean {
  return rolloutFiles(codexHome).some((path) => path.endsWith(`-${sessionId}.jsonl`));
}

/** Whitespace-collapsed, lowercased text for comparing a typed prompt with a stored message. */
export function normalizePrompt(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Shorter prompts ("ok", "yes", "continue") appear in too many conversations to identify one.
const MIN_PROMPT_CHARS = 6;
const PROMPT_PREFIX_CHARS = 120;

/**
 * A prompt that can identify a conversation. Slash commands (`/resume`,
 * `/quit`, `/btw`) are handled by the TUI and never stored as user messages.
 */
export function isIdentifyingPrompt(prompt: string): boolean {
  const text = normalizePrompt(prompt);
  return text.length >= MIN_PROMPT_CHARS && !text.startsWith("/");
}

/** True when one of the stored user messages is this prompt. Pastes and long prompts compare on a prefix. */
export function messagesContainPrompt(messages: string[], prompt: string): boolean {
  if (!isIdentifyingPrompt(prompt)) return false;
  const wanted = normalizePrompt(prompt);
  const prefix = wanted.slice(0, PROMPT_PREFIX_CHARS);
  return messages.some((message) => message.includes(prefix));
}

// Codex prints one of these on every deliberate exit (/quit, /exit, Ctrl+C
// twice): "To continue this session, run:" without its background server,
// "To reconnect, run:" with it, then `codex resume <id>` on the next line.
const CODEX_EXIT_HINT = /(?:continue this session|to reconnect), run:? codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** The thread id from Codex's exit hint in already-normalized terminal text, or null. */
export function parseCodexExitHint(normalizedText: string): string | null {
  return CODEX_EXIT_HINT.exec(normalizedText)?.[1] ?? null;
}

export interface StoredConversation {
  id: string;
  cwd?: string;
  /** Normalized user messages, oldest first. */
  messages: string[];
  modifiedAt: number;
}

function codexUserTexts(line: any): string[] {
  const payload = line?.payload;
  if (line?.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return [];
  if (!Array.isArray(payload.content)) return [];
  return payload.content
    .filter((item: any) => item?.type === "input_text" && typeof item.text === "string")
    .map((item: any) => normalizePrompt(item.text));
}

export function parseCodexRollout(text: string, path: string, modifiedAt: number): StoredConversation | null {
  let id = UUID_IN_NAME.exec(path)?.[1];
  let cwd: string | undefined;
  const messages: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line?.type === "session_meta") {
      if (typeof line.payload?.id === "string") id = line.payload.id;
      if (typeof line.payload?.cwd === "string") cwd = line.payload.cwd;
      continue;
    }
    messages.push(...codexUserTexts(line));
  }
  return id ? { id, cwd, messages, modifiedAt } : null;
}

function claudeUserTexts(line: any): string[] {
  if (line?.type !== "user" || line.isMeta || line.message?.role !== "user") return [];
  const content = line.message.content;
  if (typeof content === "string") return [normalizePrompt(content)];
  if (!Array.isArray(content)) return [];
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => normalizePrompt(item.text));
}

export function parseClaudeTranscript(text: string, path: string, modifiedAt: number): StoredConversation | null {
  const id = UUID_IN_NAME.exec(path)?.[1];
  if (!id) return null;
  let cwd: string | undefined;
  const messages: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!cwd && typeof line?.cwd === "string") cwd = line.cwd;
    messages.push(...claudeUserTexts(line));
  }
  return { id, cwd, messages, modifiedAt };
}

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The Codex thread a just-submitted prompt went into: a rollout written since
 * the prompt was sent whose user messages include it. Null unless exactly one
 * qualifies (a rollout not yet flushed is retried by the caller).
 */
export function findCodexThreadForPrompt(input: {
  prompt: string;
  cwd: string;
  submittedAt: number;
  codexHome?: string;
  exclude?: Set<string>;
}): string | null {
  if (!isIdentifyingPrompt(input.prompt)) return null;
  const since = input.submittedAt - 5_000;
  const matches: StoredConversation[] = [];
  for (const path of rolloutFiles(input.codexHome ?? defaultCodexHome(), since)) {
    let modifiedAt: number;
    try { modifiedAt = statSync(path).mtimeMs; } catch { continue; }
    if (modifiedAt < since) continue;
    let conversation: StoredConversation | null;
    try { conversation = parseCodexRollout(readFileSync(path, "utf-8"), path, modifiedAt); } catch { continue; }
    if (!conversation || input.exclude?.has(conversation.id)) continue;
    // Only the newest messages can be this submission; an old thread that
    // happens to contain the same words further back is not it.
    if (!messagesContainPrompt(conversation.messages.slice(-2), input.prompt)) continue;
    matches.push(conversation);
  }
  const sameCwd = matches.filter((match) => match.cwd === input.cwd);
  const pool = sameCwd.length > 0 ? sameCwd : matches;
  return pool.length === 1 ? pool[0].id : null;
}

export interface InferInput {
  kind: "claude" | "codex";
  cwd: string;
  /** Prompts OpenUI remembered for this node, oldest first. */
  prompts: string[];
  /** When the node was created; conversations last written before it are not candidates. */
  createdAt: number;
  exclude?: Set<string>;
  claudeConfigDir?: string;
  codexHome?: string;
  /** Shared across calls in one pass so each file is read and parsed once. */
  cache?: Map<string, StoredConversation | null>;
}

async function readConversation(
  kind: "claude" | "codex",
  path: string,
  cache?: Map<string, StoredConversation | null>,
): Promise<StoredConversation | null> {
  if (cache?.has(path)) return cache.get(path) ?? null;
  let conversation: StoredConversation | null = null;
  try {
    const modifiedAt = (await stat(path)).mtimeMs;
    const text = await readFile(path, "utf-8");
    conversation = kind === "codex" ? parseCodexRollout(text, path, modifiedAt) : parseClaudeTranscript(text, path, modifiedAt);
  } catch {
    conversation = null;
  }
  cache?.set(path, conversation);
  return conversation;
}

/**
 * Recover the conversation a node was in from the prompts it remembered. The
 * winner must contain the node's latest usable prompt (the conversation it was
 * in last), and must beat every other candidate on how many of the node's
 * prompts it contains. Ties and weak matches return null: a wrong resume would
 * drop the user into someone else's chat, while a miss only starts fresh.
 */
export async function inferConversationId(input: InferInput): Promise<string | null> {
  const prompts = input.prompts.filter(isIdentifyingPrompt).map(normalizePrompt);
  if (prompts.length === 0) return null;
  const latest = prompts[prompts.length - 1];

  let paths: string[];
  if (input.kind === "codex") {
    paths = rolloutFiles(input.codexHome ?? defaultCodexHome(), input.createdAt);
  } else {
    const dir = join(input.claudeConfigDir ?? join(homedir(), ".claude"), "projects", claudeProjectDirName(input.cwd));
    paths = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)) : [];
  }

  let best: { id: string; score: number } | null = null;
  let tied = false;
  for (const path of paths) {
    const conversation = await readConversation(input.kind, path, input.cache);
    if (!conversation || conversation.modifiedAt < input.createdAt) continue;
    if (input.exclude?.has(conversation.id)) continue;
    if (conversation.cwd && conversation.cwd !== input.cwd) continue;
    if (!messagesContainPrompt(conversation.messages, latest)) continue;
    const score = prompts.filter((prompt) => messagesContainPrompt(conversation.messages, prompt)).length;
    if (!best || score > best.score) { best = { id: conversation.id, score }; tied = false; }
    else if (score === best.score) tied = true;
  }
  if (!best || tied) return null;
  // One matching prompt is enough only when the node remembered just one.
  if (best.score < Math.min(2, prompts.length)) return null;
  return best.id;
}
