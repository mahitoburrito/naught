#!/usr/bin/env node
// Behaviour tests for resuming saved sessions: the resume command builder,
// transcript lookup, and the persisted resume id.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron", "server", "services");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         actual   ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`);
  }
}

const ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";

console.log("agentResume");
{
  const r = await import(join(dist, "agentResume.js"));

  check("uuid is resumable", r.isResumableSessionId(ID), true);
  check("shell metacharacters are not", r.isResumableSessionId("abc; rm -rf ~"), false);
  check("empty is not", r.isResumableSessionId(""), false);

  check("plain claude gets --resume", r.buildResumeCommand("claude", "claude", ID), `claude --resume ${ID}`);
  check("flags are kept", r.buildResumeCommand("claude --model opus", "claude", ID), `claude --model opus --resume ${ID}`);
  check("an old --resume is replaced", r.buildResumeCommand("claude --resume old-id --model opus", "claude", ID), `claude --model opus --resume ${ID}`);
  check("-r, --continue and -c are dropped", r.buildResumeCommand("claude -r old -c --continue --verbose", "claude", ID), `claude --verbose --resume ${ID}`);
  check("--resume=value form is dropped", r.buildResumeCommand("claude --resume=old", "claude", ID), `claude --resume ${ID}`);
  check("resume keeps the same conversation even if launch used --fork-session", r.buildResumeCommand("claude --fork-session --model opus", "claude", ID), `claude --model opus --resume ${ID}`);
  check("compound commands cannot append resume flags to the wrong process", r.buildResumeCommand("claude && echo done", "claude", ID), null);
  check("shell pipelines are not rewritten", r.buildResumeCommand("claude | cat", "claude", ID), null);
  check("a shell comment cannot swallow the resume flags", r.buildResumeCommand("claude --model opus # launch", "claude", ID), null);
  check("quoted shell punctuation is preserved", r.buildResumeCommand('claude --append-system-prompt "Use a && b"', "claude", ID), `claude --append-system-prompt "Use a && b" --resume ${ID}`);
  check("an unsafe id leaves the command alone", r.buildResumeCommand("claude", "claude", "x; y"), null);
  check("quoted text that mentions a flag is left intact", r.buildResumeCommand('claude --append-system-prompt "Never use --continue here"', "claude", ID), `claude --append-system-prompt "Never use --continue here" --resume ${ID}`);
  check("a quoted multi-word --resume value is removed whole", r.buildResumeCommand('claude --resume "old id" --model opus', "claude", ID), `claude --model opus --resume ${ID}`);
  check("bare -r before another flag keeps that flag", r.buildResumeCommand("claude -r --model opus", "claude", ID), `claude --model opus --resume ${ID}`);
  check("bare --resume at the end", r.buildResumeCommand("claude --resume", "claude", ID), `claude --resume ${ID}`);
  check("single quotes survive", r.buildResumeCommand("claude --append-system-prompt 'a b'", "claude", ID), `claude --append-system-prompt 'a b' --resume ${ID}`);
  check("an absolute path to claude is recognised", r.buildResumeCommand("/usr/local/bin/claude --model opus", "claude", ID), `/usr/local/bin/claude --model opus --resume ${ID}`);
  check("a profile that runs claude resumes", r.buildResumeCommand("claude --model opus", "profile:reviewer", ID), `claude --model opus --resume ${ID}`);
  check("a profile that runs codex resumes codex", r.buildResumeCommand("codex", "profile:reviewer", ID), `codex resume ${ID}`);
  check("isClaudeCommand: profile running claude", r.isClaudeCommand("claude --verbose", "profile:x"), true);
  check("isClaudeCommand: codex agent", r.isClaudeCommand("codex", "codex"), false);
  check("isClaudeCommand: ssh wrapper", r.isClaudeCommand("ssh box -t 'exec claude'", "claude"), false);
  check("codex resumes by id", r.buildResumeCommand("codex", "codex", ID), `codex resume ${ID}`);
  check("codex keeps its launch flags", r.buildResumeCommand("codex --yolo -m gpt-6 --no-daemon", "codex", ID), `codex --yolo -m gpt-6 --no-daemon resume ${ID}`);
  check("codex flag values that look positional are kept", r.buildResumeCommand("codex -c model_reasoning_effort=high --yolo", "codex", ID), `codex -c model_reasoning_effort=high --yolo resume ${ID}`);
  check("an old codex resume is replaced", r.buildResumeCommand("codex --yolo resume 11111111-2222-3333-4444-555555555555", "codex", ID), `codex --yolo resume ${ID}`);
  check("codex resume --last is replaced", r.buildResumeCommand("codex resume --last", "codex", ID), `codex resume ${ID}`);
  check("codex with a starting prompt is not rewritten", r.buildResumeCommand('codex "fix the tests"', "codex", ID), null);
  check("codex exec is not rewritten", r.buildResumeCommand("codex exec hi", "codex", ID), null);
  check("an absolute path to codex is recognised", r.buildResumeCommand("/opt/bin/codex --yolo", "codex", ID), `/opt/bin/codex --yolo resume ${ID}`);
  check("a devbox codex command is not touched", r.buildResumeCommand("ssh box -t 'exec codex --yolo'", "codex", ID), null);
  check("resumableAgentKind: codex", r.resumableAgentKind("codex --yolo", "codex"), "codex");
  check("resumableAgentKind: claude", r.resumableAgentKind("claude", "claude"), "claude");
  check("resumableAgentKind: ssh", r.resumableAgentKind("ssh box -t 'exec claude'", "claude"), null);
  check("a devbox ssh command is not touched", r.buildResumeCommand("ssh box -t 'cd /x && exec claude'", "claude", ID), null);
  check("a shell node is not touched", r.buildResumeCommand("", "shell", ID), null);

  const config = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(config, "projects", "-Users-x-repo"), { recursive: true });
  writeFileSync(join(config, "projects", "-Users-x-repo", `${ID}.jsonl`), "{}\n");
  check("transcript found in any project dir", r.claudeTranscriptExists(ID, config), true);
  check("missing transcript", r.claudeTranscriptExists("00000000-0000-0000-0000-000000000000", config), false);
  check("missing config dir", r.claudeTranscriptExists(ID, join(config, "nope")), false);

  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(join(codexHome, "sessions", "2026", "11", "17"), { recursive: true });
  const CODEX_ID = "01a1e661-eb8e-7921-ae2c-fd3be9b59155";
  writeFileSync(join(codexHome, "sessions", "2026", "11", "17", `rollout-2026-11-17T10-00-00-${CODEX_ID}.jsonl`), "{}\n");
  const plan = (s, opts) => r.planRelaunch(s, { claudeConfigDir: config, codexHome, ...opts });
  check("resume with a saved transcript", plan({ agentId: "claude", command: "claude", resumeSessionId: ID }, { resume: true }), { command: `claude --resume ${ID}`, resumed: true });
  check("resume without a transcript falls back to a fresh launch", plan({ agentId: "claude", command: "claude", resumeSessionId: "00000000-0000-0000-0000-000000000000" }, { resume: true }), { command: "claude", resumed: false });
  check("resume without a saved id is a fresh launch", plan({ agentId: "claude", command: "claude" }, { resume: true }), { command: "claude", resumed: false });
  check("a plain restart never resumes", plan({ agentId: "claude", command: "claude", resumeSessionId: ID }, { resume: false }), { command: "claude", resumed: false });
  check("codex resumes a saved thread", plan({ agentId: "codex", command: "codex --yolo", resumeSessionId: CODEX_ID }, { resume: true }), { command: `codex --yolo resume ${CODEX_ID}`, resumed: true });
  check("codex without its rollout relaunches fresh", plan({ agentId: "codex", command: "codex", resumeSessionId: ID }, { resume: true }), { command: "codex", resumed: false });
  check("codex without a saved id relaunches fresh", plan({ agentId: "codex", command: "codex" }, { resume: true }), { command: "codex", resumed: false });
  rmSync(codexHome, { recursive: true, force: true });
  check("claude config dir defaults from CLAUDE_CONFIG_DIR", r.defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/cc", HOME: "/home/u" }), "/tmp/cc");
  check("claude config dir defaults to ~/.claude", r.defaultClaudeConfigDir({ HOME: "/home/u" }), "/home/u/.claude");
  const { homedir } = await import("os");
  check("claude config dir falls back to the OS home when HOME is unset", r.defaultClaudeConfigDir({}), join(homedir(), ".claude"));
  rmSync(config, { recursive: true, force: true });
}

console.log("\ncodexSessions");
{
  const c = await import(join(dist, "codexSessions.js"));
  const home = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  const day = join(home, "sessions", "2026", "11", "17");
  mkdirSync(day, { recursive: true });
  const user = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const meta = (id, cwd) => JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp: "2026-11-17T10:00:00Z" } });
  const A = "01a1aaaa-0000-7000-8000-000000000001";
  const B = "01a1bbbb-0000-7000-8000-000000000002";
  const C = "01a1cccc-0000-7000-8000-000000000003";
  const write = (id, lines) => writeFileSync(join(day, `rollout-2026-11-17T10-00-00-${id}.jsonl`), lines.join("\n") + "\n");
  write(A, [meta(A, "/Users/me"), user("# AGENTS.md instructions"), user("Feed in an anime + the manga and output the clips"), user("use the second episode"), user("now make it   faster\nplease")]);
  write(B, [meta(B, "/Users/me"), user("how is this legal?"), user("just trying to understand how they can charge a card")]);
  write(C, [meta(C, "/Users/other"), user("now make it faster please")]);

  check("rollout exists by id", c.codexRolloutExists(A, home), true);
  check("missing rollout", c.codexRolloutExists("01a1dddd-0000-7000-8000-000000000009", home), false);
  check("prompt normalisation collapses whitespace and case", c.normalizePrompt("  Now  make\nIT\x1b[2m faster "), "now make it faster");

  const now = Date.now();
  check("a fresh prompt finds its thread, preferring the node's cwd", c.findCodexThreadForPrompt({ prompt: "now make it faster please", cwd: "/Users/me", submittedAt: now, codexHome: home }), A);
  check("the other cwd's thread is found from there", c.findCodexThreadForPrompt({ prompt: "now make it faster please", cwd: "/Users/other", submittedAt: now, codexHome: home }), C);
  check("a thread claimed by another node is skipped", c.findCodexThreadForPrompt({ prompt: "now make it faster please", cwd: "/Users/me", submittedAt: now, codexHome: home, exclude: new Set([A]) }), C);
  check("a short prompt identifies nothing", c.findCodexThreadForPrompt({ prompt: "ok", cwd: "/Users/me", submittedAt: now, codexHome: home }), null);
  check("an old message deep in a thread is not a fresh submission", c.findCodexThreadForPrompt({ prompt: "Feed in an anime + the manga", cwd: "/Users/me", submittedAt: now, codexHome: home }), null);
  {
    // A thread started days ago keeps its rollout in that day's directory.
    const oldDay = join(home, "sessions", "2025", "01", "02");
    mkdirSync(oldDay, { recursive: true });
    const D = "01a1dddd-0000-7000-8000-000000000004";
    writeFileSync(join(oldDay, `rollout-2025-01-02T10-00-00-${D}.jsonl`), [meta(D, "/Users/me"), user("an old thread resumed today")].join("\n") + "\n");
    check("a prompt in a thread started long ago is found", c.findCodexThreadForPrompt({ prompt: "an old thread resumed today", cwd: "/Users/me", submittedAt: Date.now(), codexHome: home }), D);
    rmSync(oldDay, { recursive: true, force: true });
  }
  check("a rollout untouched since the prompt is not it", c.findCodexThreadForPrompt({ prompt: "now make it faster please", cwd: "/Users/me", submittedAt: now + 60_000, codexHome: home }), null);

  const infer = (prompts, extra = {}) => c.inferConversationId({ kind: "codex", cwd: "/Users/me", prompts, createdAt: now - 3_600_000, codexHome: home, ...extra });
  check("backfill: two remembered prompts pick their thread", await infer(["how is this legal?", "just trying to understand how they can charge a card"]), B);
  check("backfill: one remembered prompt is enough when it is all there is", await infer(["Feed in an anime + the manga and output the clips"]), A);
  check("backfill: the latest prompt must be in the thread", await infer(["how is this legal?", "something never sent anywhere"]), null);
  check("backfill: nothing written after the node was created", await infer(["how is this legal?", "just trying to understand how they can charge a card"], { createdAt: now + 60_000 }), null);
  check("backfill: a thread in another cwd is not a candidate", await infer(["now make it faster please"]), A);
  check("backfill: only short prompts identify nothing", await infer(["ok", "yes"]), null);
  check("backfill: a trailing slash command is ignored", await infer(["how is this legal?", "just trying to understand how they can charge a card", "/resume"]), B);
  check("exit hint without the background server", c.parseCodexExitHint(c.normalizePrompt(`To continue this session, run:\r\n  \x1b[36mcodex resume ${A}\x1b[39m`)), A);
  check("exit hint with the background server", c.parseCodexExitHint(c.normalizePrompt(`Disconnected from this task. Any running work continues.\r\nTo reconnect, run:\r\n  \x1b[36mcodex resume ${A}\x1b[39m\r\n`)), A);
  check("someone typing the command is not an exit", c.parseCodexExitHint(c.normalizePrompt(`$ codex resume ${A}`)), null);
  check("slash commands never identify a thread", c.findCodexThreadForPrompt({ prompt: "/quit", cwd: "/Users/me", submittedAt: now, codexHome: home }), null);

  const claude = mkdtempSync(join(tmpdir(), "claude-cfg-"));
  const proj = join(claude, "projects", c.claudeProjectDirName("/Users/me"));
  mkdirSync(proj, { recursive: true });
  const cu = (text) => JSON.stringify({ type: "user", cwd: "/Users/me", message: { role: "user", content: text } });
  writeFileSync(join(proj, `${ID}.jsonl`), [cu("Lets merge the PR and explain simply"), JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "meta" } }), cu([{ type: "text", text: "any other similar issues?" }])].join("\n"));
  writeFileSync(join(proj, "11111111-2222-3333-4444-555555555555.jsonl"), cu("any other similar issues?") + "\n");
  check("claude project dir name", c.claudeProjectDirName("/Users/me/my.repo"), "-Users-me-my-repo");
  check("backfill: claude transcript with both prompts wins over one with the latest only", await c.inferConversationId({ kind: "claude", cwd: "/Users/me", prompts: ["Lets merge the PR and explain simply", "any other similar issues?"], createdAt: now - 3_600_000, claudeConfigDir: claude }), ID);
  check("backfill: claude tie picks nothing", await c.inferConversationId({ kind: "claude", cwd: "/Users/me", prompts: ["any other similar issues?"], createdAt: now - 3_600_000, claudeConfigDir: claude }), null);
  rmSync(claude, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log("\npersistence");
{
  const data = mkdtempSync(join(tmpdir(), "openui-resume-"));
  process.env.OPENUI_DATA_DIR = data;
  const p = await import(join(dist, "persistence.js"));
  const node = {
    nodeId: "node-1", sessionId: "session-1", agentId: "claude", agentName: "Claude", command: "claude",
    cwd: data, createdAt: new Date().toISOString(), position: { x: 0, y: 0 }, resumeSessionId: ID,
    manuallyEnded: true, pendingDelete: true,
  };
  p.savePersistedState({ nodes: [node, { ...node, nodeId: "node-2", sessionId: "session-2", resumeSessionId: "bad id; rm" }] });
  const loaded = p.loadState().nodes;
  check("resume id survives a save and load", loaded.find((n) => n.sessionId === "session-1")?.resumeSessionId, ID);
  check("an explicit end survives a save and load", loaded.find((n) => n.sessionId === "session-1")?.manuallyEnded, true);
  check("a pending deletion survives a save and load", loaded.find((n) => n.sessionId === "session-1")?.pendingDelete, true);
  check("an unsafe resume id is dropped on load", loaded.find((n) => n.sessionId === "session-2")?.resumeSessionId, undefined);
  rmSync(data, { recursive: true, force: true });
}

console.log("\nstartup setting");
{
  const root = mkdtempSync(join(tmpdir(), "openui-resume-config-"));
  process.env.LAUNCH_CWD = root;
  const config = await import(join(dist, "linear.js"));
  check("recovery is enabled for a new installation", config.loadConfig().resumeSessionsOnLaunch, true);
  mkdirSync(join(root, ".openui-desktop"));
  writeFileSync(join(root, ".openui-desktop", "config.json"), JSON.stringify({ autoCareful: false }));
  check("recovery is enabled for an existing installation", config.loadConfig().resumeSessionsOnLaunch, true);
  config.saveConfig({ resumeSessionsOnLaunch: false });
  check("an explicit opt-out is respected", config.loadConfig().resumeSessionsOnLaunch, false);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
