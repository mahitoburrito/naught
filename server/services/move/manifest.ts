import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { DevboxConfig } from "../../types";
import { manifestToolSourcePath } from "../compute/bootstrap";
import { runOverSsh, shellQuote, type SshRunResult } from "../compute/sshExec";

/**
 * A manifest is what `naught_manifest.py` says is on disk under a set of
 * roots: path, size, content hash. The same tool runs on both machines, and
 * the comparison happens here on root-relative paths, so the absolute prefix
 * (mirrored on purpose) never leaks into the hash.
 */

export interface ManifestEntry {
  /** Root-relative path, `/`-separated. */
  rel: string;
  size?: number;
  hash?: string;
  mode?: number;
  link?: string;
  err?: string;
}

export interface RootManifest {
  root: string;
  entries: Map<string, ManifestEntry>;
  files: number;
  bytes: number;
  /** sha256 over the sorted entries (relative path + content hash). */
  hash: string;
}

export interface Manifest {
  roots: RootManifest[];
  files: number;
  bytes: number;
  /** sha256 over the root hashes in order: the "tree hash" the move records. */
  hash: string;
}

export interface MoveRoots {
  /** Absolute local paths to copy, in order: the session cwd first. */
  roots: string[];
  /** For a linked git worktree: the mother `.git` directory and sibling worktrees to skip. */
  gitDir?: { path: string; excludeWorktrees: string[] };
}

function entryToken(entry: ManifestEntry): string {
  if (entry.hash) return entry.hash;
  if (entry.link !== undefined) return `l:${entry.link}`;
  return "err";
}

export function hashEntries(entries: Iterable<ManifestEntry>): string {
  const sorted = Array.from(entries).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of sorted) hash.update(entry.rel).update("\0").update(entryToken(entry)).update("\n");
  return hash.digest("hex");
}

function finishRoot(root: string, entries: Map<string, ManifestEntry>): RootManifest {
  let bytes = 0;
  for (const entry of entries.values()) bytes += entry.size ?? 0;
  return { root, entries, files: entries.size, bytes, hash: hashEntries(entries.values()) };
}

export function combineRoots(roots: RootManifest[]): Manifest {
  const hash = createHash("sha256");
  for (const root of roots) hash.update(root.hash).update("\n");
  return {
    roots,
    files: roots.reduce((n, r) => n + r.files, 0),
    bytes: roots.reduce((n, r) => n + r.bytes, 0),
    hash: hash.digest("hex"),
  };
}

/**
 * Splits the tool's JSON lines (absolute `p` values) into per-root maps of
 * root-relative entries. A path under no root is ignored.
 */
export function parseManifestOutput(text: string, roots: string[]): Manifest {
  const maps = roots.map(() => new Map<string, ManifestEntry>());
  const prefixes = roots.map((root) => (root.endsWith("/") ? root : `${root}/`));
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: any;
    try { value = JSON.parse(trimmed); } catch { continue; }
    if (!value || typeof value !== "object" || value.summary || typeof value.p !== "string") continue;
    const absolute: string = value.p;
    let index = -1;
    let best = -1;
    for (let i = 0; i < prefixes.length; i++) {
      if (absolute.startsWith(prefixes[i]) && prefixes[i].length > best) {
        best = prefixes[i].length;
        index = i;
      }
    }
    if (index === -1) continue;
    const rel = absolute.slice(prefixes[index].length);
    if (!rel) continue;
    maps[index].set(rel, {
      rel,
      size: typeof value.s === "number" ? value.s : undefined,
      hash: typeof value.h === "string" ? value.h : undefined,
      mode: typeof value.m === "number" ? value.m : undefined,
      link: typeof value.l === "string" ? value.l : undefined,
      err: typeof value.err === "string" ? value.err : undefined,
    });
  }
  return combineRoots(roots.map((root, i) => finishRoot(root, maps[i])));
}

export function manifestToolArgs(move: MoveRoots, includeIgnored: boolean): string[][] {
  const invocations: string[][] = [];
  move.roots.forEach((root, index) => {
    const args = ["--root", root];
    if (includeIgnored) args.push("--include-ignored");
    if (index === 0 && move.gitDir) {
      args.push("--git-dir", move.gitDir.path);
      for (const name of move.gitDir.excludeWorktrees) args.push("--exclude-worktree", name);
    }
    invocations.push(args);
  });
  return invocations;
}

/** The roots a manifest reports: the session roots plus the mother .git when present. */
export function manifestRoots(move: MoveRoots): string[] {
  return move.gitDir ? [...move.roots, move.gitDir.path] : [...move.roots];
}

export async function buildLocalManifest(move: MoveRoots, includeIgnored: boolean): Promise<Manifest> {
  const tool = manifestToolSourcePath();
  if (!tool) throw new Error("naught_manifest.py is missing from this build");
  const outputs: string[] = [];
  for (const args of manifestToolArgs(move, includeIgnored)) {
    outputs.push(await new Promise<string>((resolvePromise, reject) => {
      execFile("python3", [tool, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf-8" }, (error, stdout, stderr) => {
        if (error) reject(new Error(`manifest failed for ${args[1]}: ${String(stderr || error.message).trim()}`));
        else resolvePromise(stdout);
      });
    }));
  }
  return parseManifestOutput(outputs.join("\n"), manifestRoots(move));
}

export const REMOTE_MANIFEST_TOOL = '"$HOME/.naught/naught_manifest.py"';

export function remoteManifestCommand(move: MoveRoots, includeIgnored: boolean): string {
  // Roots that do not exist yet (first move) must produce an empty manifest,
  // not an error, so each invocation is guarded.
  return manifestToolArgs(move, includeIgnored)
    .map((args) => `{ [ -d ${shellQuote(args[1])} ] && python3 ${REMOTE_MANIFEST_TOOL} ${args.map(shellQuote).join(" ")} || true; }`)
    .join("; ");
}

export async function buildRemoteManifest(
  devbox: DevboxConfig,
  move: MoveRoots,
  includeIgnored: boolean,
  run: (command: string, options?: { timeoutMs?: number; maxOutputChars?: number }) => Promise<SshRunResult> =
    (command, options) => runOverSsh(devbox, command, options),
): Promise<Manifest> {
  const result = await run(remoteManifestCommand(move, includeIgnored), { timeoutMs: 15 * 60_000, maxOutputChars: 256 * 1024 * 1024 });
  if (result.code !== 0) {
    const detail = result.stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    throw new Error(`remote manifest failed: ${detail || `exit ${result.code}`}`);
  }
  return parseManifestOutput(result.stdout, manifestRoots(move));
}

export interface ManifestDiff {
  /** Root-relative, per root in manifest order: `[rootIndex, rel]`. */
  changed: Array<[number, string]>;
  deleted: Array<[number, string]>;
  bytes: number;
}

/** What has to travel from `source` for `destination` to match it. */
export function diffManifests(source: Manifest, destination: Manifest): ManifestDiff {
  const changed: Array<[number, string]> = [];
  const deleted: Array<[number, string]> = [];
  let bytes = 0;
  source.roots.forEach((root, index) => {
    const other = destination.roots[index];
    for (const entry of root.entries.values()) {
      if (entry.err) continue;
      const counterpart = other?.entries.get(entry.rel);
      if (!counterpart || entryToken(counterpart) !== entryToken(entry) || counterpart.mode !== entry.mode) {
        changed.push([index, entry.rel]);
        bytes += entry.size ?? 0;
      }
    }
    if (other) {
      for (const entry of other.entries.values()) {
        if (!root.entries.has(entry.rel)) deleted.push([index, entry.rel]);
      }
    }
  });
  return { changed, deleted, bytes };
}

export function manifestSummary(manifest: Manifest): { hash: string; files: number; bytes: number; roots: string[] } {
  return { hash: manifest.hash, files: manifest.files, bytes: manifest.bytes, roots: manifest.roots.map((r) => r.root) };
}

export function entriesDiffer(a: Manifest, b: Manifest): string[] {
  const out: string[] = [];
  a.roots.forEach((root, index) => {
    const other = b.roots[index];
    for (const entry of root.entries.values()) {
      const counterpart = other?.entries.get(entry.rel);
      if (!counterpart || entryToken(counterpart) !== entryToken(entry)) out.push(join(root.root, entry.rel));
    }
    if (other) for (const entry of other.entries.values()) if (!root.entries.has(entry.rel)) out.push(join(root.root, entry.rel));
  });
  return out;
}

/**
 * The roots for a session: its cwd, plus for a linked git worktree the mother
 * repository's `.git` directory (the worktree's `.git` file points at it by
 * absolute path, so with mirrored paths git on the node just works).
 */
export function resolveMoveRoots(cwd: string): MoveRoots {
  // Physical paths on both sides: the harnesses record process.cwd(), which
  // has symlinks resolved, and git writes resolved paths into worktree pointers.
  let root = resolve(cwd);
  try { root = realpathSync(root); } catch { /* keep the logical path */ }
  const dotGit = join(root, ".git");
  let gitDir: MoveRoots["gitDir"];
  try {
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, "utf-8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (match) {
        let worktreeGitDir = isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
        try { worktreeGitDir = realpathSync(worktreeGitDir); } catch { /* keep as written */ }
        // <mother>/.git/worktrees/<name>
        const worktreesDir = dirname(worktreeGitDir);
        const motherGitDir = dirname(worktreesDir);
        if (basename(worktreesDir) === "worktrees" && existsSync(join(motherGitDir, "HEAD"))) {
          const mine = basename(worktreeGitDir);
          let siblings: string[] = [];
          try { siblings = readdirSync(worktreesDir).filter((name) => name !== mine); } catch { /* none */ }
          gitDir = { path: motherGitDir, excludeWorktrees: siblings };
        }
      }
    }
  } catch {
    // Treat as a plain directory.
  }
  return { roots: [root], gitDir };
}

export function isMultiRepoSession(worktreePaths?: Record<string, string>): boolean {
  return !!worktreePaths && Object.keys(worktreePaths).length > 1;
}
