import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./persistence";

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

/** The config sits in the app's data dir (OPENUI_DATA_DIR, else ~/.openui-desktop). */
export function coordinatorAgentConfigPath(dataDir: string = getDataDir()): string {
  return join(dataDir, "coordinator-agent.json");
}

export function loadCoordinatorAgentConfig(dataDir: string = getDataDir()): CoordinatorAgentConfig {
  const file = coordinatorAgentConfigPath(dataDir);
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

/** Writes the key owner-only and atomically, so a crash mid-write cannot lose it. */
export function saveCoordinatorAgentConfig(config: CoordinatorAgentConfig, dataDir: string = getDataDir()): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stored: CoordinatorAgentConfig = {};
  if (config.apiKey) stored.apiKey = config.apiKey;
  if (config.model) stored.model = config.model;
  const file = coordinatorAgentConfigPath(dataDir);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
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
