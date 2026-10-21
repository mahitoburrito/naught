#!/usr/bin/env node
// Live: move a local shell session (git repo) to one of the user's own
// devboxes (an ~/.ssh/config alias) and back, through a running Naught.
//
//   NAUGHT_URL=http://127.0.0.1:7968 node scripts/smoke-move-devbox.mjs <ssh-alias>

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = process.env.NAUGHT_URL || "http://127.0.0.1:7968";
const alias = process.argv[2];
if (!alias) { console.log("usage: smoke-move-devbox.mjs <ssh-alias>"); process.exit(2); }

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", alias, cmd], { encoding: "utf-8" }).trim();
async function waitMove(sessionId) {
  for (let i = 0; i < 600; i++) {
    const move = (await api("GET", `/api/sessions/${sessionId}/move`)).body?.move;
    if (move && ["done", "error"].includes(move.state)) return move;
    await sleep(1000);
  }
  return null;
}

// Register the alias as a devbox (reuse if already there).
const listed = (await api("GET", "/api/devboxes")).body.devboxes;
let box = listed.find((b) => b.name === alias && b.source === "ssh-config");
if (!box) box = (await api("POST", "/api/devboxes", { name: alias, source: "ssh-config" })).body.devbox;
check("devbox registered", !!box?.id, box?.id);
check("connection test", (await api("POST", `/api/devboxes/${box.id}/test`)).body?.ok === true);

const repo = join(homedir(), ".naught-preview", "work", `devbox-move-${Date.now().toString(36)}`);
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf-8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "from the mac\n");
git("add", ".");
git("commit", "-q", "-m", "init");
writeFileSync(join(repo, "wip.txt"), "uncommitted work\n");

const created = await api("POST", "/api/sessions", { agentId: "shell", agentName: "Shell", command: "", cwd: repo, customName: "devbox move test" });
const sessionId = created.body.sessionId;
check("local session created", created.status === 200);
await sleep(2500);

const plan = await api("POST", `/api/sessions/${sessionId}/move/plan`, { nodeId: box.id });
check("plan ok", plan.body?.ok === true, (plan.body?.refusals || []).join(" | "));
const moved = await api("POST", `/api/sessions/${sessionId}/move`, { nodeId: box.id, whenIdle: false });
check("move accepted", moved.status === 202, JSON.stringify(moved.body?.error || ""));
let move = await waitMove(sessionId);
check("move completed", move?.state === "done", move?.error || move?.state);
const remote = ssh(`cd '${repo}' && ls -1A && git status --porcelain && git log --oneline | head -1`);
check("repo is on the devbox at the same path with uncommitted work", remote.includes("wip.txt") && remote.includes("?? wip.txt") && remote.includes("init"), remote.replace(/\n/g, " | "));
const session = (await api("GET", "/api/sessions")).body.find((s) => s.sessionId === sessionId);
check("session runs on the devbox", session?.devboxId === box.id, `${session?.devboxName} ${session?.remotePath || ""}`);

ssh(`cd '${repo}' && echo 'edited on the devbox' > from-devbox.txt && git add -A && git -c user.email=d@x -c user.name=d commit -q -m 'on the devbox'`);
const back = await api("POST", `/api/sessions/${sessionId}/move/home`, { terminateNode: false, whenIdle: false });
check("bring-back accepted", back.status === 202, JSON.stringify(back.body?.error || back.body?.refusals || ""));
move = await waitMove(sessionId);
check("bring-back completed", move?.state === "done", move?.error || move?.state);
check("devbox edits and commit are back on the Mac", existsSync(join(repo, "from-devbox.txt")) && readFileSync(join(repo, "from-devbox.txt"), "utf-8") === "edited on the devbox\n" && git("log", "--oneline").split("\n")[0].endsWith("on the devbox"));
check("local git is clean", git("status", "--porcelain") === "");

await api("DELETE", `/api/sessions/${sessionId}`);
ssh(`rm -rf '${repo}'`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
