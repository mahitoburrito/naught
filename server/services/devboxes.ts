import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { loadConfig, saveConfig } from "./linear";
import { readSshConfigHosts, type SshConfigHost } from "./sshConfig";
import type { DevboxConfig } from "../types";

export type { DevboxConfig };



export interface DiscoveredHost extends SshConfigHost {
  /** True when a saved devbox already points at this alias. */
  alreadyAdded: boolean;
}

const TEST_TIMEOUT_MS = 12_000;

export function listDevboxes(): DevboxConfig[] {
  return loadConfig().devboxes || [];
}

export function discoverHosts(): DiscoveredHost[] {
  const saved = new Set(listDevboxes().filter((box) => box.inSshConfig).map((box) => box.name));
  return readSshConfigHosts().map((host) => ({ ...host, alreadyAdded: saved.has(host.name) }));
}

function normalise(input: Partial<DevboxConfig>): Omit<DevboxConfig, "id"> {
  const source: DevboxConfig["source"] = input.source === "ssh-config" ? "ssh-config" : "manual";
  // "provisioned" never comes through here: see upsertProvisionedDevbox.
  const port = Number.isInteger(input.port) && input.port! > 0 && input.port! <= 65535
    ? input.port
    : undefined;
  return {
    name: (input.name || "").trim(),
    source,
    // An ssh-config entry is connected to purely by alias; its details live in
    // the user's file and are re-read there, so they cannot drift.
    inSshConfig: source === "ssh-config" ? true : Boolean(input.inSshConfig),
    host: source === "ssh-config" ? undefined : (input.host || "").trim() || undefined,
    user: source === "ssh-config" ? undefined : (input.user || "").trim() || undefined,
    port: source === "ssh-config" ? undefined : port,
    identityFile: source === "ssh-config" ? undefined : (input.identityFile || "").trim() || undefined,
    defaultPath: (input.defaultPath || "").trim() || undefined,
  };
}

export function createDevbox(input: Partial<DevboxConfig>): DevboxConfig {
  const config = loadConfig();
  const devbox: DevboxConfig = { id: randomUUID(), ...normalise(input) };
  if (!devbox.name) throw new Error("A devbox needs a name.");
  if (!devbox.inSshConfig && !devbox.host) throw new Error("A devbox needs a host.");
  config.devboxes = [...(config.devboxes || []), devbox];
  saveConfig(config);
  return devbox;
}

export function updateDevbox(id: string, input: Partial<DevboxConfig>): DevboxConfig {
  const config = loadConfig();
  const list = config.devboxes || [];
  const index = list.findIndex((box) => box.id === id);
  if (index === -1) throw new Error("Devbox not found.");
  const updated: DevboxConfig = { ...list[index], ...normalise({ ...list[index], ...input }), id };
  list[index] = updated;
  config.devboxes = list;
  saveConfig(config);
  return updated;
}

export function deleteDevbox(id: string): void {
  const config = loadConfig();
  config.devboxes = (config.devboxes || []).filter((box) => box.id !== id);
  saveConfig(config);
}

export function getDevbox(id: string): DevboxConfig | null {
  return listDevboxes().find((box) => box.id === id) || null;
}

/**
 * Provisioned boxes bypass `normalise`: their connection details come from a
 * provider, and the provision record rides along. Insert or replace by id.
 */
export function upsertProvisionedDevbox(devbox: DevboxConfig): DevboxConfig {
  const config = loadConfig();
  const list = config.devboxes || [];
  const index = list.findIndex((box) => box.id === devbox.id);
  const stored: DevboxConfig = { ...devbox, source: "provisioned", inSshConfig: false };
  if (index === -1) list.push(stored);
  else list[index] = stored;
  config.devboxes = list;
  saveConfig(config);
  return stored;
}

export function listProvisionedDevboxes(): Array<DevboxConfig & { provision: NonNullable<DevboxConfig["provision"]> }> {
  return listDevboxes().filter(
    (box): box is DevboxConfig & { provision: NonNullable<DevboxConfig["provision"]> } =>
      box.source === "provisioned" && !!box.provision,
  );
}

/**
 * The ssh arguments that address this box.
 *
 * An ssh-config alias is passed through bare on purpose: ssh then applies the
 * user's own HostName, User, Port, IdentityFile, keepalives and host-key
 * settings. Re-deriving those here would both duplicate and contradict them.
 */
export function buildSshTarget(devbox: DevboxConfig): string[] {
  if (devbox.inSshConfig) return [devbox.name];
  const args: string[] = [];
  if (devbox.port && devbox.port !== 22) args.push("-p", String(devbox.port));
  if (devbox.identityFile) args.push("-i", devbox.identityFile);
  args.push(devbox.user ? `${devbox.user}@${devbox.host}` : String(devbox.host));
  return args;
}

function quoteForRemoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a session runs to land on the box.
 *
 * `-t` forces a PTY, which the agent TUIs need. `exec` replaces the login shell
 * so quitting the agent ends the session instead of dropping the user at a
 * remote prompt they did not ask for.
 */
export function buildDevboxLaunchCommand(
  devbox: DevboxConfig,
  agentCommand: string,
  remotePath?: string,
): string {
  const target = buildSshTarget(devbox).map(quoteForRemoteShell).join(" ");
  const path = (remotePath || devbox.defaultPath || "").trim();
  const inner = agentCommand.trim()
    ? `exec ${agentCommand.trim()}`
    : "exec $SHELL -l";
  const remote = path ? `cd ${quoteForRemoteShell(path)} && ${inner}` : inner;
  return `ssh ${target} -t ${quoteForRemoteShell(remote)}`;
}

export interface DevboxLaunch {
  /** Typed first: a bare `ssh <target>` the session shim instruments. */
  launch: string;
  /** Typed once the remote shell is up. */
  remote: string;
  /** The old `-t` form, for when the shim is unavailable. */
  legacy: string;
}

function withRemotePluginDir(command: string): string {
  const token = command.split(/\s+/)[0] || "";
  if (token !== "claude" || command.includes("--plugin-dir")) return command;
  return `claude --plugin-dir "$HOME/.naught/claude-code-plugin"${command.slice(token.length)}`;
}

/**
 * The two-step launch: connect bare so the remote protocol attaches (file
 * reads, diffs, completions), then run the agent in that shell. Hooks on the
 * box post back through the reverse tunnel when its port is known.
 */
export function buildDevboxLaunch(
  devbox: DevboxConfig,
  agentCommand: string,
  remotePath?: string,
  options: { hooks?: { port: number; sessionId: string } } = {},
): DevboxLaunch {
  const target = buildSshTarget(devbox).map(quoteForRemoteShell).join(" ");
  const path = (remotePath || devbox.defaultPath || "").trim();
  const parts: string[] = [];
  if (path) parts.push(`cd ${quoteForRemoteShell(path)} || exit 1`);
  parts.push('[ -f "$HOME/.naught/env" ] && . "$HOME/.naught/env"');
  parts.push('export PATH="$HOME/.naught/bin:$HOME/.local/bin:$PATH"');
  if (options.hooks) {
    parts.push(`export OPENUI_HOST=127.0.0.1 OPENUI_PORT=${options.hooks.port} OPENUI_SESSION_ID=${quoteForRemoteShell(options.hooks.sessionId)}`);
  }
  const trimmed = agentCommand.trim();
  parts.push(`exec ${trimmed ? withRemotePluginDir(trimmed) : "$SHELL -l"}`);
  return {
    launch: `ssh ${target}`,
    remote: parts.join("; "),
    legacy: buildDevboxLaunchCommand(devbox, agentCommand, remotePath),
  };
}

export interface DevboxTestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

/**
 * Runs the real ssh, not the session shim, so testing never stands up a remote
 * server. BatchMode makes it fail rather than hang on a password prompt.
 */
export function testDevbox(devbox: DevboxConfig): Promise<DevboxTestResult> {
  return new Promise((resolve) => {
    const args = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=accept-new",
      ...buildSshTarget(devbox),
      "true",
    ];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error: any) {
      resolve({ ok: false, message: "Could not run ssh", detail: error?.message });
      return;
    }

    let stderr = "";
    let settled = false;
    const finish = (result: DevboxTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, message: "Timed out after 12s" });
    }, TEST_TIMEOUT_MS);

    child.stderr?.on("data", (chunk) => {
      // ssh is chatty on failure; the first line is the part worth showing.
      if (stderr.length < 2000) stderr += String(chunk);
    });
    child.on("error", (error: any) => {
      finish({ ok: false, message: "Could not run ssh", detail: error?.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, message: "Connected" });
        return;
      }
      const detail = stderr.split("\n").map((line) => line.trim()).filter(Boolean)[0];
      finish({ ok: false, message: `ssh exited ${code}`, detail });
    });
  });
}
