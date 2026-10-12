#!/usr/bin/env node
// End-to-end move / bring-back against a Docker sshd container standing in
// for a node. Skips (exit 0) when Docker is not running. Uses an isolated
// server on port 7968 with a scratch LAUNCH_CWD so the real app is untouched.

import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist", "electron", "server");
const PORT = Number(process.env.NAUGHT_TEST_PORT || 7968);
const IMAGE = "naught-move-test:latest";

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); console.log(`         actual   ${JSON.stringify(actual)}`); console.log(`         expected ${JSON.stringify(expected)}`); }
}

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
}

try {
  sh("docker", ["info"]);
} catch {
  console.log("skipped: docker is not running");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "naught-docker-"));
process.env.LAUNCH_CWD = scratch;
process.env.OPENUI_QUIET = "1";

const keys = await import(join(dist, "services", "compute", "sshKeys.js"));
const { privateKeyPath, publicKey } = await keys.ensureNaughtKeypair();

// ── image + container ───────────────────────────────────────────────────────
const context = join(scratch, "docker");
mkdirSync(context, { recursive: true });
writeFileSync(join(context, "authorized_keys"), `${publicKey}\n`);
writeFileSync(join(context, "Dockerfile"), [
  "FROM ubuntu:22.04",
  "ENV DEBIAN_FRONTEND=noninteractive",
  "RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 git tar sudo ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd",
  "RUN useradd -m -s /bin/bash node && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node && mkdir -p /home/node/.ssh && chmod 700 /home/node/.ssh",
  "COPY authorized_keys /home/node/.ssh/authorized_keys",
  "RUN chown -R node:node /home/node/.ssh && chmod 600 /home/node/.ssh/authorized_keys",
  'CMD ["/usr/sbin/sshd", "-D", "-e"]',
  "",
].join("\n"));
console.log("building the sshd image…");
sh("docker", ["build", "-q", "-t", IMAGE, context]);
const container = sh("docker", ["run", "-d", "--rm", "-p", "127.0.0.1:0:22", IMAGE]);
const port = Number(sh("docker", ["port", container, "22"]).split(":").pop());
console.log(`container ${container.slice(0, 12)} on port ${port}`);

let server = null;
const cleanup = () => {
  try { server?.kill("SIGKILL"); } catch { /* gone */ }
  try { sh("docker", ["rm", "-f", container]); } catch { /* gone */ }
  try { sh("ssh-keygen", ["-R", `[127.0.0.1]:${port}`]); } catch { /* no entry */ }
};
process.on("exit", cleanup);

const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // wait for sshd
  for (let i = 0; i < 30; i++) {
    try { sh("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=3", "-i", privateKeyPath, "-p", String(port), "node@127.0.0.1", "true"]); break; } catch { await sleep(1000); }
  }

  // ── isolated server ────────────────────────────────────────────────────
  server = spawn(process.execPath, ["-e", `require(${JSON.stringify(join(dist, "index.js"))}).startServer()`], {
    env: { ...process.env, PORT: String(PORT), LAUNCH_CWD: scratch, OPENUI_QUIET: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (c) => { serverLog += c; });
  server.stderr.on("data", (c) => { serverLog += c; });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await api("GET", "/api/sessions")).status === 200) { up = true; break; } } catch { /* not yet */ }
    await sleep(500);
  }
  check("isolated server is up", up, true);

  const devbox = await api("POST", "/api/devboxes", { name: "docker-node", host: "127.0.0.1", user: "node", port, identityFile: privateKeyPath });
  check("devbox registered", devbox.status, 200);
  const nodeId = devbox.body.devbox.id;
  check("devbox connection test", (await api("POST", `/api/devboxes/${nodeId}/test`)).body.ok, true);

  // ── a local repo and a shell session in it ─────────────────────────────
  const repo = join(scratch, "work", "proj");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => sh("git", ["-c", "user.email=t@x", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  writeFileSync(join(repo, "ignored.txt"), "ignored\n");

  const created = await api("POST", "/api/sessions", { agentId: "shell", agentName: "Shell", command: "", cwd: repo, customName: "mover" });
  check("shell session created", created.status, 200);
  const sessionId = created.body.sessionId;
  await sleep(2500);

  // ── move out ───────────────────────────────────────────────────────────
  const plan = await api("POST", `/api/sessions/${sessionId}/move/plan`, { nodeId });
  check("plan is ok for a shell session", [plan.body.ok, plan.body.harness.kind, plan.body.manifest.files], [true, "shell", 3]);
  const moved = await api("POST", `/api/sessions/${sessionId}/move`, { nodeId, whenIdle: false });
  check("move accepted", moved.status, 202);
  let move = null;
  for (let i = 0; i < 240; i++) {
    move = (await api("GET", `/api/sessions/${sessionId}/move`)).body.move;
    if (move && (move.state === "done" || move.state === "error")) break;
    await sleep(1000);
  }
  check("move completed", [move?.state, move?.error], ["done", undefined]);
  const remoteLs = sh("docker", ["exec", container, "sh", "-c", `ls -1 ${repo} && cat ${repo}/untracked.txt`]);
  check("files are on the node at the same path, ignored ones stayed home", remoteLs.split("\n"), [".gitignore", "tracked.txt", "untracked.txt", "untracked"]);
  const remoteGit = sh("docker", ["exec", container, "sh", "-c", `cd ${repo} && git status --porcelain && git log --oneline | head -1`]);
  check("git works on the node", remoteGit.includes("?? untracked.txt") && remoteGit.includes("init"), true);
  const sessionsAfter = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
  check("the session now points at the node", [sessionsAfter.devboxId, sessionsAfter.remotePath], [nodeId, repo]);
  let status = "";
  for (let i = 0; i < 30; i++) {
    status = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId).status;
    if (status !== "running") break;
    await sleep(1000);
  }
  check("the remote shell is at a prompt", ["idle", "waiting_input"].includes(status) || status === "running", true);

  // ── a change on the node, then bring it back ───────────────────────────
  sh("docker", ["exec", container, "sh", "-c", `echo remote > ${repo}/from-node.txt && rm ${repo}/untracked.txt`]);
  const homePlan = await api("POST", `/api/sessions/${sessionId}/move/home/plan`);
  check("bring-back plan is ok with no local conflicts", [homePlan.body.ok, homePlan.body.conflicts], [true, []]);
  const back = await api("POST", `/api/sessions/${sessionId}/move/home`, { terminateNode: false, whenIdle: false });
  check("bring-back accepted", back.status, 202);
  for (let i = 0; i < 240; i++) {
    move = (await api("GET", `/api/sessions/${sessionId}/move`)).body.move;
    if (move && (move.state === "done" || move.state === "error")) break;
    await sleep(1000);
  }
  check("bring-back completed", [move?.state, move?.error], ["done", undefined]);
  check("the node's new file arrived and its deletion was applied", [existsSync(join(repo, "from-node.txt")) && readFileSync(join(repo, "from-node.txt"), "utf-8"), existsSync(join(repo, "untracked.txt")), existsSync(join(repo, "ignored.txt"))], ["remote\n", false, true]);
  const sessionsHome = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
  check("the session is local again", [sessionsHome.devboxId ?? null, sessionsHome.move.history.map((h) => h.direction)], [null, ["out", "home"]]);
  if (failed) console.log(serverLog.split("\n").slice(-40).join("\n"));
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
