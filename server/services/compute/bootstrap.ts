import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import type { DevboxConfig } from "../../types";
import { runOverSsh, shellQuote, type SshRunOptions, type SshRunResult } from "./sshExec";

/**
 * Preparing a node: a private `~/.naught` on the box with the agent
 * credentials, the `naught` CLI, the status plugin and the manifest tool,
 * plus the two agent CLIs installed when the image did not bring them.
 *
 * Everything travels in one gzipped tar on stdin, so quoting never has to
 * carry a secret through a shell.
 */

export const NODE_ASSET_VERSION_FILE = "assets.version";

interface AssetSource {
  /** Path inside `~/.naught/`. */
  target: string;
  local: string;
}

function packageRoot(): string {
  // dist/electron/server/services/compute → repo root (or app.asar root).
  return join(__dirname, "..", "..", "..", "..", "..");
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  }) ?? null;
}

export function naughtCliSourcePath(): string | null {
  const root = packageRoot();
  const candidates = [join(root, "bin", "naught.js")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "app.asar", "bin", "naught.js"));
    candidates.push(join(process.resourcesPath, "app", "bin", "naught.js"));
  }
  return firstExisting(candidates);
}

export function pluginSourceDir(): string | null {
  const root = packageRoot();
  const candidates = [join(root, "claude-code-plugin")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.unshift(join(process.resourcesPath, "claude-code-plugin"));
  }
  return firstExisting(candidates.map((dir) => join(dir, ".claude-plugin", "plugin.json")))
    ? (candidates.find((dir) => existsSync(join(dir, ".claude-plugin", "plugin.json"))) ?? null)
    : null;
}

export function manifestToolSourcePath(): string | null {
  const root = packageRoot();
  const candidates = [join(root, "resources", "remote-terminal", "naught_manifest.py")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.unshift(join(process.resourcesPath, "remote-terminal", "naught_manifest.py"));
  }
  return firstExisting(candidates);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Everything a node needs from this machine, with the paths it lands on. */
export function collectNodeAssets(): AssetSource[] {
  const assets: AssetSource[] = [];
  const cli = naughtCliSourcePath();
  if (cli) assets.push({ target: "naught.js", local: cli });
  const manifest = manifestToolSourcePath();
  if (manifest) assets.push({ target: "naught_manifest.py", local: manifest });
  const plugin = pluginSourceDir();
  if (plugin) {
    for (const file of walk(plugin)) {
      assets.push({ target: join("claude-code-plugin", relative(plugin, file)), local: file });
    }
  }
  return assets.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

export function assetsVersion(assets: AssetSource[] = collectNodeAssets()): string {
  const hash = createHash("sha256");
  for (const asset of assets) {
    hash.update(asset.target).update("\0").update(readFileSync(asset.local)).update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

const CLI_WRAPPER = [
  "#!/bin/sh",
  'exec node "$HOME/.naught/naught.js" "$@"',
  "",
].join("\n");

/**
 * The script that runs on the node after the tar is unpacked into ~/.naught.
 * POSIX sh; prints `NAUGHT_BOOTSTRAP_OK <json>` as its last line on success.
 */
export function buildBootstrapScript(input: { version: string; installAgents: boolean }): string {
  return [
    "#!/bin/sh",
    "set -u",
    "umask 077",
    'N="$HOME/.naught"',
    'chmod 700 "$N" 2>/dev/null || true',
    '[ -f "$N/env" ] && chmod 600 "$N/env"',
    'mkdir -p "$N/bin" && chmod 755 "$N/bin/naught" 2>/dev/null || true',
    'chmod 700 "$N/naught_manifest.py" 2>/dev/null || true',
    'export PATH="$HOME/.local/bin:$HOME/.naught/bin:/usr/local/bin:$PATH"',
    "warn() { printf 'NAUGHT_WARN %s\\n' \"$1\" >&2; }",
    ...(input.installAgents
      ? [
          "if ! command -v claude >/dev/null 2>&1; then",
          "  if command -v curl >/dev/null 2>&1; then curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || warn 'claude install failed'; else warn 'curl missing, claude not installed'; fi",
          "fi",
          // Node 18+ is needed by the Codex CLI and by naught itself; distro
          // packages on older images are too old, so NodeSource when allowed.
          "node_ok() { command -v node >/dev/null 2>&1 && [ \"$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)\" -ge 18 ]; }",
          "if ! node_ok; then",
          "  if command -v apt-get >/dev/null 2>&1; then",
          "    if [ \"$(id -u)\" = 0 ]; then SUDO=''; elif command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi",
          "    { curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 && $SUDO apt-get install -y --no-install-recommends nodejs >/dev/null 2>&1; } || warn 'node install failed'",
          "  else warn 'node too old and no apt-get; codex not installed'; fi",
          "fi",
          "if ! command -v codex >/dev/null 2>&1; then",
          "  if node_ok && command -v npm >/dev/null 2>&1; then npm install -g @openai/codex >/dev/null 2>&1 || warn 'codex install failed'; else warn 'npm missing or node too old, codex not installed'; fi",
          "fi",
        ]
      : []),
    // A node has never run Claude Code: mark onboarding done so a session
    // started here does not stop on the theme picker.
    `python3 -c ${shellQuote('import json,os\np=os.path.expanduser("~/.claude.json")\ntry:\n d=json.load(open(p))\nexcept Exception:\n d={}\nif not d.get("hasCompletedOnboarding"):\n d["hasCompletedOnboarding"]=True\n json.dump(d,open(p+".t","w"));os.replace(p+".t",p)')} || warn 'could not mark Claude onboarding done'`,
    `printf '%s\\n' ${shellQuote(input.version)} > "$N/${NODE_ASSET_VERSION_FILE}"`,
    "v() { if command -v \"$1\" >/dev/null 2>&1; then \"$1\" --version 2>/dev/null | head -n 1; else echo missing; fi; }",
    "python3 - \"$(v claude)\" \"$(v codex)\" \"$(v python3)\" \"$(v node)\" \"$(v tar)\" \"$(v rsync)\" <<'PY'",
    "import json, sys",
    'keys = ["claude", "codex", "python3", "node", "tar", "rsync"]',
    'print("NAUGHT_BOOTSTRAP_OK " + json.dumps(dict(zip(keys, [a.strip() for a in sys.argv[1:]]))))',
    "PY",
    "",
  ].join("\n");
}

export function renderNodeEnvFile(credentials: Record<string, string>): string {
  const lines = Object.entries(credentials)
    .filter(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export interface NodePayload {
  credentials?: Record<string, string>;
  /** Extra files to place under ~/.naught (path → contents, mode). */
  files?: Array<{ target: string; contents: Buffer | string; mode?: number }>;
  installAgents: boolean;
  assets?: AssetSource[];
}

/**
 * Builds the gzipped tar that unpacks into ~/.naught: env, the bootstrap
 * script, the CLI, the plugin, the manifest tool and any extra files.
 */
export async function buildNodeTar(payload: NodePayload): Promise<{ tar: Buffer; version: string }> {
  const assets = payload.assets ?? collectNodeAssets();
  const version = assetsVersion(assets);
  const staging = mkdtempSync(join(tmpdir(), "naught-node-"));
  try {
    const put = (target: string, contents: Buffer | string, mode = 0o600) => {
      const path = join(staging, target);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents);
      chmodSync(path, mode);
    };
    for (const asset of assets) put(asset.target, readFileSync(asset.local), asset.target.endsWith(".sh") || asset.target.endsWith(".py") ? 0o700 : 0o600);
    put(join("bin", "naught"), CLI_WRAPPER, 0o755);
    const env = renderNodeEnvFile(payload.credentials ?? {});
    if (env) put("env", env, 0o600);
    for (const file of payload.files ?? []) put(file.target, file.contents, file.mode ?? 0o600);
    put("bootstrap.sh", buildBootstrapScript({ version, installAgents: payload.installAgents }), 0o700);
    const tar = await new Promise<Buffer>((resolve, reject) => {
      execFile("tar", ["-czf", "-", "-C", staging, "."], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } }, (error, stdout) => {
        if (error) reject(new Error(`tar failed: ${error.message}`));
        else resolve(stdout as Buffer);
      });
    });
    return { tar, version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export const REMOTE_UNPACK_COMMAND =
  'umask 077 && mkdir -p "$HOME/.naught" && chmod 700 "$HOME/.naught" && tar -xzf - -C "$HOME/.naught" && sh "$HOME/.naught/bootstrap.sh"';

export interface BootstrapResult {
  ok: boolean;
  versions?: Record<string, string>;
  warnings: string[];
  error?: string;
  assetVersion: string;
}

export function parseBootstrapOutput(result: SshRunResult, assetVersion: string): BootstrapResult {
  const warnings = result.stderr.split("\n").filter((line) => line.startsWith("NAUGHT_WARN ")).map((line) => line.slice("NAUGHT_WARN ".length).trim());
  const okLine = result.stdout.split("\n").reverse().find((line) => line.startsWith("NAUGHT_BOOTSTRAP_OK "));
  if (result.code === 0 && okLine) {
    let versions: Record<string, string> = {};
    try { versions = JSON.parse(okLine.slice("NAUGHT_BOOTSTRAP_OK ".length)); } catch { /* versions are informational */ }
    return { ok: true, versions, warnings, assetVersion };
  }
  const firstError = result.stderr.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("NAUGHT_WARN"))[0];
  return {
    ok: false,
    warnings,
    assetVersion,
    error: result.timedOut ? "bootstrap timed out" : firstError || `bootstrap exited ${result.code}`,
  };
}

export async function bootstrapNode(
  devbox: DevboxConfig,
  payload: NodePayload,
  options: SshRunOptions = {},
): Promise<BootstrapResult> {
  const { tar, version } = await buildNodeTar(payload);
  // A provider's tunnel can accept TCP a few seconds before sshd is ready to
  // finish a handshake ("Connection closed by …", ssh exit 255). The unpack is
  // idempotent, so ssh-level failures are retried; a failure of the script
  // itself is not.
  const attempts = options.retries ?? 5;
  let result: SshRunResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await runOverSsh(devbox, REMOTE_UNPACK_COMMAND, { timeoutMs: 10 * 60_000, ...options, input: tar });
    if (!isSshTransportFailure(result) || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 3_000) * attempt));
  }
  return parseBootstrapOutput(result!, version);
}

/** ssh itself failed (no remote command ran): exit 255 with a connection-level message. */
export function isSshTransportFailure(result: SshRunResult): boolean {
  return result.code === 255 &&
    /Connection (closed|refused|reset|timed out)|kex_exchange_identification|Connection to .* closed by remote host|banner exchange/i.test(result.stderr);
}

/**
 * Cheap check used before launching on, or moving to, any devbox: ships the
 * assets only when the version on the box differs from ours.
 */
export async function ensureNodeAssets(
  devbox: DevboxConfig,
  options: SshRunOptions & { credentials?: Record<string, string> } = {},
): Promise<{ ok: boolean; shipped: boolean; error?: string; versions?: Record<string, string> }> {
  const assets = collectNodeAssets();
  const version = assetsVersion(assets);
  const probe = await runOverSsh(devbox, `cat "$HOME/.naught/${NODE_ASSET_VERSION_FILE}" 2>/dev/null || true`, { timeoutMs: 30_000, ...options });
  if (probe.code !== 0) {
    return { ok: false, shipped: false, error: probe.stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0] || `ssh exited ${probe.code}` };
  }
  if (probe.stdout.trim() === version) return { ok: true, shipped: false };
  const result = await bootstrapNode(devbox, { credentials: options.credentials, installAgents: false, assets }, options);
  return { ok: result.ok, shipped: true, error: result.error, versions: result.versions };
}

export function nodeHomeOf(devbox: DevboxConfig): string {
  return devbox.user === "root" ? "/root" : `/home/${devbox.user || "ubuntu"}`;
}

export function statTotal(paths: string[]): number {
  let total = 0;
  for (const path of paths) {
    try { total += statSync(path).size; } catch { /* missing files do not count */ }
  }
  return total;
}
