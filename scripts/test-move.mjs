#!/usr/bin/env node
// Behaviour tests for the session-move building blocks: manifests, harness
// state discovery, transfer, and the state machine. Imports the compiled
// server (`npm run build:electron` first). Never touches the network.

import { execFileSync, spawn as nodeSpawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron", "server");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function temp(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

function makeRepo() {
  const root = temp("naught-repo-");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\nnode_modules/\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  writeFileSync(join(root, "untracked.txt"), "untracked\n");
  writeFileSync(join(root, "ignored.txt"), "ignored\n");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "x");
  return root;
}

// ─── manifest ───────────────────────────────────────────────────────────────

section("manifest");
{
  const manifest = await import(join(dist, "services", "move", "manifest.js"));
  const repo = makeRepo();
  const plain = manifest.resolveMoveRoots(repo);
  check("a normal repo has one root and no git dir", [plain.roots, plain.gitDir], [[repo], undefined]);

  const built = await manifest.buildLocalManifest(plain, false);
  const rels = [...built.roots[0].entries.keys()].sort();
  check("tracked and untracked files are listed, ignored are not", rels, [".gitignore", "tracked.txt", "untracked.txt"]);
  check("sizes and hashes are recorded", [built.roots[0].entries.get("tracked.txt").size, built.roots[0].entries.get("tracked.txt").hash.length, built.files, built.bytes], [8, 64, 3, 44]);
  const withIgnored = await manifest.buildLocalManifest(plain, true);
  check("include-ignored adds the ignored files", [...withIgnored.roots[0].entries.keys()].sort(), [".gitignore", "ignored.txt", "node_modules/dep/index.js", "tracked.txt", "untracked.txt"]);
  const again = await manifest.buildLocalManifest(plain, false);
  check("the tree hash is stable", again.hash, built.hash);
  writeFileSync(join(repo, "tracked.txt"), "changed\n");
  const changed = await manifest.buildLocalManifest(plain, false);
  check("the tree hash changes with content", changed.hash === built.hash, false);
  const diff = manifest.diffManifests(changed, built);
  check("diff lists the changed file with its bytes", [diff.changed, diff.deleted, diff.bytes], [[[0, "tracked.txt"]], [], 8]);
  const removed = manifest.parseManifestOutput("", [repo]);
  const toEmpty = manifest.diffManifests(removed, built);
  check("diff against a fuller destination reports deletions", toEmpty.deleted.map((d) => d[1]).sort(), [".gitignore", "tracked.txt", "untracked.txt"]);
  check("entriesDiffer names absolute paths", manifest.entriesDiffer(changed, built), [join(repo, "tracked.txt")]);

  // Linked worktree: the mother .git travels, sibling worktrees do not.
  git(repo, "worktree", "add", "-q", "-b", "feature", join(repo, "..", `${repo.split("/").pop()}-wt-feature`));
  git(repo, "worktree", "add", "-q", "-b", "other", join(repo, "..", `${repo.split("/").pop()}-wt-other`));
  const worktree = join(repo, "..", `${repo.split("/").pop()}-wt-feature`);
  writeFileSync(join(worktree, "wip.txt"), "wip\n");
  const linked = manifest.resolveMoveRoots(worktree);
  check("a linked worktree brings the mother .git and excludes siblings", [linked.roots, linked.gitDir.path, linked.gitDir.excludeWorktrees], [[worktree], join(repo, ".git"), [`${repo.split("/").pop()}-wt-other`]]);
  check("manifest roots include the git dir", manifest.manifestRoots(linked), [worktree, join(repo, ".git")]);
  check("tool args pass the git dir once", manifest.manifestToolArgs(linked, false), [["--root", worktree, "--git-dir", join(repo, ".git"), "--exclude-worktree", `${repo.split("/").pop()}-wt-other`]]);
  const linkedManifest = await manifest.buildLocalManifest(linked, false);
  const wtRels = [...linkedManifest.roots[0].entries.keys()].sort();
  const gitRels = [...linkedManifest.roots[1].entries.keys()];
  check("the worktree's .git pointer file is included", wtRels, [".git", ".gitignore", "tracked.txt", "wip.txt"]);
  check("the mother .git carries HEAD and this worktree's metadata, not the sibling's", [gitRels.includes("HEAD"), gitRels.some((r) => r.startsWith(`worktrees/${repo.split("/").pop()}-wt-feature/`)), gitRels.some((r) => r.startsWith(`worktrees/${repo.split("/").pop()}-wt-other/`))], [true, true, false]);
  check("remote manifest command guards missing roots", manifest.remoteManifestCommand(plain, false).startsWith(`{ [ -d '${repo}' ] && python3 "$HOME/.naught/naught_manifest.py" '--root' '${repo}' || true; }`), true);

  const nonGit = temp("naught-plain-");
  writeFileSync(join(nonGit, "a.txt"), "a");
  mkdirSync(join(nonGit, "node_modules"));
  writeFileSync(join(nonGit, "node_modules", "b.js"), "b");
  const plainManifest = await manifest.buildLocalManifest(manifest.resolveMoveRoots(nonGit), false);
  check("a non-git directory skips node_modules by default", [...plainManifest.roots[0].entries.keys()], ["a.txt"]);
  check("multi-repo sessions are detected", [manifest.isMultiRepoSession({ a: "/a", b: "/b" }), manifest.isMultiRepoSession({ a: "/a" }), manifest.isMultiRepoSession(undefined)], [true, false, false]);
}

// ─── harness state ──────────────────────────────────────────────────────────

section("harness");
{
  const harness = await import(join(dist, "services", "move", "harness.js"));
  check("harness kind from agent id or command", [harness.harnessKindFor("claude", "claude"), harness.harnessKindFor("shell", "/opt/bin/codex -m o3"), harness.harnessKindFor("shell", "bash"), harness.harnessKindFor("profile:x", "claude --model opus")], ["claude", "codex", "shell", "claude"]);
  check("claude project dir name", harness.claudeProjectDirName("/Users/me/proj"), "-Users-me-proj");
  const long = "/" + "a".repeat(230);
  check("long paths are shortened with a hash", [harness.claudeProjectDirName(long).length, /^-a{199}-[a-f0-9]{8}$/.test(harness.claudeProjectDirName(long))], [209, true]);

  const home = temp("naught-home-");
  const cwd = "/tmp/proj";
  const projectDir = join(home, ".claude", "projects", "-tmp-proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "sid-1.jsonl"), "{}\n");
  mkdirSync(join(projectDir, "sid-1"));
  mkdirSync(join(home, ".claude", "todos"), { recursive: true });
  writeFileSync(join(home, ".claude", "todos", "sid-1-agent-sid-1.json"), "[]");
  writeFileSync(join(home, ".claude", "todos", "other.json"), "[]");
  const claude = harness.findClaudeState({ home, sessionId: "sid-1", cwd });
  check("claude state: transcript, subagents dir and todos", [claude.transcript, claude.subagentsDir, claude.todos, claude.longPath], [join(projectDir, "sid-1.jsonl"), join(projectDir, "sid-1"), [join(home, ".claude", "todos", "sid-1-agent-sid-1.json")], false]);
  check("claude state missing transcript is null", harness.findClaudeState({ home, sessionId: "nope", cwd }), null);
  check("an explicit transcript path wins", harness.findClaudeState({ home, sessionId: "sid-1", cwd: "/elsewhere", transcriptPath: join(projectDir, "sid-1.jsonl") }).transcript, join(projectDir, "sid-1.jsonl"));

  const day = join(home, ".codex", "sessions", "2026", "10", "12");
  mkdirSync(day, { recursive: true });
  const meta = (id, cwdValue, ts) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: cwdValue, originator: "codex-tui" } }) + "\n" + JSON.stringify({ type: "x" }) + "\n";
  writeFileSync(join(day, "rollout-2026-10-12T01-00-00-old.jsonl"), meta("old", cwd, "2026-10-12T01:00:00.000Z"));
  writeFileSync(join(day, "rollout-2026-10-12T02-00-00-new.jsonl"), meta("new", cwd, "2026-10-12T02:00:00.000Z"));
  writeFileSync(join(day, "rollout-2026-10-12T03-00-00-elsewhere.jsonl"), meta("elsewhere", "/other", "2026-10-12T03:00:00.000Z"));
  const since = Date.parse("2026-10-12T00:30:00.000Z");
  check("codex state picks the newest rollout for the cwd since the session started", harness.findCodexState({ home, cwd, since }).sessionId, "new");
  check("codex state honours since", harness.findCodexState({ home, cwd, since: Date.parse("2026-10-12T02:30:00.000Z") }), null);
  check("codex state by id", harness.findCodexState({ home, cwd, since, sessionId: "old" }).rolloutPath.endsWith("old.jsonl"), true);
  check("resume commands", [harness.resumeCommand("claude", "claude", "abc"), harness.resumeCommand("codex", "codex", "u1"), harness.resumeCommand("shell", "bash")], ["claude --resume abc", "codex resume u1", "bash"]);
  check("exit commands", [harness.exitCommand("claude"), harness.exitCommand("codex"), harness.exitCommand("shell")], ["/exit", "/quit", "exit"]);
  check("relative to home", [harness.relativeToHome(join(home, ".claude", "x.jsonl"), home), harness.relativeToHome("/etc/passwd", home)], [".claude/x.jsonl", null]);
  check("remote home path", harness.remoteHomePath("/root/", ".codex/auth.json"), "/root/.codex/auth.json");
}

// ─── transfer ───────────────────────────────────────────────────────────────

section("transfer");
{
  const transfer = await import(join(dist, "services", "move", "transfer.js"));
  check("tar member list strips the root", transfer.tarMemberList(["/a/b.txt", "/a/c/d.txt"]).toString(), "a/b.txt\0a/c/d.txt\0");
  check("tar member list keeps the whole path minus the leading slash", transfer.tarMemberList(["/scratch/a/b.txt"]).toString(), "scratch/a/b.txt\0");
  check("extract command", transfer.tarExtractCommand("/"), "mkdir -p '/' && tar -C '/' -xzpf -");
  check("delete command", [transfer.deleteCommand(["/a/x", "/a/y"]).command, transfer.deleteCommand(["/a/x"], "/r").input.toString()], ["xargs -0 rm -rf --", "/r/a/x\0"]);

  const box = { id: "b", name: "b", source: "provisioned", inSshConfig: false, host: "h", user: "root", port: 22, identityFile: "/k" };
  // "ssh" runs the remote command locally; absolute paths land under a scratch root.
  const fakeSpawn = (cmd, args, opts) => (cmd === "ssh" ? nodeSpawn("sh", ["-c", args[args.length - 1]], opts) : nodeSpawn(cmd, args, opts));
  const fakeRun = async (command, options = {}) => new Promise((resolve) => {
    const child = nodeSpawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, signal: null, stdout, stderr, timedOut: false }));
    child.stdin.end(options.input ?? "");
  });

  const local = temp("naught-local-");
  const remote = temp("naught-remote-");
  mkdirSync(join(local, "proj", "sub"), { recursive: true });
  writeFileSync(join(local, "proj", "a.txt"), "alpha");
  writeFileSync(join(local, "proj", "sub", "b.txt"), "beta");
  symlinkSync("a.txt", join(local, "proj", "link"));
  await transfer.pushFiles(box, [join(local, "proj", "a.txt"), join(local, "proj", "sub", "b.txt"), join(local, "proj", "link")], { spawn: fakeSpawn, remoteRoot: remote });
  check("pushFiles mirrors absolute paths under the remote root", [readFileSync(join(remote, local.slice(1), "proj", "a.txt"), "utf-8"), readFileSync(join(remote, local.slice(1), "proj", "sub", "b.txt"), "utf-8")], ["alpha", "beta"]);
  check("symlinks travel as links", existsSync(join(remote, local.slice(1), "proj", "link")), true);

  writeFileSync(join(remote, local.slice(1), "proj", "a.txt"), "alpha-2");
  writeFileSync(join(remote, local.slice(1), "proj", "new.txt"), "new");
  const back = temp("naught-back-");
  await transfer.pullFiles(box, [join(local, "proj", "a.txt"), join(local, "proj", "new.txt")], { spawn: fakeSpawn, remoteRoot: remote, localRoot: back });
  check("pullFiles brings changed and new files home", [readFileSync(join(back, local.slice(1), "proj", "a.txt"), "utf-8"), readFileSync(join(back, local.slice(1), "proj", "new.txt"), "utf-8")], ["alpha-2", "new"]);

  await transfer.deleteRemote(box, [join(local, "proj", "new.txt")], { run: fakeRun, remoteRoot: remote });
  check("deleteRemote removes the listed paths", existsSync(join(remote, local.slice(1), "proj", "new.txt")), false);
  transfer.deleteLocal([join(local, "proj", "sub", "b.txt")]);
  check("deleteLocal removes the listed paths", existsSync(join(local, "proj", "sub", "b.txt")), false);

  await transfer.ensureRemoteDirectory(box, "/deep/nested/dir", { run: fakeRun, remoteRoot: remote });
  check("ensureRemoteDirectory creates the path under the remote root", existsSync(join(remote, "deep", "nested", "dir")), true);
  let error = "";
  try { await transfer.pushFiles(box, ["/definitely/missing/file"], { spawn: fakeSpawn, remoteRoot: remote }); } catch (e) { error = e.message; }
  check("a missing source file fails the push", error.startsWith("local tar exited"), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
