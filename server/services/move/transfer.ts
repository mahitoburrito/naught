import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { dirname, isAbsolute } from "path";
import type { DevboxConfig } from "../../types";
import { runOverSsh, shellQuote, sshArgsFor, type SshRunResult } from "../compute/sshExec";

/**
 * Moving bytes between this machine and a node: a tar stream over ssh in
 * either direction, driven by the manifest diff, with the same absolute
 * paths on both ends. `rsync` is deliberately not used: macOS ships
 * openrsync with partial flag support, while tar -T and sha256 are everywhere.
 */

export interface TransferDeps {
  spawn?: typeof nodeSpawn;
  /** Where absolute paths land on the far side; tests point it at a scratch dir. */
  remoteRoot?: string;
  localRoot?: string;
  /**
   * Prefix stripped from each path to form the tar member name. "/" mirrors
   * absolute paths; a home directory re-roots files under another home.
   */
  memberBase?: string;
  run?: (command: string, options?: { input?: Buffer | string; timeoutMs?: number }) => Promise<SshRunResult>;
}

function stripRoot(path: string, root: string): string {
  const prefix = root === "/" ? "/" : `${root.replace(/\/$/, "")}/`;
  if (!path.startsWith(prefix)) throw new Error(`${path} is outside ${root}`);
  return path.slice(prefix.length);
}

/**
 * NUL-separated member list for `tar --null -T -`. Members are the absolute
 * paths without their leading slash; `-C <root>` on either side decides where
 * that tree lives (`/` in production, a scratch directory in tests).
 */
export function tarMemberList(paths: string[], base = "/"): Buffer {
  return Buffer.from(paths.map((path) => stripRoot(path, base)).join("\0") + (paths.length ? "\0" : ""), "utf-8");
}

export function localTarCreateArgs(root = "/"): string[] {
  return ["-C", root, "-czf", "-", "--null", "-T", "-"];
}

export function remoteTarCreateCommand(root = "/"): string {
  return `tar -C ${shellQuote(root)} -czf - --null -T -`;
}

export function tarExtractCommand(root = "/"): string {
  // -p keeps modes; -f - reads the stream; parent directories are created by tar.
  return `mkdir -p ${shellQuote(root)} && tar -C ${shellQuote(root)} -xzpf -`;
}

export function deleteCommand(paths: string[], root = "/"): { command: string; input: Buffer } {
  const members = paths.map((path) => (root === "/" ? path : `${root.replace(/\/$/, "")}/${stripRoot(path, "/")}`));
  return { command: "xargs -0 rm -rf --", input: Buffer.from(members.join("\0") + (members.length ? "\0" : ""), "utf-8") };
}

interface Piped {
  code: number | null;
  stderr: string;
}

function waitFor(child: ChildProcess, label: string): Promise<Piped> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { if (stderr.length < 100_000) stderr += String(chunk); });
    child.on("error", (error) => reject(new Error(`${label}: ${error.message}`)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function failed(label: string, result: Piped): Error {
  const detail = result.stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return new Error(`${label} exited ${result.code}${detail ? `: ${detail}` : ""}`);
}

/**
 * Local → node. The member list is fed to a local tar whose stdout is piped
 * straight into `ssh node tar -x`, so nothing is buffered in memory.
 */
export async function pushFiles(devbox: DevboxConfig, paths: string[], deps: TransferDeps = {}): Promise<void> {
  if (!paths.length) return;
  const spawn = deps.spawn ?? nodeSpawn;
  const localRoot = deps.localRoot ?? "/";
  const remoteRoot = deps.remoteRoot ?? "/";
  // COPYFILE_DISABLE stops macOS bsdtar from adding AppleDouble `._*` members
  // for extended attributes; they would appear as extra files on the node.
  const tar = spawn("tar", localTarCreateArgs(localRoot), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const ssh = spawn("ssh", [...sshArgsFor(devbox), tarExtractCommand(remoteRoot)], { stdio: ["pipe", "ignore", "pipe"] });
  tar.stdout!.pipe(ssh.stdin!);
  tar.stdin!.on("error", () => { /* tar closed early; its exit code tells the story */ });
  ssh.stdin!.on("error", () => { /* ssh closed early; its exit code tells the story */ });
  tar.stdin!.end(tarMemberList(paths, deps.memberBase ?? "/"));
  const [tarResult, sshResult] = await Promise.all([waitFor(tar, "tar"), waitFor(ssh, "ssh")]);
  if (tarResult.code !== 0) throw failed("local tar", tarResult);
  if (sshResult.code !== 0) throw failed("remote extract", sshResult);
}

/**
 * Node → local. `ssh node tar -c` streams into a local tar -x.
 */
export async function pullFiles(devbox: DevboxConfig, paths: string[], deps: TransferDeps = {}): Promise<void> {
  if (!paths.length) return;
  const spawn = deps.spawn ?? nodeSpawn;
  const localRoot = deps.localRoot ?? "/";
  const remoteRoot = deps.remoteRoot ?? "/";
  const ssh = spawn("ssh", [...sshArgsFor(devbox), remoteTarCreateCommand(remoteRoot)], { stdio: ["pipe", "pipe", "pipe"] });
  const tar = spawn("sh", ["-c", tarExtractCommand(localRoot)], { stdio: ["pipe", "ignore", "pipe"] });
  ssh.stdout!.pipe(tar.stdin!);
  ssh.stdin!.on("error", () => { /* see pushFiles */ });
  tar.stdin!.on("error", () => { /* see pushFiles */ });
  ssh.stdin!.end(tarMemberList(paths, deps.memberBase ?? "/"));
  const [sshResult, tarResult] = await Promise.all([waitFor(ssh, "ssh"), waitFor(tar, "tar")]);
  if (sshResult.code !== 0) throw failed("remote tar", sshResult);
  if (tarResult.code !== 0) throw failed("local extract", tarResult);
}

export async function deleteRemote(devbox: DevboxConfig, paths: string[], deps: TransferDeps = {}): Promise<void> {
  if (!paths.length) return;
  const run = deps.run ?? ((command, options) => runOverSsh(devbox, command, options));
  const { command, input } = deleteCommand(paths, deps.remoteRoot ?? "/");
  const result = await run(command, { input, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`remote delete exited ${result.code}: ${result.stderr.trim().split("\n")[0] || ""}`);
}

export function deleteLocal(paths: string[], deps: TransferDeps = {}): void {
  const localRoot = deps.localRoot ?? "/";
  for (const path of paths) {
    const target = localRoot === "/" ? path : `${localRoot.replace(/\/$/, "")}/${stripRoot(path, "/")}`;
    if (!isAbsolute(target)) continue;
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Creates a directory on the node and makes sure the node user owns it,
 * escalating once with sudo for a path like `/Users/...` that an unprivileged
 * user cannot create.
 */
export async function ensureRemoteDirectory(devbox: DevboxConfig, path: string, deps: TransferDeps = {}): Promise<void> {
  const run = deps.run ?? ((command, options) => runOverSsh(devbox, command, options));
  const target = deps.remoteRoot && deps.remoteRoot !== "/" ? `${deps.remoteRoot.replace(/\/$/, "")}${path}` : path;
  const q = shellQuote(target);
  // Find the first missing ancestor so chown covers everything we created and nothing else.
  const command = [
    `p=${q}`,
    'top="$p"; while [ ! -d "$(dirname "$top")" ] && [ "$top" != "/" ]; do top="$(dirname "$top")"; done',
    'if mkdir -p "$p" 2>/dev/null; then exit 0; fi',
    'if command -v sudo >/dev/null 2>&1 && sudo -n mkdir -p "$p" 2>/dev/null; then sudo -n chown -R "$(id -u):$(id -g)" "$top" && exit 0; fi',
    'echo "cannot create $p" >&2; exit 1',
  ].join("; ");
  const result = await run(command, { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n")[0] || `could not create ${path} on the node`);
}

export function ensureLocalDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
