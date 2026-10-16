import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Naught's own ssh identity for the nodes it provisions. Never the user's
 * personal key: one file to revoke, nothing of theirs copied anywhere.
 */

function launchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

export function naughtKeyDirectory(): string {
  return join(launchCwd(), ".openui-desktop", "keys");
}

export function naughtKeyPath(): string {
  return join(naughtKeyDirectory(), "naught_ed25519");
}

export function naughtPublicKeyPath(): string {
  return `${naughtKeyPath()}.pub`;
}

let pending: Promise<{ privateKeyPath: string; publicKey: string }> | null = null;

export function ensureNaughtKeypair(): Promise<{ privateKeyPath: string; publicKey: string }> {
  if (pending) return pending;
  pending = (async () => {
    const privateKeyPath = naughtKeyPath();
    const publicKeyPath = naughtPublicKeyPath();
    if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
      const directory = naughtKeyDirectory();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      await new Promise<void>((resolve, reject) => {
        execFile(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", "naught", "-f", privateKeyPath],
          { timeout: 20_000 },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(`ssh-keygen failed: ${String(stderr || error.message).trim()}`));
            else resolve();
          },
        );
      });
    }
    chmodSync(privateKeyPath, 0o600);
    return { privateKeyPath, publicKey: publicKeyText() };
  })();
  pending.catch(() => { pending = null; });
  return pending;
}

export function publicKeyText(): string {
  return readFileSync(naughtPublicKeyPath(), "utf-8").trim().split("\n")[0].trim();
}

/** Tests swap the launch directory; the memoised promise must not outlive it. */
export function resetNaughtKeypairCache(): void {
  pending = null;
}
