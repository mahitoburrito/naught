import type Anthropic from "@anthropic-ai/sdk";
import { loadBuffer as loadPersistedBuffer } from "../server/services/persistence";
import type { LoadedTerminalBuffer } from "../server/services/persistence";

/**
 * The coordinator's tools. Eight act on the embedded OpenUI server over HTTP;
 * two (INTERACTION_TOOL_NAMES) block on the user and are executed by the agent.
 */

export const INTERACTION_TOOL_NAMES = ["ask_user", "request_confirmation"] as const;

export interface ToolRunResult {
  content: string;
  isError: boolean;
}

export interface ToolRunOptions {
  /** Aborting it cancels the tool's HTTP request. */
  signal?: AbortSignal;
}

export interface CoordinatorTools {
  definitions: Anthropic.Beta.BetaTool[];
  run(name: string, input: unknown, options?: ToolRunOptions): Promise<ToolRunResult>;
}

export interface CoordinatorToolsOptions {
  serverPort: number;
  fetch?: typeof globalThis.fetch;
  /** Reads a session's persisted scrollback; defaults to the app's own loader. */
  loadBuffer?: (sessionId: string) => LoadedTerminalBuffer;
}

type StringParams = Record<string, string>;

interface ToolSpec {
  name: string;
  description: string;
  params: { name: string; description: string; required: boolean }[];
  /** Absent for interaction tools, which the agent executes. */
  handler?: (input: StringParams, signal?: AbortSignal) => Promise<string>;
}

const MAX_OUTPUT_CHARS = 5000;
/** Cap on what one tool result feeds back into the model's context. */
const MAX_RESULT_CHARS = 20_000;

export function createCoordinatorTools(options: CoordinatorToolsOptions): CoordinatorTools {
  const doFetch = options.fetch ?? globalThis.fetch;
  const loadBuffer = options.loadBuffer ?? loadPersistedBuffer;
  const base = `http://localhost:${options.serverPort}`;

  async function request(path: string, init?: RequestInit, signal?: AbortSignal): Promise<string> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      signal,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const body: any = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
    }
    return JSON.stringify(body, null, 2);
  }

  const specs: ToolSpec[] = [
    {
      name: "list_active_sessions",
      description:
        "List every OpenUI coding-agent session with its status, agent type, working directory and branch. Call this first whenever a directive mentions sessions, agents or 'everyone', and before any send_directive, to get exact session IDs.",
      params: [],
      handler: (_input, signal) => request("/api/sessions", undefined, signal),
    },
    {
      name: "get_session_status",
      description:
        "Get the detailed status of one session, including its current tool and hook event. Call it when you need to know whether an exact session is idle, working or waiting for input.",
      params: [{ name: "sessionId", description: "Exact session ID from list_active_sessions", required: true }],
      handler: (input, signal) => request(`/api/sessions/${encodeURIComponent(input.sessionId)}/status`, undefined, signal),
    },
    {
      name: "read_session_output",
      description:
        "Read the last part of a session's persisted terminal output (it can lag the live terminal by up to ten seconds). Use it only when get_session_activity is not enough, for example to see an agent's latest reply verbatim.",
      params: [{ name: "sessionId", description: "Exact session ID", required: true }],
      handler: async (input) => {
        // The id names a file under the buffers dir; never let it walk out of it.
        if (/[\/\\]|\.\./.test(input.sessionId)) {
          throw new Error("Invalid input for read_session_output: sessionId must be a plain session ID");
        }
        const content = loadBuffer(input.sessionId).chunks.join("");
        if (!content) return "(no output buffer found for this session)";
        if (content.length > MAX_OUTPUT_CHARS) {
          return `[truncated to last ${MAX_OUTPUT_CHARS} chars]\n${content.slice(-MAX_OUTPUT_CHARS)}`;
        }
        return content;
      },
    },
    {
      name: "get_session_activity",
      description:
        "Read the recent structured command activity of one exact session. Prefer this over read_session_output when working out what an agent has been doing.",
      params: [{ name: "sessionId", description: "Exact session ID from list_active_sessions", required: true }],
      handler: (input, signal) => request(`/api/sessions/${encodeURIComponent(input.sessionId)}/blocks?limit=12`, undefined, signal),
    },
    {
      name: "get_coordination_state",
      description:
        "Get the authoritative coordinator snapshot: session readiness, active decisions, directive queues and recent coordination events. Call it before recording a decision or sending a directive.",
      params: [],
      handler: (_input, signal) => request("/api/coordinator/snapshot", undefined, signal),
    },
    {
      name: "record_decision",
      description:
        "Record a durable, versioned decision shared across the workspace. Call it when several agents need the same conclusion. Requires a prior approved request_confirmation whose detail is exactly this choice. If the topic already has an active decision, pass its exact ID as supersedes.",
      params: [
        { name: "topic", description: "Stable decision topic", required: true },
        { name: "choice", description: "The chosen direction", required: true },
        { name: "rationale", description: "Why this choice was made", required: true },
        { name: "sessionIds", description: "Optional comma-separated exact session IDs; omit for workspace scope", required: false },
        { name: "supersedes", description: "Exact active decision ID this replaces", required: false },
      ],
      handler: async (input, signal) => {
        const sessionIds = (input.sessionIds || "").split(",").map((item) => item.trim()).filter(Boolean);
        try {
          return await request("/api/coordinator/decisions", {
            method: "POST",
            body: JSON.stringify({
              topic: input.topic,
              choice: input.choice,
              rationale: input.rationale,
              scope: sessionIds.length > 0 ? { kind: "sessions", sessionIds } : { kind: "workspace" },
              supersedes: input.supersedes || undefined,
              author: "coordinator",
            }),
          }, signal);
        } catch (e: any) {
          throw new Error(`Decision was not recorded: ${e.message}`);
        }
      },
    },
    {
      name: "send_directive",
      description:
        "Queue a directive for one exact coding-agent session. Requires a prior approved request_confirmation whose detail is exactly this text. Delivery happens only while that agent is idle and stays unconfirmed until acknowledged. Never pass a display title as the target; use the session ID.",
      params: [
        { name: "sessionId", description: "Exact target session ID", required: true },
        { name: "text", description: "Concise directive for the worker agent", required: true },
        { name: "decisionId", description: "Optional active decision ID supporting the directive", required: false },
        { name: "clientRequestId", description: "Optional stable idempotency key for retry safety", required: false },
      ],
      handler: async (input, signal) => {
        // A directive is pasted and submitted into the target's terminal; a
        // plain shell would run every line as a command.
        if (await isPlainShell(input.sessionId, signal)) {
          throw new Error(`Directive was not queued: session ${input.sessionId} is a plain shell, not a coding agent`);
        }
        try {
          return await request("/api/coordinator/directives", {
            method: "POST",
            body: JSON.stringify({
              sessionId: input.sessionId,
              text: input.text,
              decisionId: input.decisionId || undefined,
              clientRequestId: input.clientRequestId || undefined,
              author: "coordinator",
            }),
          }, signal);
        } catch (e: any) {
          throw new Error(`Directive was not queued: ${e.message}`);
        }
      },
    },
    {
      name: "acknowledge_directive",
      description:
        "Acknowledge a submitted directive after its target agent has confirmed incorporating it. Never call it just because the text was submitted to the terminal.",
      params: [{ name: "directiveId", description: "Exact directive ID", required: true }],
      handler: async (input, signal) => {
        try {
          return await request(`/api/coordinator/directives/${encodeURIComponent(input.directiveId)}/acknowledge`, {
            method: "POST",
            body: "{}",
          }, signal);
        } catch (e: any) {
          throw new Error(`Directive was not acknowledged: ${e.message}`);
        }
      },
    },
    {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their typed answer. Call it when a directive is ambiguous about which session, decision or scope it means.",
      params: [
        { name: "question", description: "The question to show the user", required: true },
        { name: "context", description: "Optional short context shown under the question", required: false },
      ],
    },
    {
      name: "request_confirmation",
      description:
        "Ask the user to approve or deny an action before you take it. Call it before sending a directive or recording a decision the user did not explicitly ask for.",
      params: [
        { name: "action", description: "One-line summary of what you want to do", required: true },
        { name: "detail", description: "The exact directive text or decision you would record", required: true },
        { name: "reason", description: "Optional reason the action is needed", required: false },
      ],
    },
  ];

  // Only refuses when the session list is readable and names the target as a
  // shell; anything else is left to the server's own validation.
  async function isPlainShell(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await doFetch(`${base}/api/sessions`, { signal });
      const sessions: unknown = await response.json();
      if (!Array.isArray(sessions)) return false;
      const target = sessions.find((s) => s && typeof s === "object" && (s as any).sessionId === sessionId);
      return !!target && (target as any).agentId === "shell";
    } catch {
      return false;
    }
  }

  // Inputs are tiny, so the API's buffered validation beats eager streaming.
  const definitions: Anthropic.Beta.BetaTool[] = specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        spec.params.map((param) => [param.name, { type: "string", description: param.description }]),
      ),
      required: spec.params.filter((param) => param.required).map((param) => param.name),
    },
  }));

  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  function validate(spec: ToolSpec, input: unknown): string | null {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return `Invalid input for ${spec.name}: expected an object`;
    }
    const record = input as Record<string, unknown>;
    for (const param of spec.params) {
      if (param.required && !(param.name in record)) {
        return `Invalid input for ${spec.name}: missing required field ${param.name}`;
      }
      if (param.name in record && typeof record[param.name] !== "string") {
        return `Invalid input for ${spec.name}: field ${param.name} must be a string`;
      }
    }
    return null;
  }

  async function run(name: string, input: unknown, runOptions?: ToolRunOptions): Promise<ToolRunResult> {
    const spec = byName.get(name);
    if (!spec) return { content: `Unknown tool: ${name}`, isError: true };
    const problem = validate(spec, input);
    if (problem) return { content: problem, isError: true };
    if (!spec.handler) {
      return { content: `${name} must be answered by the user; the agent handles it`, isError: true };
    }
    try {
      return { content: capResult(await spec.handler(input as StringParams, runOptions?.signal)), isError: false };
    } catch (e: any) {
      return { content: e?.message || String(e), isError: true };
    }
  }

  return { definitions, run };
}

function capResult(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;
  return `${content.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${content.length - MAX_RESULT_CHARS} more characters]`;
}

/** Validate and type a tool input without running it (used by the agent for interaction tools). */
export function interactionInput(definitions: Anthropic.Beta.BetaTool[], name: string, input: unknown): StringParams | null {
  const def = definitions.find((d) => d.name === name);
  if (!def || typeof input !== "object" || input === null) return null;
  const required = (def.input_schema.required as string[] | undefined) || [];
  const record = input as Record<string, unknown>;
  for (const key of required) if (typeof record[key] !== "string") return null;
  for (const value of Object.values(record)) if (typeof value !== "string") return null;
  return record as StringParams;
}
