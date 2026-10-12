import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * One home for the app's secrets file.
 *
 * Every key the app stores (Linear, Gemini, PRBE, and now the compute
 * providers) lives as a `KEY="value"` line in `.openui-desktop/.env`. Two
 * copies are read — the launch directory's and the home directory's — with
 * the launch directory winning, which is what `titleGenerator.ts` always did.
 * Writes go to the launch directory's file only.
 */

function launchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

export function envFilePath(): string {
  return join(launchCwd(), ".openui-desktop", ".env");
}

function homeEnvFilePath(): string {
  return join(homedir(), ".openui-desktop", ".env");
}

export function parseEnvText(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    vars[key] = value;
  }
  return vars;
}

export function readEnvFile(): Record<string, string> {
  const files = Array.from(new Set([homeEnvFilePath(), envFilePath()]));
  const vars: Record<string, string> = {};
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      Object.assign(vars, parseEnvText(readFileSync(file, "utf-8")));
    } catch {
      // A broken env file must not take the app down; the key reads as unset.
    }
  }
  return vars;
}

/** Sets (or, with an empty value, removes) one key in the launch env file. */
export function updateEnvValue(key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Refusing to write env key ${JSON.stringify(key)}`);
  const dir = join(launchCwd(), ".openui-desktop");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = envFilePath();
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = existing.split("\n").filter((line) => !line.trim().startsWith(`${key}=`));

  let next = lines.join("\n").trimEnd();
  if (value) {
    if (next) next += "\n";
    next += `${key}="${value.replace(/"/g, '\\"')}"`;
  }
  writeFileSync(file, next ? `${next}\n` : "", { mode: 0o600 });
}

export type SecretSource = "naught" | "env" | "detected";

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

/**
 * Where a secret comes from, in priority order: the value set in Naught, the
 * process environment, then whatever a provider's own tooling left on disk.
 */
export function resolveSecret(
  key: string,
  options: { env?: NodeJS.ProcessEnv; detector?: () => string | undefined; file?: Record<string, string> } = {},
): ResolvedSecret | undefined {
  const file = options.file ?? readEnvFile();
  const stored = (file[key] || "").trim();
  if (stored) return { value: stored, source: "naught" };
  const env = options.env ?? process.env;
  const fromEnv = (env[key] || "").trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  const detected = (options.detector?.() || "").trim();
  if (detected) return { value: detected, source: "detected" };
  return undefined;
}

export interface ModalTokens {
  tokenId: string;
  tokenSecret: string;
  profile: string;
}

/**
 * `~/.modal.toml` is a flat TOML of `[profile]` tables with `token_id`,
 * `token_secret` and an optional `active = true`. A full TOML parser is not
 * worth a dependency for that shape.
 */
export function parseModalToml(text: string): ModalTokens | undefined {
  const profiles: Record<string, Record<string, string>> = {};
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      current = table[1].trim();
      profiles[current] ||= {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    profiles[current][key] = value;
  }
  const names = Object.keys(profiles);
  const active = names.find((name) => /^true$/i.test(profiles[name].active || ""));
  const chosen = active ?? (names.length === 1 ? names[0] : undefined);
  if (!chosen) return undefined;
  const tokenId = profiles[chosen].token_id || "";
  const tokenSecret = profiles[chosen].token_secret || "";
  if (!tokenId || !tokenSecret) return undefined;
  return { tokenId, tokenSecret, profile: chosen };
}

export function modalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODAL_CONFIG_PATH || join(homedir(), ".modal.toml");
}

export function detectModalToken(env: NodeJS.ProcessEnv = process.env): ModalTokens | undefined {
  try {
    const path = modalConfigPath(env);
    if (!existsSync(path)) return undefined;
    return parseModalToml(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export function thunderTokenPath(): string {
  return join(homedir(), ".thunder", "token");
}

export function detectThunderToken(): string | undefined {
  try {
    const path = thunderTokenPath();
    if (!existsSync(path)) return undefined;
    const token = readFileSync(path, "utf-8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
