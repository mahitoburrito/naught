import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Settings for the Claude-backed workspace coordinator agent. */
export interface CoordinatorAgentConfig {
  /** Anthropic API key saved from Settings. Absent when the user never saved one. */
  apiKey?: string;
  /** Model override; the agent uses DEFAULT_COORDINATOR_MODEL when absent. */
  model?: string;
}

export type CoordinatorCredentialSource = "settings" | "env" | null;

export interface CoordinatorCredentials {
  apiKey: string | undefined;
  source: CoordinatorCredentialSource;
}

export const DEFAULT_COORDINATOR_MODEL = "claude-opus-5";

function defaultLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

export function coordinatorAgentConfigPath(launchCwd: string = defaultLaunchCwd()): string {
  return join(launchCwd, ".openui-desktop", "coordinator-agent.json");
}

export function loadCoordinatorAgentConfig(launchCwd: string = defaultLaunchCwd()): CoordinatorAgentConfig {
  const file = coordinatorAgentConfigPath(launchCwd);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const config: CoordinatorAgentConfig = {};
    if (typeof raw.apiKey === "string" && raw.apiKey) config.apiKey = raw.apiKey;
    if (typeof raw.model === "string" && raw.model) config.model = raw.model;
    return config;
  } catch (e) {
    console.error("[coordinator-agent] Failed to read config:", e);
    return {};
  }
}

export function saveCoordinatorAgentConfig(
  config: CoordinatorAgentConfig,
  launchCwd: string = defaultLaunchCwd(),
): void {
  const dir = join(launchCwd, ".openui-desktop");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stored: CoordinatorAgentConfig = {};
  if (config.apiKey) stored.apiKey = config.apiKey;
  if (config.model) stored.model = config.model;
  writeFileSync(coordinatorAgentConfigPath(launchCwd), JSON.stringify(stored, null, 2));
}

/** A key saved in Settings wins over ANTHROPIC_API_KEY in the environment. */
export function resolveCoordinatorCredentials(
  config: CoordinatorAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorCredentials {
  if (config.apiKey) return { apiKey: config.apiKey, source: "settings" };
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY, source: "env" };
  return { apiKey: undefined, source: null };
}
