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
  check("an unsafe id leaves the command alone", r.buildResumeCommand("claude", "claude", "x; y"), null);
  check("quoted text that mentions a flag is left intact", r.buildResumeCommand('claude --append-system-prompt "Never use --continue here"', "claude", ID), `claude --append-system-prompt "Never use --continue here" --resume ${ID}`);
  check("a quoted multi-word --resume value is removed whole", r.buildResumeCommand('claude --resume "old id" --model opus', "claude", ID), `claude --model opus --resume ${ID}`);
  check("bare -r before another flag keeps that flag", r.buildResumeCommand("claude -r --model opus", "claude", ID), `claude --model opus --resume ${ID}`);
  check("bare --resume at the end", r.buildResumeCommand("claude --resume", "claude", ID), `claude --resume ${ID}`);
  check("single quotes survive", r.buildResumeCommand("claude --append-system-prompt 'a b'", "claude", ID), `claude --append-system-prompt 'a b' --resume ${ID}`);
  check("an absolute path to claude is recognised", r.buildResumeCommand("/usr/local/bin/claude --model opus", "claude", ID), `/usr/local/bin/claude --model opus --resume ${ID}`);
  check("a profile that runs claude resumes", r.buildResumeCommand("claude --model opus", "profile:reviewer", ID), `claude --model opus --resume ${ID}`);
  check("a profile that runs codex does not", r.buildResumeCommand("codex", "profile:reviewer", ID), null);
  check("isClaudeCommand: profile running claude", r.isClaudeCommand("claude --verbose", "profile:x"), true);
  check("isClaudeCommand: codex agent", r.isClaudeCommand("codex", "codex"), false);
  check("isClaudeCommand: ssh wrapper", r.isClaudeCommand("ssh box -t 'exec claude'", "claude"), false);
  check("codex is not resumed by id", r.buildResumeCommand("codex", "codex", ID), null);
  check("a devbox ssh command is not touched", r.buildResumeCommand("ssh box -t 'cd /x && exec claude'", "claude", ID), null);
  check("a shell node is not touched", r.buildResumeCommand("", "shell", ID), null);

  const config = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(config, "projects", "-Users-x-repo"), { recursive: true });
  writeFileSync(join(config, "projects", "-Users-x-repo", `${ID}.jsonl`), "{}\n");
  check("transcript found in any project dir", r.claudeTranscriptExists(ID, config), true);
  check("missing transcript", r.claudeTranscriptExists("00000000-0000-0000-0000-000000000000", config), false);
  check("missing config dir", r.claudeTranscriptExists(ID, join(config, "nope")), false);

  const plan = (s, opts) => r.planRelaunch(s, { claudeConfigDir: config, ...opts });
  check("resume with a saved transcript", plan({ agentId: "claude", command: "claude", resumeSessionId: ID }, { resume: true }), { command: `claude --resume ${ID}`, resumed: true });
  check("resume without a transcript falls back to a fresh launch", plan({ agentId: "claude", command: "claude", resumeSessionId: "00000000-0000-0000-0000-000000000000" }, { resume: true }), { command: "claude", resumed: false });
  check("resume without a saved id is a fresh launch", plan({ agentId: "claude", command: "claude" }, { resume: true }), { command: "claude", resumed: false });
  check("a plain restart never resumes", plan({ agentId: "claude", command: "claude", resumeSessionId: ID }, { resume: false }), { command: "claude", resumed: false });
  check("codex relaunches fresh", plan({ agentId: "codex", command: "codex", resumeSessionId: ID }, { resume: true }), { command: "codex", resumed: false });
  check("claude config dir defaults from CLAUDE_CONFIG_DIR", r.defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/cc", HOME: "/home/u" }), "/tmp/cc");
  check("claude config dir defaults to ~/.claude", r.defaultClaudeConfigDir({ HOME: "/home/u" }), "/home/u/.claude");
  const { homedir } = await import("os");
  check("claude config dir falls back to the OS home when HOME is unset", r.defaultClaudeConfigDir({}), join(homedir(), ".claude"));
  rmSync(config, { recursive: true, force: true });
}

console.log("\npersistence");
{
  const data = mkdtempSync(join(tmpdir(), "openui-resume-"));
  process.env.OPENUI_DATA_DIR = data;
  const p = await import(join(dist, "persistence.js"));
  const node = {
    nodeId: "node-1", sessionId: "session-1", agentId: "claude", agentName: "Claude", command: "claude",
    cwd: data, createdAt: new Date().toISOString(), position: { x: 0, y: 0 }, resumeSessionId: ID,
  };
  p.savePersistedState({ nodes: [node, { ...node, nodeId: "node-2", sessionId: "session-2", resumeSessionId: "bad id; rm" }] });
  const loaded = p.loadState().nodes;
  check("resume id survives a save and load", loaded.find((n) => n.sessionId === "session-1")?.resumeSessionId, ID);
  check("an unsafe resume id is dropped on load", loaded.find((n) => n.sessionId === "session-2")?.resumeSessionId, undefined);
  rmSync(data, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
