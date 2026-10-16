import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { DevboxConfig } from "../../types";
import { buildSshTarget } from "../devboxes";

/**
 * Runs one command on a devbox through the real ssh (never the session shim,
 * which would stand up a remote server) with BatchMode so a missing key fails
 * instead of hanging on a password prompt.
 */

export interface SshRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SshRunOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  identityFile?: string;
  connectTimeoutSeconds?: number;
  maxOutputChars?: number;
  spawn?: typeof nodeSpawn;
  /** Extra ssh options before the target (e.g. a `-R` forward). */
  extraArgs?: string[];
  /** bootstrapNode: attempts on ssh transport failure, and the base delay between them. */
  retries?: number;
  retryDelayMs?: number;
}

export function sshArgsFor(
  devbox: DevboxConfig,
  options: { identityFile?: string; connectTimeoutSeconds?: number; extraArgs?: string[] } = {},
): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
  ];
  const identityFile = options.identityFile ?? devbox.identityFile;
  const target = buildSshTarget({ ...devbox, identityFile: undefined });
  if (identityFile) args.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  args.push(...target);
  return args;
}

export function runOverSsh(
  devbox: DevboxConfig,
  command: string,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutput = options.maxOutputChars ?? 1_000_000;
  const args = [...sshArgsFor(devbox, options), command];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error: any) {
      reject(new Error(`Could not run ssh: ${error?.message || String(error)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (result: SshRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutput) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxOutput) stderr += String(chunk);
    });
    child.on("error", (error: any) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Could not run ssh: ${error?.message || String(error)}`));
      }
    });
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* the remote closed early; close reports it */ });
      child.stdin.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** POSIX single-quote escaping for a value embedded in a remote command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function firstStderrLine(result: SshRunResult): string | undefined {
  return result.stderr.split("\n").map((line) => line.trim()).filter(Boolean)[0];
}
