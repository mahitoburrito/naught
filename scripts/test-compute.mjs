#!/usr/bin/env node
// Behaviour tests for the compute-node feature: secrets, policy, keys, mail,
// providers, the orchestrator and its routes. Imports the compiled server
// (`npm run build:electron` first); never touches the network.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
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

async function withLaunchCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), "naught-compute-"));
  const previous = process.env.LAUNCH_CWD;
  process.env.LAUNCH_CWD = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.LAUNCH_CWD;
    else process.env.LAUNCH_CWD = previous;
  }
}

// ─── secrets ────────────────────────────────────────────────────────────────

section("secrets");
{
  const secrets = await import(join(dist, "services", "secrets.js"));
  await withLaunchCwd(async (dir) => {
    check("missing env file reads as empty", secrets.readEnvFile().TNR_API_TOKEN, undefined);
    secrets.updateEnvValue("TNR_API_TOKEN", "abc");
    check("a written key reads back", secrets.readEnvFile().TNR_API_TOKEN, "abc");
    secrets.updateEnvValue("TNR_API_TOKEN", "def");
    const text = readFileSync(join(dir, ".openui-desktop", ".env"), "utf-8");
    check("rewriting replaces the line", text.split("\n").filter((l) => l.startsWith("TNR_API_TOKEN=")).length, 1);
    check("the file is owner-only", (statSync(join(dir, ".openui-desktop", ".env")).mode & 0o077), 0);
    secrets.updateEnvValue("RESEND_API_KEY", 're_x"y');
    check("quotes in values survive", secrets.readEnvFile().RESEND_API_KEY, 're_x"y');
    secrets.updateEnvValue("TNR_API_TOKEN", "");
    check("an empty value removes the key", secrets.readEnvFile().TNR_API_TOKEN, undefined);
    check("other keys stay", secrets.readEnvFile().RESEND_API_KEY, 're_x"y');
    let threw = false;
    try { secrets.updateEnvValue("bad key", "x"); } catch { threw = true; }
    check("an unsafe key name is refused", threw, true);
  });

  check(
    "resolveSecret prefers the value set in Naught",
    secrets.resolveSecret("K", { file: { K: "file" }, env: { K: "env" }, detector: () => "det" }),
    { value: "file", source: "naught" },
  );
  check(
    "then the process environment",
    secrets.resolveSecret("K", { file: {}, env: { K: "env" }, detector: () => "det" }),
    { value: "env", source: "env" },
  );
  check(
    "then a detector",
    secrets.resolveSecret("K", { file: {}, env: {}, detector: () => "det" }),
    { value: "det", source: "detected" },
  );
  check("nothing found is undefined", secrets.resolveSecret("K", { file: {}, env: {} }), undefined);
  check("blank values do not count", secrets.resolveSecret("K", { file: { K: "  " }, env: { K: "" } }), undefined);

  check(
    "parseModalToml picks the active profile",
    secrets.parseModalToml('[a]\ntoken_id = "ak-1"\ntoken_secret = "as-1"\n\n[b]\ntoken_id = "ak-2"\ntoken_secret = "as-2"\nactive = true\n'),
    { tokenId: "ak-2", tokenSecret: "as-2", profile: "b" },
  );
  check(
    "parseModalToml falls back to a lone profile",
    secrets.parseModalToml('[only]\ntoken_id = "ak"\ntoken_secret = "as"\n'),
    { tokenId: "ak", tokenSecret: "as", profile: "only" },
  );
  check("parseModalToml with two inactive profiles is undefined", secrets.parseModalToml('[a]\ntoken_id="1"\ntoken_secret="2"\n[b]\ntoken_id="3"\ntoken_secret="4"\n'), undefined);
  check("parseModalToml without a secret is undefined", secrets.parseModalToml('[a]\ntoken_id="1"\nactive=true\n'), undefined);
}


// ─── persisted move / devbox fields ─────────────────────────────────────────

section("persistence");
{
  const persistence = await import(join(dist, "services", "persistence.js"));
  const move = {
    direction: "out",
    state: "sync-files",
    nodeId: "node-1",
    startedAt: 1000,
    updatedAt: 1200,
    harness: { kind: "claude", sessionId: "c1", transcriptPath: "/h/.claude/projects/-w/c1.jsonl" },
    roots: ["/w"],
    manifest: { hash: "abc", files: 3, bytes: 10, roots: ["/w"] },
    includeIgnored: false,
    history: [{ direction: "out", nodeId: "node-1", at: 999, manifestHash: "abc" }],
  };
  check("a valid move state round-trips", persistence.validateMoveState(move), move);
  check("an unknown move step is dropped", persistence.validateMoveState({ ...move, state: "flying" }), undefined);
  check("a move without a node id is dropped", persistence.validateMoveState({ ...move, nodeId: "" }), undefined);
  check(
    "a malformed harness degrades to shell",
    persistence.validateMoveState({ ...move, harness: { kind: "codex" } }).harness,
    { kind: "shell" },
  );

  await withLaunchCwd(async () => {
    const sessions = new Map();
    sessions.set("s-1", {
      pty: null, agentId: "claude", agentName: "Claude Code", command: "claude", cwd: "/w",
      devboxId: "box-1", remotePath: "/w", move,
      createdAt: new Date(0).toISOString(), clients: new Set(), outputBuffer: [], outputBufferChars: 0,
      terminalCols: 80, terminalRows: 24, terminalFrameRedrawsInPlace: true, status: "idle",
      lastOutputTime: 0, lastInputTime: 0, recentOutputSize: 0, nodeId: "node-s-1", terminalBlocks: [],
      position: { x: 1, y: 2 },
    });
    persistence.saveState(sessions);
    const loaded = persistence.loadState();
    const node = loaded.nodes.find((n) => n.sessionId === "s-1");
    check("devboxId survives a save/load", node?.devboxId, "box-1");
    check("remotePath survives a save/load", node?.remotePath, "/w");
    check("move state survives a save/load", node?.move?.state, "sync-files");
  });
}

// ─── policy ─────────────────────────────────────────────────────────────────

section("policy");
{
  const { DEFAULT_COMPUTE_CONFIG, evaluatePolicy, normaliseComputeConfig } = await import(join(dist, "services", "compute", "policy.js"));
  check("policy defaults", DEFAULT_COMPUTE_CONFIG.policy, { maxConcurrentNodes: 2, allowedGpus: "any", maxLifetimeHours: 8, maxHourlyUsd: 5 });
  const policy = DEFAULT_COMPUTE_CONFIG.policy;
  const spec = { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, name: "n", maxLifetimeHours: 8, hourlyUsd: 3.95 };
  check("inside every cap is allowed", evaluatePolicy(policy, spec, { liveNodes: 0 }), { allowed: true, reasons: [] });
  check("too many live nodes", evaluatePolicy(policy, spec, { liveNodes: 2 }), { allowed: false, reasons: ["Already 2 of 2 nodes live"] });
  check(
    "gpu outside the allowed list",
    evaluatePolicy({ ...policy, allowedGpus: ["A10G", "T4"] }, spec, { liveNodes: 0 }).reasons,
    ["GPU H100 is not in the allowed list (A10G, T4)"],
  );
  check("gpu list match is case-insensitive", evaluatePolicy({ ...policy, allowedGpus: ["h100"] }, spec, { liveNodes: 0 }).allowed, true);
  check("cpu-only ignores the gpu list", evaluatePolicy({ ...policy, allowedGpus: [] }, { ...spec, gpu: undefined }, { liveNodes: 0 }).allowed, true);
  check("hourly cap", evaluatePolicy(policy, { ...spec, hourlyUsd: 7.9 }, { liveNodes: 0 }).reasons, ["Estimated $7.90/hr exceeds the $5.00/hr cap"]);
  check("lifetime cap", evaluatePolicy(policy, { ...spec, maxLifetimeHours: 10 }, { liveNodes: 0 }).reasons, ["Lifetime 10h exceeds the 8h cap"]);
  check(
    "every failing cap is listed",
    evaluatePolicy({ ...policy, allowedGpus: ["T4"] }, { ...spec, hourlyUsd: 9, maxLifetimeHours: 24 }, { liveNodes: 5 }).reasons.length,
    4,
  );
  const normalised = normaliseComputeConfig({ policy: { maxConcurrentNodes: "3", allowedGpus: ["H100", " H100 ", ""], maxHourlyUsd: -1 }, notifications: { to: " me@x.io ", reminderHours: 0 } });
  check("normalise clamps and dedupes", normalised.policy, { maxConcurrentNodes: 3, allowedGpus: ["H100"], maxLifetimeHours: 8, maxHourlyUsd: 0 });
  check("normalise trims the recipient and clamps the cadence", [normalised.notifications.to, normalised.notifications.reminderHours], ["me@x.io", 0.25]);
  check("normalise of garbage is the defaults", normaliseComputeConfig(null), DEFAULT_COMPUTE_CONFIG);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
