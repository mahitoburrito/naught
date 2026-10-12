/**
 * Types shared by the coordinator agent, its IPC wrapper and (mirrored in
 * client/src/types/coordinatorAgent.ts) the renderer. No Node imports here.
 */

/** One row in the coordinator panel's activity feed. */
export interface CoordinatorFeedEvent {
  id: string;
  label: string;
  detail?: string;
  isCompleted: boolean;
  isExpanded: boolean;
}

export type InteractionPayload =
  | { type: "ask_question"; interactionId: string; question: string; context?: string }
  | { type: "request_confirmation"; interactionId: string; action: string; detail: string; reason?: string };

export type InteractionResponse =
  | { type: "ask_question"; answer: string }
  | { type: "request_confirmation"; approved: boolean };

export interface ResolvedInteraction {
  interactionId: string;
  payload: InteractionPayload;
  response: InteractionResponse;
}

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

export interface CompletedTurn {
  id: string;
  directive: string;
  report: string;
  events: CoordinatorFeedEvent[];
  resolvedInteractions: ResolvedInteraction[];
  conversationHistory: ConversationEntry[];
  completedAt: string;
}

export interface CoordinatorAgentState {
  isRunning: boolean;
  currentDirective: string;
  events: CoordinatorFeedEvent[];
  report: string;
  error?: string;
  agentMessage?: string;
  pendingInteraction?: InteractionPayload;
  resolvedInteractions: ResolvedInteraction[];
  conversationHistory: ConversationEntry[];
  completedTurns: CompletedTurn[];
}
