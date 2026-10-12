#!/usr/bin/env node
// Behaviour tests for the Claude-backed workspace coordinator agent:
// config resolution, tool runner, and the turn loop (fake client, real tools).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron");

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

// ---------------------------------------------------------------- config
console.log("coordinatorAgentConfig");
{
  const cfg = await import(join(dist, "server", "services", "coordinatorAgentConfig.js"));
  const dir = mkdtempSync(join(tmpdir(), "coord-cfg-"));
  check("empty dir loads empty config", cfg.loadCoordinatorAgentConfig(dir), {});
  cfg.saveCoordinatorAgentConfig({ apiKey: "sk-ant-1", model: "claude-opus-5" }, dir);
  check("save then load round-trips", cfg.loadCoordinatorAgentConfig(dir), { apiKey: "sk-ant-1", model: "claude-opus-5" });
  check("settings key beats env", cfg.resolveCoordinatorCredentials({ apiKey: "sk-ant-1" }, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-ant-1", source: "settings" });
  check("env key used when settings empty", cfg.resolveCoordinatorCredentials({}, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-env", source: "env" });
  check("no key anywhere", cfg.resolveCoordinatorCredentials({}, {}), { apiKey: undefined, source: null });
  cfg.saveCoordinatorAgentConfig({ apiKey: "" }, dir);
  check("empty key is dropped on save", cfg.loadCoordinatorAgentConfig(dir), {});
  check("default model constant", cfg.DEFAULT_COORDINATOR_MODEL, "claude-opus-5");
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- tools
console.log("\ncoordinatorTools");
{
  const { createCoordinatorTools, INTERACTION_TOOL_NAMES } = await import(join(dist, "electron", "coordinatorTools.js"));
  const dir = mkdtempSync(join(tmpdir(), "coord-tools-"));
  mkdirSync(join(dir, ".openui-desktop", "buffers"), { recursive: true });
  writeFileSync(join(dir, ".openui-desktop", "buffers", "s1.txt"), "hello");

  const calls = [];
  const routes = {
    "GET /api/sessions": { status: 200, body: [{ id: "s1" }] },
    "GET /api/sessions/s1/status": { status: 200, body: { status: "idle" } },
    "GET /api/sessions/s1/blocks?limit=12": { status: 200, body: { blocks: [] } },
    "GET /api/coordinator/snapshot": { status: 200, body: { mode: "observe" } },
    "POST /api/coordinator/decisions": { status: 201, body: { id: "dec-1" } },
    "POST /api/coordinator/directives": { status: 201, body: { id: "dir-1", state: "queued" } },
    "POST /api/coordinator/directives/d-missing/acknowledge": { status: 404, body: { error: "directive not found" } },
  };
  const fakeFetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ url, method, body: init.body });
    const route = routes[`${method} ${path}`] || { status: 404, body: { error: `no route ${method} ${path}` } };
    return { ok: route.status < 400, status: route.status, json: async () => route.body };
  };
  const tools = createCoordinatorTools({ serverPort: 7000, launchCwd: dir, fetch: fakeFetch });
  const last = () => calls[calls.length - 1];

  check("ten tool definitions in a stable order", tools.definitions.map((t) => t.name), [
    "list_active_sessions", "get_session_status", "read_session_output", "get_session_activity",
    "get_coordination_state", "record_decision", "send_directive", "acknowledge_directive",
    "ask_user", "request_confirmation",
  ]);
  check("definitions stream input eagerly", tools.definitions.every((t) => t.eager_input_streaming === true), true);
  check("every definition is an object schema with required list", tools.definitions.every((t) => t.input_schema.type === "object" && Array.isArray(t.input_schema.required)), true);
  check("interaction tool names", INTERACTION_TOOL_NAMES, ["ask_user", "request_confirmation"]);

  check("list_active_sessions hits /api/sessions", await tools.run("list_active_sessions", {}), { content: JSON.stringify([{ id: "s1" }], null, 2), isError: false });
  check("list_active_sessions URL uses the server port", last().url, "http://localhost:7000/api/sessions");
  check("get_session_status", await tools.run("get_session_status", { sessionId: "s1" }), { content: JSON.stringify({ status: "idle" }, null, 2), isError: false });
  check("get_session_activity", (await tools.run("get_session_activity", { sessionId: "s1" })).isError, false);
  check("get_coordination_state", (await tools.run("get_coordination_state", {})).isError, false);

  await tools.run("send_directive", { sessionId: "s1", text: "do x" });
  check("send_directive posts author coordinator", JSON.parse(last().body), { sessionId: "s1", text: "do x", author: "coordinator" });
  await tools.run("record_decision", { topic: "t", choice: "c", rationale: "r", sessionIds: "s1, s2" });
  check("record_decision splits sessionIds", JSON.parse(last().body).scope, { kind: "sessions", sessionIds: ["s1", "s2"] });
  await tools.run("record_decision", { topic: "t", choice: "c", rationale: "r" });
  check("record_decision defaults to workspace scope", JSON.parse(last().body).scope, { kind: "workspace" });
  check("acknowledge_directive encodes the id", (await tools.run("acknowledge_directive", { directiveId: "d-missing" })), { content: "Directive was not acknowledged: directive not found", isError: true });

  check("missing required field is an error result", await tools.run("get_session_status", {}), { content: "Invalid input for get_session_status: missing required field sessionId", isError: true });
  check("non-string field is an error result", await tools.run("get_session_status", { sessionId: 5 }), { content: "Invalid input for get_session_status: field sessionId must be a string", isError: true });
  check("unknown tool", await tools.run("nope", {}), { content: "Unknown tool: nope", isError: true });
  check("read_session_output tails the buffer", await tools.run("read_session_output", { sessionId: "s1" }), { content: "hello", isError: false });
  check("read_session_output with no buffer", await tools.run("read_session_output", { sessionId: "missing" }), { content: "(no output buffer found for this session)", isError: false });
  check("interaction tools are not run here", (await tools.run("ask_user", { question: "?" })).isError, true);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
