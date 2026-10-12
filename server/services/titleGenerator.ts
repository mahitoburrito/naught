import { readEnvFile as loadEnvFile, updateEnvValue } from "./secrets";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TITLE_MAX_INPUT_CHARS = 5000;
const TITLE_MAX_WORDS = 12;
const TITLE_MAX_CHARS = 140;
const GEMINI_TITLE_SYSTEM_PROMPT = [
  "Name an OpenUI desktop agent session from the user's prompt history over time.",
  "Return only a useful descriptive session title. Use as many words as needed, but stay under 12 words and 140 characters.",
  "Prefer a concrete product plus feature, bug plus surface, or objective plus repo.",
  "Do not simply summarize the latest prompt. Infer the durable work thread from the whole prompt history.",
  "Treat short follow-ups, status checks, confirmations, and meta questions as weak signal unless they introduce a concrete new product, feature, bug, repo, or workflow.",
  "If the user truly pivots, update the title only when later prompts establish a concrete new work thread.",
  "Preserve exact repo, product, ticket, feature, bug, local URL, or file names when they are the clearest signal.",
  "Prompts starting with / are IDE slash commands. Title those by the higher-level task being performed, never by the raw command arguments, flags, or model ids.",
  "Ignore assistant-routing phrasing such as please, can you, use Codex, use Claude, or use Gemini.",
  "Do not mention the agent name unless the user's task is specifically about that agent.",
  "Avoid generic standalone labels: Session, Task, Work, Help, Fix, Update, Coding, Investigation.",
  "No quotes, emoji, markdown, full sentences, trailing punctuation, or extra explanation.",
  "Use title case unless preserving a user-provided identifier or casing.",
  "Examples:",
  "Prompts: make openui automatically show localhost in the side browser panel -> OpenUI Localhost Browser Dock",
  "Prompts: review PRB-17 Linear enrichment bug -> PRB-17 Linear Enrichment Review",
  "Prompts: fix Stripe checkout loading spinner, then test web checkout -> Stripe Checkout Loading State",
  "Prompts: /model, /model claude-fable-5, /effort -> Model Selection",
].join("\n");
const GEMINI_SORT_SYSTEM_PROMPT = [
  "You are sorting OpenUI desktop agent cards by the durable work intent behind each task.",
  "Work intent means the shared objective, product area, user workflow, bug class, repo surface, or business job being pursued.",
  "Use title plus recent prompt history as primary evidence. Use repo, branch, ticket, status, and recency only to break ties.",
  "Cluster sessions that are the same kind of work even when they mention different channels, tools, or sources.",
  "Treat channel/source words such as LinkedIn, Bookface, email, Slack, X/Twitter, YC, GitHub, Linear, or Notion as modifiers, not as separate groups, unless the requested work is specifically about that integration itself.",
  "Example: outbound/prospecting tasks for LinkedIn, Bookface, email, or founder lists belong together as one Outbound or Founder Outreach group when the objective is reaching prospects.",
  "Example: anything about tweaking the IDE itself — session titles, sidebar, sorting, notifications, browser dock, terminal panes, themes — is one IDE Tweaks group, not one group per surface.",
  "Example: sessions about setting up, running, or managing experiments and evals are one Experiments group.",
  "Keep unrelated sessions separate. Do not invent missing work.",
  "Order groups by operational importance: waiting/error/running sessions first, then larger or riskier blast radius, then recent work.",
  "Return strict JSON only with this shape: {\"groups\":[{\"label\":\"2-6 word intent label\",\"reason\":\"short reason\",\"nodeIds\":[\"node-id\"]}]}",
  "Every input nodeId must appear exactly once. Do not include markdown or commentary.",
].join("\n");

export interface TitleSortInput {
  nodeId: string;
  title: string;
  agentName?: string;
  status?: string;
  repo?: string;
  branch?: string;
  ticketTitle?: string;
  promptHistory?: string[];
  createdAt?: string;
}

export interface TitleSortGroup {
  label: string;
  reason?: string;
  nodeIds: string[];
}

export function loadTitleGenerationConfig(): {
  hasApiKey: boolean;
  model: string;
} {
  const env = loadEnvFile();
  const apiKey =
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  return {
    hasApiKey: !!apiKey,
    model: env.GEMINI_TITLE_MODEL || process.env.GEMINI_TITLE_MODEL || DEFAULT_MODEL,
  };
}

export function saveTitleGenerationApiKey(apiKey: string): void {
  updateEnvValue("GEMINI_API_KEY", apiKey.trim());
}

function getGeminiApiKey(): string | undefined {
  const env = loadEnvFile();
  return (
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
}

function getGeminiModel(): string {
  const env = loadEnvFile();
  return env.GEMINI_TITLE_MODEL || process.env.GEMINI_TITLE_MODEL || DEFAULT_MODEL;
}

function isBearerCredential(value: string): boolean {
  return value.startsWith("ya29.") || value.startsWith("AQ.");
}

function stripAnsi(value: string): string {
  return value
    // OSC sequences (window titles, hyperlinks): ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI sequences (colors, cursor movement): ESC [ ... final byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Two-character escapes (ESC M, ESC =, ESC >, ...)
    .replace(/\x1b[@-Z\\-_=>]/g, "");
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(AQ\.[A-Za-z0-9_-]{20,})\b/g, "[redacted-key]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted-key]")
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{72,}\b/g, "[redacted-token]");
}

function cleanPrompt(input: string): string {
  return redactSecrets(stripAnsi(input))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX_INPUT_CHARS);
}

function normalizeTitle(value: string): string {
  const title = value
    .replace(/^(title|session title)\s*[:.-]\s*/i, "")
    .replace(/[*`]+/g, "")
    .replace(/^["']+|["'.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return "";
  const withoutPunctuation = title.replace(/^[.!?;:,]+\s*/, "").replace(/[.!?;:]+$/g, "");
  const words = withoutPunctuation
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_MAX_WORDS);
  // Slice by code points so a multi-byte character is never split mid-way.
  return Array.from(words.join(" ")).slice(0, TITLE_MAX_CHARS).join("").trim();
}

const FALLBACK_TITLE_STOP_WORDS = new Set([
  "about",
  "actually",
  "also",
  "and",
  "are",
  "asking",
  "can",
  "change",
  "code",
  "configured",
  "could",
  "directory",
  "does",
  "easiest",
  "for",
  "from",
  "get",
  "give",
  "help",
  "im",
  "in",
  "how",
  "into",
  "is",
  "just",
  "last",
  "like",
  "look",
  "looks",
  "mean",
  "me",
  "need",
  "no",
  "noi",
  "now",
  "okay",
  "open",
  "per",
  "please",
  "right",
  "simple",
  "something",
  "take",
  "tell",
  "terms",
  "that",
  "the",
  "this",
  "through",
  "to",
  "understand",
  "use",
  "using",
  "way",
  "what",
  "whats",
  "why",
  "with",
  "you",
  "your",
]);

function titleTokens(value: string): string[] {
  return cleanPrompt(value)
    .toLowerCase()
    .replace(/\bhttps?:\/\/[^\s]+/g, " local-url ")
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FALLBACK_TITLE_STOP_WORDS.has(word));
}

function titleCaseToken(token: string): string {
  const acronym = {
    api: "API",
    cli: "CLI",
    pr: "PR",
    sdk: "SDK",
    ui: "UI",
    yc: "YC",
  }[token];
  if (acronym) return acronym;
  if (/^[A-Z0-9_-]+$/.test(token)) return token;
  if (/^[a-z]+-\d+$/i.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

// Slash-command prompts describe an IDE action, not work content. Title them
// by the higher-level task ("Model Selection"), never by raw args or flags —
// "/model claude-fable-5" must not become "Model Claude-fable-5".
const SLASH_COMMAND_INTENTS: { intent: string; commands: string[] }[] = [
  { intent: "Model Selection", commands: ["model", "effort", "fast", "output-style"] },
  { intent: "IDE Settings", commands: ["config", "settings", "theme", "statusline", "terminal-setup", "vim", "keybindings", "update-config"] },
  { intent: "Session Setup", commands: ["init", "clear", "compact", "context", "resume", "rewind", "memory", "add-dir"] },
  { intent: "Account & Login", commands: ["login", "logout", "upgrade"] },
  { intent: "Diagnostics", commands: ["doctor", "status", "health", "bug", "cost"] },
  { intent: "MCP Setup", commands: ["mcp"] },
  { intent: "Permissions Setup", commands: ["permissions", "allowed-tools", "fewer-permission-prompts"] },
  { intent: "Code Review", commands: ["review", "code-review", "security-review"] },
];

function slashCommandName(prompt: string): string | null {
  const match = cleanPrompt(prompt).match(/^\/([a-z][\w:-]*)/i);
  return match ? match[1].toLowerCase() : null;
}

function slashCommandIntent(command: string): string {
  for (const { intent, commands } of SLASH_COMMAND_INTENTS) {
    if (commands.includes(command)) return intent;
  }
  // Unknown command: name the command itself, still never its arguments.
  return `${titleCaseToken(command)} Command`;
}

// Non-null only when every prompt in the session is a slash command; mixed
// sessions fall through so real work prompts drive the title instead.
export function slashCommandSessionTitle(promptHistory: string[]): string | null {
  const prompts = promptHistory.map(cleanPrompt).filter(Boolean);
  if (prompts.length === 0) return null;
  const commands = prompts.map(slashCommandName);
  if (commands.some((command) => command === null)) return null;
  const intents: string[] = [];
  for (const command of commands as string[]) {
    const intent = slashCommandIntent(command);
    if (!intents.includes(intent)) intents.push(intent);
  }
  return normalizeTitle(intents.slice(0, 2).join(" & ")) || null;
}

export function fallbackSessionTitle(input: string): string {
  const prompt = cleanPrompt(input);
  if (!prompt) return "Untitled session";
  const commandTitle = slashCommandSessionTitle([prompt]);
  if (commandTitle) return commandTitle;
  const compact = prompt
    .replace(/^(please|can you|could you|hey|mate|hi|hello)\b[\s,:-]*/i, "")
    .replace(/\b(use|using)\s+(codex|claude|gemini)\b/gi, "")
    .trim();
  const title = normalizeTitle(compact);
  if (!title) return "Untitled session";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function fallbackSessionTitleFromHistory(input: string, promptHistory?: string[]): string {
  let history = (promptHistory && promptHistory.length > 0 ? promptHistory : [input])
    .map(cleanPrompt)
    .filter(Boolean)
    .slice(-8);
  const commandTitle = slashCommandSessionTitle(history);
  if (commandTitle) return commandTitle;
  // Mixed sessions: slash commands are IDE plumbing, not the work thread.
  const workPrompts = history.filter((prompt) => !slashCommandName(prompt));
  if (workPrompts.length > 0) history = workPrompts;
  if (history.length <= 1) return fallbackSessionTitle(history[0] || input);

  const tokenStats = new Map<string, { score: number; firstSeen: number }>();
  const start = Math.max(0, history.length - 3);
  let recentHistory = history.slice(start).filter((prompt) => {
    const tokens = titleTokens(prompt);
    const isWeakQuestion = /^(is|are|do|does|did|no|yes)\b/i.test(prompt);
    return tokens.length > 0 && !(isWeakQuestion && tokens.length <= 2);
  });
  if (recentHistory.length === 0) recentHistory = history.slice(start);

  recentHistory.forEach((prompt, index) => {
    const tokens = Array.from(new Set(titleTokens(prompt))).slice(0, 16);
    const recencyWeight = 1 + index / Math.max(1, recentHistory.length - 1) * 0.35;
    tokens.forEach((token, tokenIndex) => {
      const existing = tokenStats.get(token);
      const score = recencyWeight + Math.max(0, 0.25 - tokenIndex * 0.02);
      if (existing) {
        existing.score += score;
      } else {
        tokenStats.set(token, {
          score,
          firstSeen: index * 100 + tokenIndex,
        });
      }
    });
  });

  const titleWords = Array.from(tokenStats.entries())
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return a[1].firstSeen - b[1].firstSeen;
    })
    .slice(0, 5)
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    .map(([token]) => titleCaseToken(token));

  const title = normalizeTitle(titleWords.join(" "));
  return title || fallbackSessionTitle(history[0] || input);
}

export async function generateSessionTitle({
  prompt,
  promptHistory,
  agentName,
  cwd,
  ticketTitle,
  gitBranch,
}: {
  prompt: string;
  promptHistory?: string[];
  agentName?: string;
  cwd?: string;
  ticketTitle?: string;
  gitBranch?: string;
}): Promise<string> {
  const safePromptHistory = (promptHistory && promptHistory.length > 0 ? promptHistory : [prompt])
    .map(cleanPrompt)
    .filter(Boolean)
    .slice(-8);
  // All-command sessions have a deterministic intent title; skip the LLM call.
  const commandTitle = slashCommandSessionTitle(safePromptHistory);
  if (commandTitle) return commandTitle;
  const fallback = fallbackSessionTitleFromHistory(prompt, safePromptHistory);
  const apiKey = getGeminiApiKey();
  if (!apiKey) return fallback;

  const model = getGeminiModel();
  if (safePromptHistory.length === 0) return fallback;

  const context = [
    agentName ? `Agent: ${agentName}` : "",
    ticketTitle ? `Ticket title: ${cleanPrompt(ticketTitle)}` : "",
    gitBranch ? `Branch: ${cleanPrompt(gitBranch)}` : "",
    cwd ? `Working directory: ${cleanPrompt(cwd).split("/").slice(-3).join("/")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const bearer = isBearerCredential(apiKey);
    const res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent${bearer ? "" : `?key=${encodeURIComponent(apiKey)}`}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: GEMINI_TITLE_SYSTEM_PROMPT,
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    context,
                    "User prompts, oldest to newest:",
                    ...safePromptHistory.map((item, index) => `${index + 1}. ${item}`),
                  ].filter(Boolean).join("\n"),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 48,
          },
        }),
      },
    );

    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join(" ") || "";
    const title = normalizeTitle(raw);
    return title || fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value: string): any | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function generateTitleSortGroups(items: TitleSortInput[]): Promise<TitleSortGroup[] | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || items.length === 0) return null;

  const model = getGeminiModel();
  const payload = items.map((item) => ({
    nodeId: item.nodeId,
    title: cleanPrompt(item.title).slice(0, 180),
    agentName: item.agentName,
    status: item.status,
    repo: item.repo,
    branch: item.branch,
    ticketTitle: item.ticketTitle ? cleanPrompt(item.ticketTitle).slice(0, 180) : undefined,
    promptHistory: item.promptHistory
      ?.map(cleanPrompt)
      .filter(Boolean)
      .slice(-5)
      .map((prompt) => prompt.slice(0, 240)),
    createdAt: item.createdAt,
  }));

  try {
    const bearer = isBearerCredential(apiKey);
    const res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent${bearer ? "" : `?key=${encodeURIComponent(apiKey)}`}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: GEMINI_SORT_SYSTEM_PROMPT }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Cluster these sessions by durable work intent:\n${JSON.stringify(payload)}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: Math.min(4096, 512 + items.length * 96),
          },
        }),
      },
    );

    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join(" ") || "";
    const parsed = parseJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return null;

    const inputIds = new Set(items.map((item) => item.nodeId));
    const seen = new Set<string>();
    const groups: TitleSortGroup[] = [];
    for (const group of parsed.groups) {
      if (!group || !Array.isArray(group.nodeIds)) continue;
      const nodeIds: string[] = group.nodeIds
        .filter((id: unknown): id is string => typeof id === "string" && inputIds.has(id) && !seen.has(id));
      if (nodeIds.length === 0) continue;
      nodeIds.forEach((id: string) => seen.add(id));
      const label = normalizeTitle(String(group.label || "Related Work")) || "Related Work";
      groups.push({
        label,
        reason: typeof group.reason === "string" ? group.reason.slice(0, 180) : undefined,
        nodeIds,
      });
    }

    for (const item of items) {
      if (!seen.has(item.nodeId)) {
        groups.push({ label: normalizeTitle(item.title) || "Related Work", nodeIds: [item.nodeId] });
      }
    }

    return groups.length > 0 ? groups : null;
  } catch {
    return null;
  }
}
