#!/usr/bin/env node
// Exercise actual server restarts and hard crashes in an isolated workspace.
// A local Claude stub records argv; no model or user's sessions are launched.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "openui-recovery-"));
// Unix sockets have a short path limit; macOS's per-user tmpdir is too long.
const control = mkdtempSync("/tmp/openui-recovery-control-");
const data = join(root, "data");
const bin = join(root, "bin");
const config = join(root, "claude-config");
const log = join(root, "launches.jsonl");
const exitRequest = join(root, "exit-request");
const exiting = join(root, "exiting");
const consumedInput = join(root, "consumed-input");
const ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
const NEXT = "9a8b7c6d-1111-4222-8333-944455566677";
for (const dir of [data, bin, join(config, "projects", "-repo")]) mkdirSync(dir, { recursive: true });
for (const id of [ID, NEXT]) writeFileSync(join(config, "projects", "-repo", `${id}.jsonl`), "{}\n");
writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,sessionId:process.env.OPENUI_SESSION_ID,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(consumedInput)}, data));
const timer = setInterval(async () => {
  if (!fs.existsSync(${JSON.stringify(exitRequest)})) return;
  fs.unlinkSync(${JSON.stringify(exitRequest)});
  clearInterval(timer);
  await fetch('http://127.0.0.1:'+process.env.OPENUI_PORT+'/api/status-update', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({openuiSessionId:process.env.OPENUI_SESSION_ID,claudeSessionId:process.argv.at(-1),hookEvent:'SessionEnd',stopReason:'prompt_input_exit',status:'disconnected'})
  });
  fs.writeFileSync(${JSON.stringify(exiting)}, '');
  setTimeout(() => process.exit(0), 1800);
}, 50);
`);
chmodSync(join(bin, "claude"), 0o755);

const node = (id, extra = {}) => ({
  nodeId: `node-${id}`, sessionId: `session-${id}`, agentId: "claude", agentName: "Claude Code",
  command: "claude --model opus", cwd: root, createdAt: new Date().toISOString(),
  position: { x: 123, y: 456 }, resumeSessionId: ID,
  shellLaunch: { shell: "/bin/bash", args: ["--noprofile", "--norc"] }, ...extra,
});
writeFileSync(join(data, "state.json"), JSON.stringify({ version: 2, nodes: [
  node("active"), node("ended", { manuallyEnded: true }), node("deleted", { pendingDelete: true }),
  node("missing", { resumeSessionId: "00000000-0000-0000-0000-000000000000" }),
  node("unknown", { resumeSessionId: undefined }),
] }));

const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const saved = (id) => JSON.parse(readFileSync(join(data, "state.json"), "utf8")).nodes.find(n => n.sessionId === id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
let child;
let exited;
let port;
let output = "";
async function api(path, body, method = "POST", expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
}
async function boot() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  output = "";
  child = spawn(process.execPath, [join(repo, "dist/electron/server/index.js")], {
    env: { ...process.env, PORT: String(port), LAUNCH_CWD: root, OPENUI_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/bash",
      OPENUI_CONTROL_DIR: control, OPENUI_QUIET: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  await waitFor(() => output.includes(`[server] Running on http://localhost:${port}`), "server listening");
}
async function stop(signal = "SIGINT") {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    await exited;
  }
  // Hard crashes can orphan the stub. Reap only PIDs recorded by this test.
  for (const { pid } of launches()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  child = null;
}
const hook = (hookEvent, stopReason, claudeSessionId = ID) => api("/status-update", {
  openuiSessionId: "session-active", claudeSessionId, hookEvent, stopReason,
  status: hookEvent === "SessionEnd" ? "disconnected" : "idle",
});

try {
  await boot();
  assert.equal((await api("/linear/config", undefined, "GET")).resumeSessionsOnLaunch, true);
  await waitFor(() => launches().length > 0, "automatic resume");
  await sleep(1800); // Wait beyond the stagger for all five seed nodes.
  assert.deepEqual(launches().map(x => x.sessionId), ["session-active"]);
  assert.deepEqual(launches()[0].args.slice(-4), ["--model", "opus", "--resume", ID]);
  assert.equal(realpathSync(launches()[0].cwd), realpathSync(root));
  assert(!(await api("/sessions", undefined, "GET")).some(x => x.sessionId === "session-deleted"));
  console.log("ok: startup resumes only the recoverable, unended Claude node in its original folder");
  const missing = await api("/sessions/session-missing/restart", { resume: true }, "POST", 409);
  assert.match(missing.error, /conversation.*unavailable/i);
  assert.equal(launches().length, 1, "manual Resume must not silently start a blank conversation");

  writeFileSync(exitRequest, "");
  await waitFor(() => existsSync(exiting), "Claude reported SessionEnd but is still exiting");
  await waitFor(async () => (await api("/sessions", undefined, "GET"))
    .find(session => session.sessionId === "session-active")?.status === "disconnected", "SessionEnd status committed");
  const premature = await api("/sessions/session-active/restart", { resume: true }, "POST", 409);
  assert.match(premature.error, /still exiting/i);
  assert.equal(saved("session-active").manuallyEnded, true);
  await waitFor(async () => (await api("/sessions/session-active/blocks", undefined, "GET")).phase === "at_prompt", "shell prompt after Claude exit");
  await api("/sessions/session-active/restart", { resume: true });
  await waitFor(() => launches().length === 2, "resume after the shell is ready");
  assert(!existsSync(consumedInput) || !readFileSync(consumedInput, "utf8").includes("--resume"));
  console.log("ok: Resume waits for Claude to finish exiting instead of sending its command to a dying process");

  await hook("SessionStart", undefined, NEXT);
  assert.equal(saved("session-active").resumeSessionId, NEXT, "conversation ID must be on disk before the hook returns");
  await stop("SIGKILL");
  const beforeCrash = launches().length;
  await boot();
  await waitFor(() => launches().length > beforeCrash, "recovery after SIGKILL");
  assert.equal(launches().at(-1).args.at(-1), NEXT);
  assert.deepEqual(saved("session-active").position, { x: 123, y: 456 });
  console.log("ok: an immediate hard crash preserves the exact conversation and canvas position");

  await hook("SessionEnd", "other", NEXT);
  await stop();
  const beforeQuit = launches().length;
  await boot();
  await waitFor(() => launches().length > beforeQuit, "recovery after normal app quit");
  assert.equal(launches().at(-1).args.at(-1), NEXT);
  console.log("ok: app shutdown and a non-user SessionEnd remain recoverable");

  // Exercise the actual reporter's no-jq path as well as the HTTP receiver.
  const hookBin = join(root, "hook-bin");
  mkdirSync(hookBin);
  for (const tool of ["cat", "grep", "sed", "head", "date", "curl", "tr"]) {
    symlinkSync(execFileSync("which", [tool], { encoding: "utf8" }).trim(), join(hookBin, tool));
  }
  const reporter = spawnSync("/bin/bash", [join(repo, "claude-code-plugin/hooks/status-reporter.sh"), "disconnected"], {
    input: JSON.stringify({ session_id: NEXT, hook_event_name: "SessionEnd", reason: "prompt_input_exit", cwd: root }),
    env: { ...process.env, PATH: hookBin, OPENUI_PORT: String(port), OPENUI_HOST: "127.0.0.1", OPENUI_SESSION_ID: "session-active" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(reporter.status, 0, reporter.stderr);
  assert.equal(saved("session-active").manuallyEnded, true, "manual exit must be saved immediately");
  await stop("SIGKILL");
  const beforeExit = launches().length;
  await boot();
  await sleep(1800);
  assert.equal(launches().length, beforeExit, "an explicitly ended session must stay closed");
  console.log("ok: /exit stays closed even when the app crashes immediately afterward");

  const resumed = await api("/sessions/session-active/restart", { resume: true });
  assert.equal(resumed.resumed, true);
  assert.equal(saved("session-active").manuallyEnded, false);
  await api("/sessions/session-active/soft-delete", {});
  await sleep(600); // Cross the delayed dispatch while the close is undoable.
  await api("/sessions/session-active/undo-delete", {});
  await waitFor(() => launches().length > beforeExit, "manual resume");
  await hook("SessionEnd", "clear", NEXT);
  assert.equal(saved("session-active").manuallyEnded, false, "/clear does not end the node");
  await hook("SessionStart", undefined, NEXT);
  console.log("ok: manual Resume re-enables recovery; /clear does not disable it");

  await api("/sessions/session-active/soft-delete", {});
  assert.equal(saved("session-active").pendingDelete, true);
  await api("/sessions/session-active/undo-delete", {});
  assert.equal(saved("session-active").pendingDelete, false);
  await api("/sessions/session-active/soft-delete", {});
  await stop("SIGKILL");
  const beforeDelete = launches().length;
  await boot();
  await sleep(1800);
  assert.equal(launches().length, beforeDelete);
  assert(!(await api("/sessions", undefined, "GET")).some(x => x.sessionId === "session-active"));
  console.log("ok: close/undo persists correctly; closing during the undo window never resurrects a node");
} catch (error) {
  console.error(output.slice(-4000));
  throw error;
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(control, { recursive: true, force: true });
}
