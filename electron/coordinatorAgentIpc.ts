import { BrowserWindow, ipcMain } from "electron";
import Anthropic from "@anthropic-ai/sdk";
import { homedir } from "os";
import {
  loadCoordinatorAgentConfig,
  resolveCoordinatorCredentials,
} from "../server/services/coordinatorAgentConfig";
import { CoordinatorAgent } from "./coordinatorAgent";
import { createCoordinatorTools } from "./coordinatorTools";
import type { InteractionResponse } from "./coordinatorAgentTypes";

/**
 * Electron glue for the coordinator agent: builds the real Anthropic client and
 * tools, registers the coordinator-agent:* IPC handlers and forwards state to
 * the renderer. Everything with behaviour lives in coordinatorAgent.ts.
 */

const NO_KEY_MESSAGE = "Add an Anthropic API key in Settings → Integrations → Coordination to use the coordinator.";

let mainWindowRef: BrowserWindow | null = null;
let agent: CoordinatorAgent | null = null;
let agentApiKey: string | null = null;

function send(channel: string, payload: unknown) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}

function getAgent(serverPort: number): CoordinatorAgent | { error: string } {
  const config = loadCoordinatorAgentConfig();
  const credentials = resolveCoordinatorCredentials(config);
  if (!credentials.apiKey) return { error: NO_KEY_MESSAGE };
  // A key saved mid-turn applies to the next turn; swapping the agent under a
  // running turn would let its final state emission clobber the new agent's.
  if (agent && (agentApiKey === credentials.apiKey || agent.getState().isRunning)) return agent;

  agentApiKey = credentials.apiKey;
  agent = new CoordinatorAgent({
    client: new Anthropic({ apiKey: credentials.apiKey }),
    model: config.model,
    tools: createCoordinatorTools({ serverPort, launchCwd: process.env.LAUNCH_CWD || homedir() }),
    onState: (state) => send("coordinator-agent:state", state),
    onInteraction: (payload) => send("coordinator-agent:interaction", payload),
  });
  console.log("[coordinator-agent] Agent ready");
  return agent;
}

export function initCoordinatorAgent(mainWindow: BrowserWindow, serverPort: number) {
  mainWindowRef = mainWindow;

  ipcMain.handle("coordinator-agent:is-available", async () => {
    const credentials = resolveCoordinatorCredentials(loadCoordinatorAgentConfig());
    return { hasApiKey: !!credentials.apiKey, source: credentials.source };
  });

  ipcMain.handle("coordinator-agent:start-turn", async (_event, { directive }: { directive: string }) => {
    const current = getAgent(serverPort);
    if (!(current instanceof CoordinatorAgent)) return { success: false, error: current.error };
    if (current.getState().isRunning) return { success: false, error: "A coordinator turn is already running" };
    // The turn runs until it ends; the renderer follows it over coordinator-agent:state.
    current.startTurn(directive).catch((err) => {
      console.error("[coordinator-agent] Turn crashed:", err);
    });
    return { success: true };
  });

  ipcMain.handle("coordinator-agent:cancel", async () => {
    agent?.cancel();
    return { success: true };
  });

  ipcMain.handle("coordinator-agent:send-message", async (_event, { message }: { message: string }) => {
    if (agent?.sendMessage(message)) return { success: true };
    return { success: false, error: "No coordinator turn is running" };
  });

  ipcMain.handle(
    "coordinator-agent:respond-interaction",
    async (_event, { interactionId, response }: { interactionId: string; response: InteractionResponse }) => {
      if (agent?.respondToInteraction(interactionId, response)) return { success: true };
      return { success: false, error: "No pending interaction with that ID" };
    },
  );

  ipcMain.handle("coordinator-agent:get-state", async () => agent?.getState() ?? null);

  console.log("[coordinator-agent] IPC handlers registered");
}

export function cleanupCoordinatorAgent() {
  agent?.cancel();
  agent = null;
  agentApiKey = null;
}
