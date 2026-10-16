#!/usr/bin/env node
// Live: an agent conversation survives a move to a real Modal node and back.
// Drives a running Naught server (default the preview on 7968) the way a user
// would: types into the session over the terminal WebSocket.
//
//   NAUGHT_LIVE_SMOKE=1 NAUGHT_URL=http://127.0.0.1:7968 node scripts/smoke-agent-move-live.mjs [claude|codex] [nodeId]

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { createRequire } from "module";
import { join } from "path";

if (process.env.NAUGHT_LIVE_SMOKE !== "1") {
  console.log("skipped: set NAUGHT_LIVE_SMOKE=1");
  process.exit(0);
}
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const BASE = process.env.NAUGHT_URL || "http://127.0.0.1:7968";
const agent = process.argv[2] || "claude";
let nodeId = process.argv[3] || "";
const CODEWORD = `PINEAPPLE-${Math.floor(Math.random() * 900 + 100)}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const strip = (s) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b[=>78DEHM]/g, "");

// ── terminal client ──────────────────────────────────────────────────────────
let screen = "";
let ws = null;
function connect(sessionId) {
  return new Promise((resolve) => {
    const url = BASE.replace(/^http/, "ws") + `/ws?sessionId=${encodeURIComponent(sessionId)}`;
    ws = new WebSocket(url, { headers: { Origin: BASE } });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "output" && typeof msg.data === "string") {
          screen += msg.data;
          answerTerminalQueries(msg.data);
        }
      } catch { /* binary or other */ }
    });
    ws.on("open", () => resolve());
    ws.on("close", () => { ws = null; });
    ws.on("error", () => resolve());
  });
}
const send = (data) => ws?.send(JSON.stringify({ type: "input", data }));
// A headless client has no emulator. TUIs such as Codex query the terminal at
// start-up (cursor position, colours, device attributes) and quit when nothing
// answers, so answer the way xterm in the app would.
function answerTerminalQueries(data) {
  if (data.includes("\x1b[6n")) send("\x1b[1;1R");
  if (data.includes("\x1b]10;?")) send("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
  if (data.includes("\x1b]11;?")) send("\x1b]11;rgb:0000/0000/0000\x1b\\");
  if (/\x1b\[0?c/.test(data)) send("\x1b[?62;22c");
  if (data.includes("\x1b[?u")) send("\x1b[?0u");
}
async function typeLine(text) {
  send(text);
  await sleep(400);
  send("\r");
}
function plainSince(mark) { return strip(screen.slice(mark)).replace(/\s+/g, ""); }
async function waitFor(pattern, mark, timeoutMs, onTick) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = plainSince(mark);
    if (pattern.test(text)) return true;
    if (onTick) await onTick(text);
    await sleep(500);
  }
  return false;
}
async function status(sessionId) {
  return (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
}
async function waitIdle(sessionId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await status(sessionId);
    if (s && ["idle", "waiting_input"].includes(s.status)) return s;
    await sleep(1000);
  }
  return status(sessionId);
}
// First-run screens. Locally the user answers the folder-trust question once
// (as they would). On the node none of these should appear: the move carries
// onboarding and trust across, so any that do are recorded as failures.
let phase = "local";
const prompted = { local: new Set(), node: new Set() };
const DOWN = "\x1b[B";
async function answerPrompts(text) {
  const tail = text.slice(-1500);
  const rules = [
    [/Yes,Itrustthisfolder/i, "claude-trust", DOWN + "\r"],
    [/Choosethetextstyle|textstylethatlooksbest/i, "claude-theme", "\r"],
    [/Selectloginmethod/i, "claude-login", "\r"],
    [/Doyoutrustthecontents|AllowCodextoworkinthisfolder|Trustthisfolder\?Codex/i, "codex-trust", "\r"],
    [/Updateavailable!.*Skip/i, "codex-update", "3\r"],
  ];
  for (const [re, key, keys] of rules) {
    const seen = prompted[phase];
    if (re.test(tail) && !seen.has(key)) {
      seen.add(key);
      console.log(`    (${phase}: answered first-run screen ${key})`);
      send(keys);
      await sleep(1000);
    }
  }
}
async function waitMove(sessionId, timeoutMs) {
  const started = Date.now();
  let move = null;
  while (Date.now() - started < timeoutMs) {
    move = (await api("GET", `/api/sessions/${sessionId}/move`)).body?.move;
    if (move && ["done", "error"].includes(move.state)) return move;
    await answerPrompts(plainSince(Math.max(0, screen.length - 4000)));
    await sleep(1000);
  }
  return move;
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`agent=${agent} codeword=${CODEWORD} server=${BASE}`);
if (!nodeId) {
  console.log("provisioning a CPU Modal node…");
  const created = await api("POST", "/api/compute/nodes", { provider: "modal", cpu: 2, memoryGb: 8, name: `naught-agent-${agent}`, maxLifetimeHours: 1 });
  check("node requested", created.status === 201, `HTTP ${created.status} ${JSON.stringify(created.body?.reasons || created.body?.error || "")}`);
  nodeId = created.body.node.id;
  for (let i = 0; i < 1200; i++) {
    const node = (await api("GET", `/api/compute/nodes/${nodeId}`)).body.node;
    if (["ready", "error", "terminated"].includes(node.provision.status)) {
      check("node ready", node.provision.status === "ready", node.provision.error || `${node.user}@${node.host}:${node.port}`);
      break;
    }
    await sleep(1000);
  }
}
console.log(`node ${nodeId}`);

const repo = join(homedir(), ".naught-preview", "work", `${agent}-proj-${Date.now().toString(36)}`);
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), `# ${agent} move test\n`);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

const created = await api("POST", "/api/sessions", { agentId: agent, agentName: agent === "claude" ? "Claude Code" : "Codex", command: process.env.NAUGHT_AGENT_COMMAND || agent, cwd: repo, customName: `${agent} move test` });
check("local agent session created", created.status === 200, JSON.stringify(created.body?.error || ""));
const sessionId = created.body.sessionId;
await connect(sessionId);

// 1. Teach it the codeword locally.
let mark = screen.length;
const ready = await waitFor(agent === "claude" ? /\?forshortcuts|Try"/ : /AskCodextodoanything/, mark, 60_000, answerPrompts);
check("agent TUI came up locally", ready);
// Screens like folder trust can draw on top of an already-rendered prompt box;
// keep answering for a few seconds before typing.
await waitFor(/(?!)/, mark, 6000, answerPrompts);
await sleep(1500);
mark = screen.length;
await typeLine(`Remember this codeword for later in our conversation: ${CODEWORD}. Reply with only the word OK.`);
const ack = await waitFor(/OK/, mark, 120_000, answerPrompts);
check("agent acknowledged the codeword locally", ack);
await waitIdle(sessionId, 60_000);
await sleep(3000);

const plan = await api("POST", `/api/sessions/${sessionId}/move/plan`, { nodeId });
check("move plan found the conversation", plan.body?.harness?.found === true && plan.body?.harness?.kind === agent, plan.body?.harness?.description || JSON.stringify(plan.body));
check("move plan has no refusals", plan.body?.ok === true, (plan.body?.refusals || []).join(" | "));

// 2. Move it to the node.
console.log("moving to the node…");
phase = "node";
mark = screen.length;
const moved = await api("POST", `/api/sessions/${sessionId}/move`, { nodeId, whenIdle: true });
check("move accepted", moved.status === 202, JSON.stringify(moved.body?.error || moved.body?.refusals || ""));
const move = await waitMove(sessionId, 15 * 60_000);
check("move completed", move?.state === "done", move?.error || move?.state);
const remote = await status(sessionId);
check("card points at the node", remote?.devboxId === nodeId, `${remote?.devboxName} ${remote?.remotePath || ""}`);
await waitFor(/\?forshortcuts|AskCodextodoanything|Try"/, mark, 90_000, answerPrompts);
await sleep(3000);
const remoteScreen = plainSince(mark);
const onNode = /root@|modal|r\d+\.modal\.host/.test(remoteScreen) || /--resume|resume/.test(remoteScreen);
check("no first-run screens on the node", prompted.node.size === 0, [...prompted.node].join(", "));

// 3. Ask on the node.
mark = screen.length;
await typeLine("What codeword did I ask you to remember? Reply with only the codeword.");
const recalledRemote = await waitFor(new RegExp(CODEWORD), mark, 180_000, answerPrompts);
check("the agent ON THE NODE recalled the codeword (conversation resumed)", recalledRemote && move?.state === "done" && remote?.devboxId === nodeId, recalledRemote ? "" : plainSince(mark).slice(-600));
await waitIdle(sessionId, 90_000);
await sleep(3000);

// 4. Bring it home and ask again.
console.log("bringing it back…");
phase = "home";
prompted.home = new Set();
mark = screen.length;
const back = await api("POST", `/api/sessions/${sessionId}/move/home`, { terminateNode: false, whenIdle: true });
check("bring-back accepted", back.status === 202, JSON.stringify(back.body?.error || back.body?.refusals || ""));
const home = await waitMove(sessionId, 15 * 60_000);
check("bring-back completed", home?.state === "done", home?.error || home?.state);
check("card is local again", !(await status(sessionId))?.devboxId);
await waitFor(/\?forshortcuts|AskCodextodoanything|Try"/, mark, 90_000, answerPrompts);
await sleep(3000);
mark = screen.length;
await typeLine("Say the codeword one more time, and nothing else.");
const recalledHome = await waitFor(new RegExp(CODEWORD), mark, 180_000, answerPrompts);
check("the agent BACK HOME still has the conversation", recalledHome && home?.state === "done", recalledHome ? "" : plainSince(mark).slice(-600));

ws?.close();
console.log(`\nsession ${sessionId} left running in the preview; node ${nodeId} left for reuse`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
