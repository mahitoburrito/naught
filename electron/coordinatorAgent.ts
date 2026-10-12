import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { DEFAULT_COORDINATOR_MODEL } from "../server/services/coordinatorAgentConfig";
import { INTERACTION_TOOL_NAMES, interactionInput } from "./coordinatorTools";
import type { CoordinatorTools, ToolRunResult } from "./coordinatorTools";
import type {
  CoordinatorAgentState,
  CoordinatorFeedEvent,
  InteractionPayload,
  InteractionResponse,
} from "./coordinatorAgentTypes";

/**
 * The Workspace Coordinator's brain: one Claude tool-use turn per directive,
 * run as a manual loop so user follow-ups can be injected between steps and
 * the interaction tools can block on the renderer.
 */

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type StreamOptions = Parameters<Anthropic["beta"]["messages"]["stream"]>[1];

/** The slice of the Anthropic client the agent uses. Tests pass a scripted fake. */
export interface CoordinatorClient {
  beta: {
    messages: {
      stream(params: StreamParams, options?: StreamOptions): { finalMessage(): Promise<Anthropic.Beta.BetaMessage> };
    };
  };
}

export interface CoordinatorAgentOptions {
  client: CoordinatorClient;
  tools: CoordinatorTools;
  model?: string;
  /** Called with a snapshot after every state change. */
  onState?: (state: CoordinatorAgentState) => void;
  /** Called when a turn needs the user's answer or approval. */
  onInteraction?: (payload: InteractionPayload) => void;
  /** Safety cap on API calls per turn. */
  maxSteps?: number;
}

export const COORDINATOR_PREAMBLE =
  "You are the OpenUI workspace Coordinator. Monitor coding-agent sessions and help the user keep their work consistent. " +
  "Inspect current coordination state before acting. Use exact session IDs for every mutation. Record durable decisions when " +
  "multiple agents need the same conclusion. Send concise directives only when they are necessary, and explain queued or " +
  "unconfirmed delivery honestly. Never infer that terminal submission means an agent understood the directive. Do not answer " +
  "permission prompts, perform destructive lifecycle actions, ship, deploy, merge, or broaden scope without the user's explicit " +
  "instruction; use request_confirmation when a directive leaves that unclear, and ask_user when the target is ambiguous. " +
  "Finish with a short plain-language report of what you inspected, what you recorded or queued, and anything the user must do next.";

const DEFAULT_MAX_STEPS = 40;
const MAX_TOKENS = 32000;
const MAX_DETAIL_CHARS = 4000;

class CoordinatorTurnError extends Error {}

function emptyState(): CoordinatorAgentState {
  return {
    isRunning: false,
    currentDirective: "",
    events: [],
    report: "",
    resolvedInteractions: [],
    conversationHistory: [],
    completedTurns: [],
  };
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n[truncated]` : text;
}

export function describeCoordinatorError(error: unknown): string {
  if (error instanceof CoordinatorTurnError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API rejected the key. Update it in Settings → Coordination.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The Anthropic API is rate limiting requests. Try again shortly.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `Could not reach the Anthropic API: ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error${error.status ? ` ${error.status}` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class CoordinatorAgent {
  private state: CoordinatorAgentState = emptyState();
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private queuedMessages: string[] = [];
  private abort: AbortController | null = null;
  private cancelled = false;
  private pending: { payload: InteractionPayload; resolve: (response: InteractionResponse | null) => void } | null = null;

  constructor(private readonly options: CoordinatorAgentOptions) {}

  getState(): CoordinatorAgentState {
    return structuredClone(this.state);
  }

  /** Run one coordinator turn. Resolves when the turn ends, however it ends. */
  async startTurn(directive: string): Promise<void> {
    if (this.state.isRunning) throw new Error("A coordinator turn is already running");
    this.state = {
      ...emptyState(),
      completedTurns: this.state.completedTurns,
      isRunning: true,
      currentDirective: directive,
      conversationHistory: [{ role: "user", content: directive }],
    };
    this.messages = [{ role: "user", content: directive }];
    this.queuedMessages = [];
    this.cancelled = false;
    this.abort = new AbortController();
    this.emit();

    let succeeded = false;
    try {
      await this.runLoop();
      succeeded = !this.cancelled;
    } catch (error) {
      if (!this.cancelled) {
        this.state.error = describeCoordinatorError(error);
        console.error("[coordinator-agent] Turn failed:", this.state.error);
      }
    } finally {
      if (succeeded) this.recordCompletedTurn();
      this.state.isRunning = false;
      this.abort = null;
      this.emit();
    }
  }

  /** Abort the in-flight request and any pending interaction. */
  cancel(): void {
    if (!this.state.isRunning) return;
    this.cancelled = true;
    this.abort?.abort();
    this.pending?.resolve(null);
    this.addEvent("Cancelled", undefined, true);
    this.state.isRunning = false;
    this.emit();
  }

  /** Queue a user follow-up; it is sent to the model before its next step. */
  sendMessage(text: string): boolean {
    if (!this.state.isRunning) return false;
    this.queuedMessages.push(text);
    return true;
  }

  respondToInteraction(interactionId: string, response: InteractionResponse): boolean {
    if (!this.pending || this.pending.payload.interactionId !== interactionId) return false;
    this.pending.resolve(response);
    return true;
  }

  // ---------------------------------------------------------------- loop

  private async runLoop(): Promise<void> {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    for (let step = 1; step <= maxSteps; step++) {
      this.drainQueuedMessages();
      const stream = this.options.client.beta.messages.stream(this.requestParams(), { signal: this.abort!.signal });
      const message = await stream.finalMessage();
      if (this.cancelled) return;

      this.messages.push({ role: "assistant", content: message.content });
      const toolUses = this.recordAssistantBlocks(message);

      switch (message.stop_reason) {
        case "refusal":
          throw new CoordinatorTurnError("Claude declined this directive.");
        case "max_tokens":
          throw new CoordinatorTurnError("The coordinator's response was cut off at the token limit.");
        case "pause_turn":
          continue;
        case "tool_use":
          break;
        default:
          this.finishWithReport(message);
          return;
      }
      if (toolUses.length === 0) {
        this.finishWithReport(message);
        return;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await this.executeTool(toolUse);
        if (this.cancelled) return;
        results.push(result);
      }
      this.messages.push({ role: "user", content: results });
      this.emit();
    }
    throw new CoordinatorTurnError(`Coordinator stopped after ${maxSteps} steps without finishing.`);
  }

  private requestParams(): StreamParams {
    return {
      model: this.options.model ?? DEFAULT_COORDINATOR_MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: COORDINATOR_PREAMBLE, cache_control: { type: "ephemeral" } }],
      tools: this.options.tools.definitions,
      messages: this.messages.slice(),
      thinking: { type: "adaptive", display: "summarized" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  }

  private drainQueuedMessages(): void {
    if (this.queuedMessages.length === 0) return;
    const texts = this.queuedMessages.splice(0);
    this.messages.push({ role: "user", content: texts.map((text) => ({ type: "text", text })) });
    for (const text of texts) this.state.conversationHistory.push({ role: "user", content: text });
    this.emit();
  }

  private recordAssistantBlocks(message: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaToolUseBlock[] {
    const toolUses: Anthropic.Beta.BetaToolUseBlock[] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (block.thinking.trim()) this.addEvent("Thinking", block.thinking, true);
      } else if (block.type === "text") {
        if (block.text.trim()) {
          this.state.agentMessage = block.text;
          this.state.conversationHistory.push({ role: "assistant", content: block.text });
        }
      } else if (block.type === "tool_use") {
        toolUses.push(block);
      }
    }
    this.emit();
    return toolUses;
  }

  private finishWithReport(message: Anthropic.Beta.BetaMessage): void {
    const texts = message.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text");
    this.state.report = texts.length > 0 ? texts[texts.length - 1].text : this.state.agentMessage || "";
    this.emit();
  }

  private async executeTool(toolUse: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const inputJson = JSON.stringify(toolUse.input, null, 2);
    const event = this.addEvent(toolUse.name, inputJson, false);
    const result = (INTERACTION_TOOL_NAMES as readonly string[]).includes(toolUse.name)
      ? await this.runInteraction(toolUse)
      : await this.options.tools.run(toolUse.name, toolUse.input);
    event.isCompleted = true;
    event.detail = truncate(`${inputJson}\n→ ${result.content}`);
    this.emit();
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    };
  }

  private async runInteraction(toolUse: Anthropic.Beta.BetaToolUseBlock): Promise<ToolRunResult> {
    const input = interactionInput(this.options.tools.definitions, toolUse.name, toolUse.input);
    if (!input) return { content: `Invalid input for ${toolUse.name}`, isError: true };
    const interactionId = randomUUID();
    const payload: InteractionPayload =
      toolUse.name === "ask_user"
        ? { type: "ask_question", interactionId, question: input.question, ...(input.context ? { context: input.context } : {}) }
        : { type: "request_confirmation", interactionId, action: input.action, detail: input.detail, ...(input.reason ? { reason: input.reason } : {}) };

    const response = await new Promise<InteractionResponse | null>((resolve) => {
      this.pending = { payload, resolve };
      this.state.pendingInteraction = payload;
      this.emit();
      this.options.onInteraction?.(payload);
    });
    this.pending = null;
    this.state.pendingInteraction = undefined;
    if (!response) return { content: "Cancelled before the user answered", isError: true };

    this.state.resolvedInteractions.push({ interactionId, payload, response });
    if (response.type === "ask_question") return { content: `User answered: ${response.answer}`, isError: false };
    return { content: `${response.approved ? "User approved" : "User denied"}: ${input.action}`, isError: false };
  }

  private recordCompletedTurn(): void {
    this.state.completedTurns.push({
      id: randomUUID(),
      directive: this.state.currentDirective,
      report: this.state.report,
      events: this.state.events,
      resolvedInteractions: this.state.resolvedInteractions,
      conversationHistory: this.state.conversationHistory,
      completedAt: new Date().toISOString(),
    });
  }

  private addEvent(label: string, detail: string | undefined, completed: boolean): CoordinatorFeedEvent {
    const event: CoordinatorFeedEvent = { id: randomUUID(), label, detail, isCompleted: completed, isExpanded: false };
    this.state.events.push(event);
    this.emit();
    return event;
  }

  private emit(): void {
    this.options.onState?.(this.getState());
  }
}
