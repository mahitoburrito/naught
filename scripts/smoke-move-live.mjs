#!/usr/bin/env node
// Opt-in live smoke: provisions a real CPU-only Modal node through the
// isolated server, moves a shell session with a git repo onto it, checks the
// files and git on the node, changes a file there, brings the session back,
// and terminates the node. Spends cents of Modal credits.
//
//   NAUGHT_LIVE_SMOKE=1 node scripts/smoke-move-live.mjs

import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

if (process.env.NAUGHT_LIVE_SMOKE !== "1") {
  console.log("skipped: set NAUGHT_LIVE_SMOKE=1 to provision a real Modal node (spends credits)");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron", "server");
const PORT = Number(process.env.NAUGHT_TEST_PORT || 7969);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "naught-live-move-")));

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); console.log(`         actual   ${JSON.stringify(actual)}`); console.log(`         expected ${JSON.stringify(expected)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const sshExec = await import(join(dist, "services", "compute", "sshExec.js"));

const server = spawn(process.execPath, ["-e", `require(${JSON.stringify(join(dist, "index.js"))}).startServer()`], {
  env: { ...process.env, PORT: String(PORT), LAUNCH_CWD: scratch, OPENUI_QUIET: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (c) => { serverLog += c; });
server.stderr.on("data", (c) => { serverLog += c; });
let nodeId = null;
const cleanup = async () => {
  if (nodeId) {
    try { await api("DELETE", `/api/compute/nodes/${nodeId}`); console.log("node terminate requested"); } catch { /* best effort */ }
    for (let i = 0; i < 20; i++) {
      const node = (await api("GET", `/api/compute/nodes/${nodeId}`)).body?.node;
      if (!node || node.provision.status === "terminated") break;
      await sleep(1000);
    }
  }
  try { server.kill("SIGKILL"); } catch { /* gone */ }
};

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await api("GET", "/api/sessions")).status === 200) { up = true; break; } } catch { /* not yet */ }
    await sleep(500);
  }
  check("isolated server is up", up, true);

  const providers = (await api("GET", "/api/compute/providers")).body.providers;
  check("modal is configured", providers.find((p) => p.id === "modal").ok, true);
  await api("PUT", "/api/compute/policy", { maxConcurrentNodes: 1, maxHourlyUsd: 2, maxLifetimeHours: 0.5 });

  console.log("provisioning a CPU-only Modal node…");
  const created = await api("POST", "/api/compute/nodes", { provider: "modal", cpu: 2, memoryGb: 4, name: "naught-live-move", maxLifetimeHours: 0.5 });
  check("node request accepted inside policy", created.status, 201);
  nodeId = created.body.node.id;
  let node = null;
  for (let i = 0; i < 20 * 60; i++) {
    node = (await api("GET", `/api/compute/nodes/${nodeId}`)).body.node;
    if (["ready", "error", "terminated"].includes(node.provision.status)) break;
    await sleep(1000);
  }
  check("node is ready", [node.provision.status, node.provision.error], ["ready", undefined]);
  console.log(`  ssh -p ${node.port} ${node.user}@${node.host}`);
  if (node.provision.status !== "ready") throw new Error("node not ready");

  const repo = join(scratch, "work", "proj");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf-8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  writeFileSync(join(repo, "ignored.txt"), "ignored\n");

  const session = await api("POST", "/api/sessions", { agentId: "shell", agentName: "Shell", command: "", cwd: repo, customName: "cloud-mover" });
  check("shell session created", session.status, 200);
  const sessionId = session.body.sessionId;
  await sleep(2500);

  const plan = await api("POST", `/api/sessions/${sessionId}/move/plan`, { nodeId });
  check("move plan is ok", [plan.body.ok, plan.body.refusals], [true, []]);
  console.log("moving the session to the node…");
  const moved = await api("POST", `/api/sessions/${sessionId}/move`, { nodeId, whenIdle: false });
  check("move accepted", moved.status, 202);
  let move = null;
  for (let i = 0; i < 600; i++) {
    move = (await api("GET", `/api/sessions/${sessionId}/move`)).body.move;
    if (move && ["done", "error"].includes(move.state)) break;
    await sleep(1000);
  }
  check("move completed", [move?.state, move?.error], ["done", undefined]);

  const onNode = await sshExec.runOverSsh(node, `ls -1A ${sshExec.shellQuote(repo)} && cat ${sshExec.shellQuote(join(repo, "untracked.txt"))} && cd ${sshExec.shellQuote(repo)} && git status --porcelain && git log --oneline | head -1`, { timeoutMs: 60_000 });
  check("files and git are on the node at the same path", [onNode.code, onNode.stdout.split("\n").filter(Boolean)], [0, [".git", ".gitignore", "tracked.txt", "untracked.txt", "untracked", "?? untracked.txt", onNode.stdout.split("\n").filter(Boolean).at(-1)]]);
  check("the commit is there", /init$/.test(onNode.stdout.trim()), true);
  const listed = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
  check("the session points at the node", [listed.devboxId, listed.remotePath], [nodeId, repo]);
  let status = "";
  for (let i = 0; i < 40; i++) {
    status = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId).status;
    if (status !== "running") break;
    await sleep(1000);
  }
  console.log(`  remote session status: ${status}`);
  check("the remote session is alive", status !== "disconnected" && status !== "error", true);

  const change = await sshExec.runOverSsh(node, `cd ${sshExec.shellQuote(repo)} && echo cloud > from-cloud.txt && rm untracked.txt && git add -A && git -c user.email=n@x -c user.name=n commit -q -m "on the node" && git log --oneline | head -1`, { timeoutMs: 60_000 });
  check("a change and a commit were made on the node", [change.code, /on the node$/.test(change.stdout.trim())], [0, true]);

  console.log("bringing the session back…");
  const homePlan = await api("POST", `/api/sessions/${sessionId}/move/home/plan`);
  check("bring-back plan is ok with no local conflicts", [homePlan.body.ok, homePlan.body.conflicts], [true, []]);
  const back = await api("POST", `/api/sessions/${sessionId}/move/home`, { terminateNode: false, whenIdle: false });
  check("bring-back accepted", back.status, 202);
  for (let i = 0; i < 600; i++) {
    move = (await api("GET", `/api/sessions/${sessionId}/move`)).body.move;
    if (move && ["done", "error"].includes(move.state)) break;
    await sleep(1000);
  }
  check("bring-back completed", [move?.state, move?.error], ["done", undefined]);
  check("the node's file and deletion arrived; ignored files untouched", [existsSync(join(repo, "from-cloud.txt")) && readFileSync(join(repo, "from-cloud.txt"), "utf-8"), existsSync(join(repo, "untracked.txt")), existsSync(join(repo, "ignored.txt"))], ["cloud\n", false, true]);
  check("the commit made on the node is in the local repo", git("log", "--oneline").split("\n")[0].endsWith("on the node"), true);
  check("local git is clean after the round trip", git("status", "--porcelain"), "");
  const home = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
  check("the session is local again", [home.devboxId ?? null, home.move.history.map((h) => h.direction)], [null, ["out", "home"]]);
} catch (error) {
  failed++;
  console.log(`  FAIL ${error.message}`);
} finally {
  if (failed) console.log(serverLog.split("\n").filter((l) => /move|compute|devbox/.test(l)).slice(-30).join("\n"));
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
