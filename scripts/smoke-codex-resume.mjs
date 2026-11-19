#!/usr/bin/env node
// End-to-end: a Codex node learns its thread id from the prompt typed into it,
// comes back in that thread after the app dies, stays closed after /quit, and a
// node saved without an id gets one recovered from its remembered prompts. A
// stub `codex` on PATH writes rollouts like Codex does, so no real agent runs.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "electron", "server", "index.js");
const NEW_ID = "01a1f000-0000-7000-8000-00000000aaaa";
const OLD_ID = "01a1e000-0000-7000-8000-00000000bbbb";
let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         actual   ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`timed out: ${label}`);
}

const root = mkdtempSync(join(tmpdir(), "openui-codex-smoke-"));
const data = join(root, "data");
const bin = join(root, "bin");
const codexHome = join(root, "codex-home");
const argvLog = join(root, "codex-argv.log");
mkdirSync(data, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(codexHome, { recursive: true });

// Like Codex: one rollout per thread, a user message per submitted line, and
// the resume hint printed on /quit. `resume <id>` continues that thread.
writeFileSync(join(bin, "codex"), `#!/bin/bash
echo "$*" >> '${argvLog}'
id='${NEW_ID}'
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do [ "\${args[$i]}" = resume ] && id="\${args[$((i+1))]}"; done
day="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"; mkdir -p "$day"
f=$(ls "$CODEX_HOME"/sessions/*/*/*/*-$id.jsonl 2>/dev/null | head -1)
if [ -z "$f" ]; then f="$day/rollout-2026-11-18T10-00-00-$id.jsonl"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\\n' "$id" "$PWD" > "$f"; fi
echo "codex ready"
while IFS= read -r line; do
  line="\${line%$'\\r'}"
  if [ "$line" = /quit ]; then printf 'Disconnected from this task. Any running work continues.\r\nTo reconnect, run:\r\n  \\033[36mcodex resume %s\\033[39m\r\n' "$id"; exit 0; fi
  printf '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"%s"}]}}\\n' "$line" >> "$f"
done
`);
chmodSync(join(bin, "codex"), 0o755);

// A thread from before ids were kept, for the backfill node.
const oldDay = join(codexHome, "sessions", "2026", "11", "17");
mkdirSync(oldDay, { recursive: true });
const msg = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
writeFileSync(join(oldDay, `rollout-2026-11-17T09-00-00-${OLD_ID}.jsonl`), [
  JSON.stringify({ type: "session_meta", payload: { id: OLD_ID, cwd: root } }),
  msg("look at the anime episodes"), msg("now clip the opening scene"),
].join("\n") + "\n");

const node = (id, extra) => ({ nodeId: `node-${id}`, sessionId: `session-${id}`, cwd: root, createdAt: new Date(Date.now() - 86_400_000 * 3).toISOString(), position: { x: 0, y: 0 }, agentId: "codex", agentName: "Codex", command: "codex --yolo", ...extra });
writeFileSync(join(data, "state.json"), JSON.stringify({ version: 2, savedAt: Date.now(), nodes: [
  node("live", {}),
  node("old", { titlePromptHistory: ["look at the anime episodes", "now clip the opening scene", "/resume"] }),
] }));
mkdirSync(join(root, ".openui-desktop"), { recursive: true });
const setResumeOnLaunch = (value) => writeFileSync(join(root, ".openui-desktop", "config.json"), JSON.stringify({ resumeSessionsOnLaunch: value }));

const port = 7988;
let child = null;
function startServer() {
  child = spawn(process.execPath, ["-e", `require(${JSON.stringify(serverEntry)}).startServer()`], {
    env: { ...process.env, PORT: String(port), LAUNCH_CWD: root, OPENUI_DATA_DIR: data, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
}
async function killServer() {
  // SIGKILL is the power cord: no quit handler runs.
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  await sleep(300);
}
const api = async (path, init) => { const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { "Content-Type": "application/json" } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const sessions = async () => (await api("/sessions").catch(() => ({ body: null }))).body;
const argv = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean) : []);
const saved = (id) => { try { return JSON.parse(readFileSync(join(data, "state.json"), "utf8")).nodes.find((n) => n.sessionId === id); } catch { return null; } };
async function type(sessionId, text) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${sessionId}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  for (const ch of text) ws.send(JSON.stringify({ type: "input", data: ch }));
  ws.send(JSON.stringify({ type: "input", data: "\r" }));
  await sleep(300);
  ws.close();
}

try {
  console.log("first launch: recovery and live capture");
  setResumeOnLaunch(true);
  startServer();
  await waitFor(async () => (await sessions())?.length === 2, "server up");
  await waitFor(() => argv().length >= 2, "both codex nodes launched");
  check("the node without prompts relaunches fresh, the old node resumes its recovered thread",
    argv().sort(), [`--yolo resume ${OLD_ID}`, "--yolo"].sort());
  check("the recovered id is saved", saved("session-old")?.resumeSessionId, OLD_ID);

  await sleep(1500);
  await type("session-live", "please build the parser");
  await waitFor(() => saved("session-live")?.resumeSessionId === NEW_ID, "live thread id captured");
  check("typing a prompt binds the node to its Codex thread", saved("session-live")?.resumeSessionId, NEW_ID);

  console.log("\npower off, relaunch");
  await killServer();
  writeFileSync(argvLog, "");
  startServer();
  await waitFor(() => argv().length >= 2, "codex relaunched after the crash");
  check("both nodes come back in their own threads", argv().sort(), [`--yolo resume ${NEW_ID}`, `--yolo resume ${OLD_ID}`].sort());

  console.log("\n/quit keeps a node closed");
  await sleep(1500);
  await type("session-live", "/quit");
  await waitFor(() => saved("session-live")?.manuallyEnded === true, "quit recorded");
  check("quitting Codex marks the node ended", saved("session-live")?.manuallyEnded, true);
  check("its thread id is kept for a manual resume", saved("session-live")?.resumeSessionId, NEW_ID);
  await killServer();
  writeFileSync(argvLog, "");
  startServer();
  await waitFor(() => argv().length >= 1, "relaunch after quit");
  await sleep(2000);
  check("only the node that was not quit comes back", argv(), [`--yolo resume ${OLD_ID}`]);
  const list = await sessions();
  check("the quit node still offers Resume", list.find((s) => s.sessionId === "session-live")?.resumable, true);
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.message}`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
