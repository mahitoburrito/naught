#!/usr/bin/env node
// Behaviour tests for the session-move building blocks: manifests, harness
// state discovery, transfer, and the state machine. Imports the compiled
// server (`npm run build:electron` first). Never touches the network.

import { execFileSync, spawn as nodeSpawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "fs";
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
  check("a normal repo brings its own .git along", [plain.roots, plain.gitDir], [[repo], { path: join(repo, ".git"), excludeWorktrees: [] }]);

  const built = await manifest.buildLocalManifest(plain, false);
  const rels = [...built.roots[0].entries.keys()].sort();
  check("tracked and untracked files are listed, ignored are not", rels, [".gitignore", "tracked.txt", "untracked.txt"]);
  check("sizes and hashes are recorded", [built.roots[0].entries.get("tracked.txt").size, built.roots[0].entries.get("tracked.txt").hash.length, built.roots[0].files, built.roots[0].bytes, built.roots[1].entries.has("HEAD")], [8, 64, 3, 44, true]);
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
  check("remote manifest command guards missing roots", manifest.remoteManifestCommand(plain, false).startsWith(`{ [ -d '${repo}' ] && python3 "$HOME/.naught/naught_manifest.py" '--root' '${repo}' '--git-dir' '${join(repo, ".git")}' || true; }`), true);

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
  check("extract command", transfer.tarExtractCommand("/"), "mkdir -p '/' && tar -C '/' --no-same-owner -xzpf -");
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


// ─── state machine ──────────────────────────────────────────────────────────

section("move state machine");
{
  const launchDir = temp("naught-launch-");
  const previousLaunch = process.env.LAUNCH_CWD;
  process.env.LAUNCH_CWD = launchDir;
  const move = await import(join(dist, "services", "sessionMove.js"));
  const manifestMod = await import(join(dist, "services", "move", "manifest.js"));
  const devboxes = await import(join(dist, "services", "devboxes.js"));
  const secrets = await import(join(dist, "services", "secrets.js"));
  const { Hono } = await import("hono");
  const { moveRoutes } = await import(join(dist, "routes", "move.js"));
  const app = new Hono().route("/api/sessions", moveRoutes);
  const call = async (method, path, body) => {
    const res = await app.request(`http://local${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  secrets.updateEnvValue("CLAUDE_CODE_OAUTH_TOKEN", "oat-x");
  const node = devboxes.upsertProvisionedDevbox({
    id: "node-1", name: "gpu-1", source: "provisioned", inSshConfig: false, host: "h", user: "root", port: 22, identityFile: "/k", defaultPath: "/root",
    provision: { provider: "modal", instanceId: "sb", gpuCount: 0, cpu: 2, memoryGb: 8, status: "ready", requestedBy: { kind: "user" }, requestedAt: 0, startedAt: 0, hourlyUsd: 0.5, maxLifetimeHours: 8, lastActivityAt: 0, emails: { reminderCount: 0, idleAlertCount: 0 } },
  });

  const home = temp("naught-mhome-");
  const repo = makeRepo();
  const projectDir = join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "cid-1.jsonl"), '{"type":"x"}\n');
  mkdirSync(join(home, ".claude", "todos"), { recursive: true });
  writeFileSync(join(home, ".claude", "todos", "cid-1-agent.json"), "[]");

  const makePty = () => ({ killed: false, kill() { this.killed = true; } });
  const sessions = new Map();
  const session = {
    pty: makePty(), agentId: "claude", agentName: "Claude Code", command: "claude", cwd: repo, createdAt: new Date(0).toISOString(),
    status: "idle", claudeSessionId: "cid-1", outputBuffer: [], outputBufferChars: 0, clients: new Set(), nodeId: "n1", terminalBlocks: [],
    terminalCols: 80, terminalRows: 24, terminalFrameRedrawsInPlace: true, lastOutputTime: 0, lastInputTime: 0, recentOutputSize: 0,
  };
  sessions.set("s1", session);

  const calls = [];
  const states = [];
  let remoteManifest = null;
  let now = 1_000_000;
  let pushFailures = 0;
  let relaunched = [];
  let remoteLaunchResult = { state: "remote" };
  move.configureMoves({
    sessions: () => sessions,
    now: () => (now += 10),
    localHome: () => home,
    buildRemoteManifest: async (devbox, roots, includeIgnored) => remoteManifest ?? manifestMod.parseManifestOutput("", manifestMod.manifestRoots(roots)),
    runRemote: async (devbox, command) => {
      calls.push(["run", command.slice(0, 40)]);
      if (command.includes('"$HOME"')) return { code: 0, signal: null, stdout: "/root", stderr: "", timedOut: false };
      if (command.startsWith("stat ")) return { code: 0, signal: null, stdout: String(statSync(join(projectDir, "cid-1.jsonl")).size), stderr: "", timedOut: false };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
    },
    transfer: {
      push: async (devbox, paths, opts) => {
        calls.push(["push", paths.map((p) => p.replace(home, "~").replace(repo, "<repo>")).sort(), opts?.memberBase === home ? "home" : "mirror"]);
        if (pushFailures > 0) { pushFailures--; throw new Error("network blip"); }
        if (!opts) remoteManifest = await manifestMod.buildLocalManifest(manifestMod.resolveMoveRoots(repo), false);
      },
      pull: async (devbox, paths, opts) => { calls.push(["pull", paths.map((p) => p.replace("/root", "~").replace(repo, "<repo>")).sort(), opts?.memberBase === "/root" ? "home" : "mirror"]); },
      deleteRemote: async (devbox, paths) => { calls.push(["deleteRemote", paths.length]); },
      deleteLocal: (paths) => { calls.push(["deleteLocal", paths.length]); },
      ensureRemoteDirectory: async (devbox, path) => { calls.push(["mkdir", path.replace(repo, "<repo>")]); },
    },
    ensureNodeAssets: async () => ({ ok: true, shipped: false }),
    relaunch: async (sessionId, overrides) => {
      relaunched.push(overrides);
      const s = sessions.get(sessionId);
      s.pty = makePty();
      s.status = "running";
      if (overrides.devboxId !== undefined) s.devboxId = overrides.devboxId || undefined;
      if (overrides.cwd) s.cwd = overrides.cwd;
      setTimeout(() => { s.claudeSessionId = "cid-1"; s.status = "idle"; }, 30);
      return { ok: true };
    },
    write: (sessionId, data) => { calls.push(["write", data]); const s = sessions.get(sessionId); setTimeout(() => { s.pty = null; s.status = "disconnected"; }, 20); },
    terminalPhase: () => "at_prompt",
    remoteLaunch: () => (remoteLaunchResult),
    persist: () => { if (session.move && states.at(-1) !== `${session.move.direction}:${session.move.state}`) states.push(`${session.move.direction}:${session.move.state}`); },
    terminateNode: async (nodeId, reason) => { calls.push(["terminateNode", nodeId, reason]); },
    timing: { pollMs: 5, idleTimeoutMs: 2000, quiesceMs: 500, verifyMs: 800 },
  });
  const settled = async () => { for (let i = 0; i < 400; i++) { if (["done", "error"].includes(session.move?.state)) return session.move; await new Promise((r) => setTimeout(r, 10)); } return session.move; };

  const plan = await move.planMoveOut("s1", { nodeId: "node-1" });
  check("plan: ok with the claude session found and a manifest", [plan.ok, plan.harness.kind, plan.harness.sessionId, plan.harness.found, plan.manifest.files >= 3, plan.manifest.roots.length, plan.credential, plan.agentState, plan.destination], [true, "claude", "cid-1", true, true, 2, "CLAUDE_CODE_OAUTH_TOKEN", "idle", { id: "node-1", name: "gpu-1" }]);
  check("plan: ignored files are offered with their extra size", plan.includeIgnoredExtraBytes, 9);
  check("plan refuses a missing node", (await move.planMoveOut("s1", { nodeId: "nope", manifest: false })).refusals, ["Destination node not found."]);
  secrets.updateEnvValue("CLAUDE_CODE_OAUTH_TOKEN", "");
  check("plan refuses without a node credential", (await move.planMoveOut("s1", { nodeId: "node-1", manifest: false })).refusals[0].startsWith("Claude needs CLAUDE_CODE_OAUTH_TOKEN"), true);
  secrets.updateEnvValue("CLAUDE_CODE_OAUTH_TOKEN", "oat-x");

  const started = await call("POST", "/api/sessions/s1/move", { nodeId: "node-1", afterTurn: true });
  check("POST move is accepted", [started.status, started.body.accepted, started.body.nodeId], [202, true, "node-1"]);
  let result = await settled();
  check("the move runs every step to done", states, ["out:waiting-idle", "out:prepare", "out:quiesce", "out:sync-files", "out:sync-agent", "out:relaunch", "out:verify", "out:done"]);
  check("quiesce typed the harness exit command", calls.find((c) => c[0] === "write"), ["write", "/exit"]);
  check("files were pushed by absolute path, then the agent state under the node home", calls.filter((c) => c[0] === "push").map((c) => [c[2] === "home" ? c[1].length : c[1].length >= 3, c[2]]), [[true, "mirror"], [2, "home"]]);
  check("the working tree files are in the first push", calls.filter((c) => c[0] === "push")[0][1].filter((p) => !p.includes("/.git/")), ["<repo>/.gitignore", "<repo>/tracked.txt", "<repo>/untracked.txt"]);
  check("agent state covers the transcript and todos", calls.filter((c) => c[0] === "push")[1][1], ["~/.claude/projects/" + repo.replace(/[^A-Za-z0-9]/g, "-") + "/cid-1.jsonl", "~/.claude/todos/cid-1-agent.json"]);
  check("relaunch used the resume command on the node at the same path", relaunched[0], { command: "claude --resume cid-1", devboxId: "node-1", remotePath: repo });
  check("done records the manifest and history", [result.state, result.manifest.files >= 3, result.history.length, result.history[0].direction, session.devboxId], ["done", true, 1, "out", "node-1"]);
  check("GET move", (await call("GET", "/api/sessions/s1/move")).body.move.state, "done");
  check("a second move out is refused while remote", (await call("POST", "/api/sessions/s1/move", { nodeId: "node-1" })).status, 400);

  // Bring back with no local changes: straight sync, node terminated afterwards.
  calls.length = 0; states.length = 0; relaunched = [];
  const homePlan = await call("POST", "/api/sessions/s1/move/home/plan");
  check("bring-back plan with an untouched local tree has no conflicts", [homePlan.body.ok, homePlan.body.conflicts], [true, []]);
  const back = await call("POST", "/api/sessions/s1/move/home", { terminateNode: true });
  check("POST home is accepted", back.status, 202);
  result = await settled();
  check("bring-back has no error", result.error, undefined);
  check("bring-back walks the steps", states, ["home:waiting-idle", "home:prepare", "home:quiesce", "home:sync-files", "home:sync-agent", "home:relaunch", "home:verify", "home:done"]);
  check("nothing to pull when trees match; the transcript comes home; the node is terminated", [calls.filter((c) => c[0] === "pull").map((c) => [c[1].length, c[2]]), calls.some((c) => c[0] === "terminateNode" && c[2] === "bring-back")], [[[0, "mirror"], [1, "home"]], true]);
  check("relaunch is local again", [relaunched[0].devboxId, relaunched[0].cwd, session.devboxId], [null, repo, undefined]);
  check("history has both legs", result.history.map((h) => h.direction), ["out", "home"]);

  // Failure + retry: the push fails once, the session stays local, retry finishes.
  calls.length = 0; states.length = 0; relaunched = []; pushFailures = 1; remoteManifest = null;
  session.pty = makePty(); session.status = "idle";
  await move.startMove("s1", { nodeId: "node-1", whenIdle: false });
  result = await settled();
  check("a failed step parks the move with the error and the step", [result.state, result.failedStep, result.error, session.devboxId, relaunched.length], ["error", "sync-files", "network blip", undefined, 0]);
  check("local files are untouched by the failure", readFileSync(join(repo, "tracked.txt"), "utf-8"), "tracked\n");
  await call("POST", "/api/sessions/s1/move/retry");
  result = await settled();
  check("retry resumes at the failed step and completes", [result.state, states.slice(-5)], ["done", ["out:sync-files", "out:sync-agent", "out:relaunch", "out:verify", "out:done"]]);

  // Conflict on bring-back: a local edit after the move needs a choice.
  writeFileSync(join(repo, "tracked.txt"), "edited locally\n");
  const conflictPlan = await call("POST", "/api/sessions/s1/move/home/plan");
  check("a changed local tree reports the conflicting files", conflictPlan.body.conflicts, [join(repo, "tracked.txt")]);
  const refused = await call("POST", "/api/sessions/s1/move/home", {});
  check("bring-back without a choice is 409", [refused.status, refused.body.refusals], [409, [join(repo, "tracked.txt")]]);
  calls.length = 0; states.length = 0;
  // Overwrite: the pull fake restores the node's version.
  move.configureMoves({ transfer: { pull: async (devbox, paths) => { calls.push(["pull", paths.length]); for (const p of paths) if (p.endsWith("tracked.txt")) writeFileSync(p, "tracked\n"); } } });
  const overwrite = await call("POST", "/api/sessions/s1/move/home", { conflict: "overwrite", terminateNode: false });
  result = await settled();
  check("overwrite pulls the differing file and finishes", [overwrite.status, result.state, calls.filter((c) => c[0] === "pull")[0], readFileSync(join(repo, "tracked.txt"), "utf-8")], [202, "done", ["pull", 1], "tracked\n"]);
  check("terminateNode false keeps the node", calls.some((c) => c[0] === "terminateNode"), false);

  // A relaunch that never reaches the node must fail the move, not pass on a local prompt.
  remoteLaunchResult = { state: "failed", error: "could not reach gpu-1: ssh exited (see the terminal)" };
  session.move = { ...session.move, state: "done", direction: "home" };
  session.devboxId = undefined;
  states.length = 0; relaunched = [];
  move.configureMoves({ transfer: { pull: async () => {} } });
  await move.startMove("s1", { nodeId: "node-1", whenIdle: false });
  result = await settled();
  check("a launch that never reached the node fails the move at verify", [result.state, result.failedStep, result.error], ["error", "verify", "could not reach gpu-1: ssh exited (see the terminal)"]);
  remoteLaunchResult = { state: "remote" };
  await move.retryMove("s1");
  result = await settled();
  check("retry after the node is reachable completes", result.state, "done");
  check("retrying a failed verify relaunches", relaunched.length, 2);

  // A shell session that never reports idle must not park a move in waiting-idle.
  {
    const shellSession = { ...session, agentId: "shell", command: "", claudeSessionId: undefined, status: "running", pty: makePty(), devboxId: undefined, move: undefined };
    sessions.set("s2", shellSession);
    states.length = 0; relaunched = [];
    remoteManifest = null;
    move.configureMoves({ sessions: () => sessions });
    await move.startMove("s2", { nodeId: "node-1" });
    let shellResult;
    for (let i = 0; i < 400; i++) { if (["done", "error"].includes(shellSession.move?.state)) { shellResult = shellSession.move; break; } await new Promise((r) => setTimeout(r, 10)); }
    check("a busy-looking shell session moves without waiting for idle", [shellResult?.state, shellResult?.error], ["done", undefined]);
    sessions.delete("s2");
  }

  // Restart recovery.
  session.move = { ...session.move, state: "sync-files", direction: "out" };
  move.resumeInFlightMoves();
  check("a restart mid-transfer parks the move as an error", [session.move.state, session.move.failedStep], ["error", "sync-files"]);
  check("cancel after an error keeps the last completed leg", (await call("POST", "/api/sessions/s1/move/cancel")).body.move.state, "done");
  check("unknown session is 404", (await call("GET", "/api/sessions/nope/move")).status, 404);

  if (previousLaunch === undefined) delete process.env.LAUNCH_CWD; else process.env.LAUNCH_CWD = previousLaunch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
