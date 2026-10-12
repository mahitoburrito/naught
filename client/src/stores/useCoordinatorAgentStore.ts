import { create } from "zustand";
import type {
  CoordinatorAgentState,
  CoordinatorCredentialSource,
  InteractionPayload,
  InteractionResponse,
} from "../types/coordinatorAgent";

interface CoordinatorAgentStore extends CoordinatorAgentState {
  /** True inside the desktop app, where the agent lives. */
  isAvailable: boolean;
  hasApiKey: boolean;
  credentialSource: CoordinatorCredentialSource;
  panelOpen: boolean;

  setPanelOpen: (open: boolean) => void;
  checkAvailability: () => Promise<void>;
  startTurn: (directive: string) => Promise<void>;
  cancelTurn: () => Promise<void>;
  respondToInteraction: (interactionId: string, response: InteractionResponse) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;

  // Internal — called by IPC listeners
  _onState: (state: CoordinatorAgentState) => void;
  _onInteraction: (payload: InteractionPayload) => void;
}

const idleState: CoordinatorAgentState = {
  isRunning: false,
  currentDirective: "",
  events: [],
  report: "",
  resolvedInteractions: [],
  conversationHistory: [],
  completedTurns: [],
};

export const useCoordinatorAgentStore = create<CoordinatorAgentStore>((set, get) => ({
  ...idleState,
  isAvailable: false,
  hasApiKey: false,
  credentialSource: null,
  panelOpen: false,

  setPanelOpen: (open) => set({ panelOpen: open }),

  checkAvailability: async () => {
    const api = window.electronAPI;
    if (!api?.isElectron) {
      set({ isAvailable: false });
      return;
    }
    try {
      const result = await api.invoke("coordinator-agent:is-available");
      set({ isAvailable: true, hasApiKey: !!result?.hasApiKey, credentialSource: result?.source ?? null });
      const state = await api.invoke("coordinator-agent:get-state");
      if (state) get()._onState(state);
    } catch {
      set({ isAvailable: true, hasApiKey: false, credentialSource: null });
    }
  },

  startTurn: async (directive) => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;
    set({
      isRunning: true,
      currentDirective: directive,
      events: [],
      report: "",
      error: undefined,
      agentMessage: undefined,
      pendingInteraction: undefined,
      resolvedInteractions: [],
      conversationHistory: [],
    });
    try {
      const result = await api.invoke("coordinator-agent:start-turn", { directive });
      if (!result?.success) {
        set({ isRunning: false, error: result?.error || "The coordinator could not start" });
      }
    } catch (e) {
      console.error("[coordinator] Failed to start turn:", e);
      set({ isRunning: false, error: "The coordinator could not start" });
    }
  },

  cancelTurn: async () => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;
    try {
      await api.invoke("coordinator-agent:cancel");
    } catch (e) {
      console.error("[coordinator] Failed to cancel turn:", e);
    }
  },

  respondToInteraction: async (interactionId, response) => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;
    try {
      await api.invoke("coordinator-agent:respond-interaction", { interactionId, response });
      set({ pendingInteraction: undefined });
    } catch (e) {
      console.error("[coordinator] Failed to respond to interaction:", e);
    }
  },

  sendMessage: async (message) => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;
    try {
      await api.invoke("coordinator-agent:send-message", { message });
    } catch (e) {
      console.error("[coordinator] Failed to send message:", e);
    }
  },

  _onState: (state) => set({ ...state }),

  _onInteraction: (payload) => set({ pendingInteraction: payload }),
}));
