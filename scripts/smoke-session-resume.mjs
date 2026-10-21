#!/usr/bin/env node
// End-to-end: saved nodes come back on launch, resume relaunches Claude with
// --resume <id>, and "resume on launch" brings them up without a click. A stub
// `claude` on PATH records its argv, so no real agent runs.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "electron", "server", "index.js");
const ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         actual   ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`timed out: ${label}`);
}

function scenario(port, { resumeOnLaunch }) {
  const root = mkdtempSync(join(tmpdir(), "openui-resume-smoke-"));
  const data = join(root, "data");
  const bin = join(root, "bin");
  const claudeConfig = join(root, "claude-config");
  const argvLog = join(root, "claude-argv.log");
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(claudeConfig, "projects", "-repo"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "-repo", `${ID}.jsonl`), "{}\n");
  const stopFile = join(root, "stop-claude");
  // Records its argv, then runs until the test asks it to exit, like Claude ending a session.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> '${argvLog}'\nwhile [ ! -f '${stopFile}' ]; do sleep 0.2; done\nrm -f '${stopFile}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const node = (id, extra) => ({ nodeId: `node-${id}`, sessionId: `session-${id}`, cwd: root, createdAt: new Date().toISOString(), position: { x: 0, y: 0 }, ...extra });
  writeFileSync(join(data, "state.json"), JSON.stringify({ version: 2, savedAt: Date.now(), nodes: [
    node("claude", { agentId: "claude", agentName: "Claude Code", command: "claude --model opus", resumeSessionId: ID }),
    node("shell", { agentId: "shell", agentName: "Shell", command: "" }),
  ] }));
  if (resumeOnLaunch) {
    mkdirSync(join(root, ".openui-desktop"), { recursive: true });
    writeFileSync(join(root, ".openui-desktop", "config.json"), JSON.stringify({ resumeSessionsOnLaunch: true }));
  }
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(serverEntry)}).startServer()`], {
    env: { ...process.env, PORT: String(port), LAUNCH_CWD: root, OPENUI_DATA_DIR: data, CLAUDE_CONFIG_DIR: claudeConfig, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const api = async (path, init) => { const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const sessions = async () => (await api("/sessions").catch(() => ({ body: null }))).body;
  const argv = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : []);
  const stop = () => { child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); };
  const savedNode = (id) => {
    try { return JSON.parse(readFileSync(join(data, "state.json"), "utf8")).nodes.find((n) => n.sessionId === id); } catch { return null; }
  };
  const exitClaude = () => writeFileSync(stopFile, "");
  return { api, sessions, argv, stop, savedNode, exitClaude, stderr: () => stderr };
}

console.log("manual resume");
{
  const s = scenario(7978, { resumeOnLaunch: false });
  try {
    const list = await waitFor(async () => { const l = await s.sessions(); return Array.isArray(l) && l.length === 2 ? l : null; }, "server up");
    const byId = Object.fromEntries(list.map((x) => [x.sessionId, x]));
    check("both nodes come back disconnected", [byId["session-claude"].status, byId["session-shell"].status], ["disconnected", "disconnected"]);
    check("the Claude node says it can resume its conversation", [byId["session-claude"].resumable, byId["session-shell"].resumable], [true, false]);
    await sleep(1500);
    check("nothing relaunches without the setting", s.argv(), []);
    const res = await s.api("/sessions/session-claude/restart", { method: "POST", body: JSON.stringify({ resume: true }) });
    check("resume succeeds and reports it resumed", [res.status, res.body?.resumed], [200, true]);
    const lines = await waitFor(() => (s.argv().length ? s.argv() : null), "stub claude launched");
    check("claude relaunched with its flags and --resume <id>", [lines.length, lines[0].endsWith(`--model opus --resume ${ID}`)], [1, true]);
    const shell = await s.api("/sessions/session-shell/restart", { method: "POST", body: JSON.stringify({ resume: true }) });
    check("a shell node relaunches without resuming", [shell.status, shell.body?.resumed], [200, false]);
    const again = await s.api("/sessions/session-claude/restart", { method: "POST", body: JSON.stringify({ resume: true }) });
    check("a running session is not relaunched twice", again.status, 400);
    // Claude exits on its own while its shell keeps running; the node shows offline.
    s.exitClaude();
    await sleep(1500);
    await s.api("/status-update", { method: "POST", body: JSON.stringify({ status: "disconnected", openuiSessionId: "session-claude", claudeSessionId: ID, hookEvent: "SessionEnd" }) });
    const offline = await waitFor(async () => { const l = await s.sessions(); const c = l?.find((x) => x.sessionId === "session-claude"); return c?.status === "disconnected" ? c : null; }, "agent-exited node offline");
    check("an exited agent with a live shell is offered a resume", offline.resumable, true);
    const relaunch = await s.api("/sessions/session-claude/restart", { method: "POST", body: JSON.stringify({ resume: true }) });
    check("resume works while the shell is still alive", [relaunch.status, relaunch.body?.resumed], [200, true]);
    const twice = await waitFor(() => (s.argv().length >= 2 ? s.argv() : null), "claude relaunched in the live shell").catch(() => s.argv());
    check("claude ran again in the same shell with --resume", [twice.length, (twice[1] || "").endsWith(`--resume ${ID}`)], [2, true]);
    const NEXT = "9a8b7c6d-1111-4222-8333-944455566677";
    const hook = (hookEvent) => s.api("/status-update", { method: "POST", body: JSON.stringify({ status: hookEvent === "SessionEnd" ? "idle" : "running", openuiSessionId: "session-claude", claudeSessionId: NEXT, hookEvent }) });
    await hook("SessionStart");
    await hook("SessionEnd");
    const saved = await waitFor(() => (s.savedNode("session-claude")?.resumeSessionId === NEXT ? s.savedNode("session-claude") : null), "new id saved", 15000).catch(() => s.savedNode("session-claude"));
    check("a new Claude session id is saved and survives SessionEnd", saved?.resumeSessionId, NEXT);
    await s.api("/status-update", { method: "POST", body: JSON.stringify({ status: "running", openuiSessionId: "session-claude", claudeSessionId: "bad id; rm -rf ~", hookEvent: "SessionStart" }) });
    await sleep(11000);
    check("an unsafe id from a hook is never saved", s.savedNode("session-claude")?.resumeSessionId, NEXT);
  } catch (e) { failed++; console.log(`  FAIL ${e.message}\n${s.stderr().slice(-800)}`); }
  finally { s.stop(); }
}

console.log("\nresume on launch");
{
  const s = scenario(7979, { resumeOnLaunch: true });
  try {
    const lines = await waitFor(() => (s.argv().length ? s.argv() : null), "auto-resumed claude");
    check("claude resumed by itself on launch", [lines.length, lines[0].endsWith(`--model opus --resume ${ID}`)], [1, true]);
    const list = await waitFor(async () => { const l = await s.sessions(); return Array.isArray(l) && l.every((x) => x.status !== "disconnected") ? l : null; }, "all nodes live");
    check("every saved node is live again", list.map((x) => x.status !== "disconnected"), [true, true]);
  } catch (e) { failed++; console.log(`  FAIL ${e.message}\n${s.stderr().slice(-800)}`); }
  finally { s.stop(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
