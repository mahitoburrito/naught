#!/usr/bin/env node
// Behaviour tests for the Claude-backed workspace coordinator agent:
// config resolution, tool runner, and the turn loop (fake client, real tools).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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
  check("config lives directly in the data dir", cfg.coordinatorAgentConfigPath(dir), join(dir, "coordinator-agent.json"));
  check("key file is owner-only", (statSync(cfg.coordinatorAgentConfigPath(dir)).mode & 0o777).toString(8), "600");
  check("save leaves no temp files behind", readdirSync(dir), ["coordinator-agent.json"]);
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
  // The app persists scrollback as JSON envelopes (and migrates legacy .txt files);
  // the tool must read them through the same loader the app uses.
  process.env.LAUNCH_CWD = dir;
  delete process.env.OPENUI_DATA_DIR;
  writeFileSync(join(dir, ".openui-desktop", "buffers", "s1.json"), JSON.stringify({ version: 2, savedAt: Date.now(), truncated: false, data: "hello" }));
  writeFileSync(join(dir, ".openui-desktop", "buffers", "legacy.txt"), "old scrollback");
  writeFileSync(join(dir, ".openui-desktop", "buffers", "big.json"), JSON.stringify({ version: 2, savedAt: Date.now(), truncated: false, data: "x".repeat(20_000) + "END" }));

  const calls = [];
  const routes = {
    "GET /api/sessions": { status: 200, body: [{ sessionId: "s1", agentId: "claude" }, { sessionId: "sh", agentId: "shell" }] },
    "GET /api/sessions/s1/status": { status: 200, body: { status: "idle" } },
    "GET /api/sessions/s1/blocks?limit=12": { status: 200, body: { blocks: [] } },
    "GET /api/coordinator/snapshot": { status: 200, body: { mode: "observe" } },
    "POST /api/coordinator/decisions": { status: 201, body: { id: "dec-1" } },
    "POST /api/coordinator/directives": { status: 201, body: { id: "dir-1", state: "queued" } },
    "POST /api/coordinator/directives/d-missing/acknowledge": { status: 404, body: { error: "directive not found" } },
    "GET /api/sessions/huge/status": { status: 200, body: { log: "y".repeat(50_000) } },
  };
  const fakeFetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ url, method, body: init.body });
    const route = routes[`${method} ${path}`] || { status: 404, body: { error: `no route ${method} ${path}` } };
    return { ok: route.status < 400, status: route.status, json: async () => route.body };
  };
  const tools = createCoordinatorTools({ serverPort: 7000, fetch: fakeFetch });
  const last = () => calls[calls.length - 1];

  check("ten tool definitions in a stable order", tools.definitions.map((t) => t.name), [
    "list_active_sessions", "get_session_status", "read_session_output", "get_session_activity",
    "get_coordination_state", "record_decision", "send_directive", "acknowledge_directive",
    "ask_user", "request_confirmation",
  ]);
  check("definitions leave input buffering to the API", tools.definitions.every((t) => t.eager_input_streaming === undefined), true);
  check("every definition is an object schema with required list", tools.definitions.every((t) => t.input_schema.type === "object" && Array.isArray(t.input_schema.required)), true);
  check("interaction tool names", INTERACTION_TOOL_NAMES, ["ask_user", "request_confirmation"]);

  check("list_active_sessions hits /api/sessions", await tools.run("list_active_sessions", {}), { content: JSON.stringify([{ sessionId: "s1", agentId: "claude" }, { sessionId: "sh", agentId: "shell" }], null, 2), isError: false });
  check("list_active_sessions URL uses the server port", last().url, "http://localhost:7000/api/sessions");
  check("get_session_status", await tools.run("get_session_status", { sessionId: "s1" }), { content: JSON.stringify({ status: "idle" }, null, 2), isError: false });
  check("get_session_activity", (await tools.run("get_session_activity", { sessionId: "s1" })).isError, false);
  check("get_coordination_state", (await tools.run("get_coordination_state", {})).isError, false);

  await tools.run("send_directive", { sessionId: "s1", text: "do x" });
  check("send_directive posts author coordinator", JSON.parse(last().body), { sessionId: "s1", text: "do x", author: "coordinator" });
  const postsBefore = calls.filter((c) => c.method === "POST").length;
  check("send_directive refuses a plain shell target", await tools.run("send_directive", { sessionId: "sh", text: "rm -rf /" }), { content: "Directive was not queued: session sh is a plain shell, not a coding agent", isError: true });
  check("no POST was made for the shell target", calls.filter((c) => c.method === "POST").length, postsBefore);
  await tools.run("record_decision", { topic: "t", choice: "c", rationale: "r", sessionIds: "s1, s2" });
  check("record_decision splits sessionIds", JSON.parse(last().body).scope, { kind: "sessions", sessionIds: ["s1", "s2"] });
  await tools.run("record_decision", { topic: "t", choice: "c", rationale: "r" });
  check("record_decision defaults to workspace scope", JSON.parse(last().body).scope, { kind: "workspace" });
  check("acknowledge_directive encodes the id", (await tools.run("acknowledge_directive", { directiveId: "d-missing" })), { content: "Directive was not acknowledged: directive not found", isError: true });

  check("missing required field is an error result", await tools.run("get_session_status", {}), { content: "Invalid input for get_session_status: missing required field sessionId", isError: true });
  check("non-string field is an error result", await tools.run("get_session_status", { sessionId: 5 }), { content: "Invalid input for get_session_status: field sessionId must be a string", isError: true });
  check("unknown tool", await tools.run("nope", {}), { content: "Unknown tool: nope", isError: true });
  check("read_session_output reads the app's JSON scrollback", await tools.run("read_session_output", { sessionId: "s1" }), { content: "hello", isError: false });
  check("read_session_output reads a legacy .txt scrollback", await tools.run("read_session_output", { sessionId: "legacy" }), { content: "old scrollback", isError: false });
  const big = await tools.run("read_session_output", { sessionId: "big" });
  check("read_session_output keeps only the tail of a large scrollback", [big.content.startsWith("[truncated to last 5000 chars]"), big.content.endsWith("END"), big.content.length < 5100], [true, true, true]);
  const huge = await tools.run("get_session_status", { sessionId: "huge" });
  check("HTTP tool results are capped before reaching the model", [huge.isError, huge.content.length <= 20_100, /\[truncated: \d+ more characters\]$/.test(huge.content)], [false, true, true]);
  check("read_session_output with no buffer", await tools.run("read_session_output", { sessionId: "missing" }), { content: "(no output buffer found for this session)", isError: false });
  check("read_session_output rejects path-like ids", await tools.run("read_session_output", { sessionId: "../x" }), { content: "Invalid input for read_session_output: sessionId must be a plain session ID", isError: true });
  check("interaction tools are not run here", (await tools.run("ask_user", { question: "?" })).isError, true);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- agent
console.log("\ncoordinatorAgent");
{
  // The compiled agent is CommonJS, so load the same CJS build of the SDK
  // (the ESM build would be a second copy and instanceof would never match).
  const Anthropic = createRequire(import.meta.url)("@anthropic-ai/sdk");
  const { CoordinatorAgent } = await import(join(dist, "electron", "coordinatorAgent.js"));
  const { createCoordinatorTools } = await import(join(dist, "electron", "coordinatorTools.js"));
  const dir = mkdtempSync(join(tmpdir(), "coord-agent-"));
  const routes = {
    "GET /api/sessions": { status: 200, body: [{ id: "s1" }, { id: "s2" }] },
    "GET /api/sessions/s1/status": { status: 200, body: { status: "idle" } },
    "GET /api/sessions/s2/status": { status: 200, body: { status: "working" } },
    "GET /api/coordinator/snapshot": { status: 200, body: { mode: "observe" } },
  };
  const fakeFetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes[`${method} ${path}`] || { status: 404, body: { error: `no route ${method} ${path}` } };
    return { ok: route.status < 400, status: route.status, json: async () => route.body };
  };
  const tools = createCoordinatorTools({ serverPort: 7000, fetch: fakeFetch });

  // script entries: a Message, an Error to throw, or a function ({ params, opts }) => Promise<Message>
  function fakeClient(script) {
    const calls = [];
    return {
      calls,
      beta: { messages: { stream(params, opts) {
        const next = script.shift();
        calls.push({ params, opts });
        return {
          on() { return this; },
          abort() {},
          async finalMessage() {
            if (typeof next === "function") return next({ params, opts });
            if (next instanceof Error) throw next;
            if (!next) throw new Error("fake client: script exhausted");
            return next;
          },
        };
      } } },
    };
  }
  const msg = (content, stop_reason) => ({ id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const thinking = (t) => ({ type: "thinking", thinking: t, signature: "sig" });
  const text = (t) => ({ type: "text", text: t });
  const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function waitFor(cond, label) {
    for (let i = 0; i < 200; i++) { if (cond()) return; await tick(); }
    throw new Error(`timed out waiting for ${label}`);
  }
  function makeAgent(client, extra = {}) {
    const interactions = [];
    const agent = new CoordinatorAgent({ client, tools, onInteraction: (p) => interactions.push(p), ...extra });
    return { agent, interactions };
  }

  // 1. tool round trip
  {
    const client = fakeClient([
      msg([thinking("Need the session list"), toolUse("t1", "list_active_sessions", {})], "tool_use"),
      msg([text("Two sessions idle.")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    await agent.startTurn("What is everyone doing?");
    const state = agent.getState();
    check("report is the final text", state.report, "Two sessions idle.");
    check("final text is not also left as the agent message", state.agentMessage, undefined);
    check("turn finished without error", [state.isRunning, state.error], [false, undefined]);
    check("feed shows thinking then the tool, both completed", state.events.map((e) => [e.label, e.isCompleted]), [["Thinking", true], ["list_active_sessions", true]]);
    check("thinking event carries the summary", state.events[0].detail, "Need the session list");
    check("tool event detail carries the result", state.events[1].detail.includes('"id": "s1"'), true);
    check("one completed turn recorded", state.completedTurns.map((t) => [t.directive, t.report]), [["What is everyone doing?", "Two sessions idle."]]);
    const first = client.calls[0].params;
    check("model", first.model, "claude-opus-5");
    check("fallbacks default + beta header", [first.fallbacks, first.betas], ["default", ["server-side-fallback-2026-07-01"]]);
    check("thinking summarized", first.thinking, { type: "adaptive", display: "summarized" });
    check("system prompt is cached", first.system[0].cache_control, { type: "ephemeral" });
    check("ten tools sent", first.tools.length, 10);
    check("first request carries the directive with a cache breakpoint", first.messages, [{ role: "user", content: [{ type: "text", text: "What is everyone doing?", cache_control: { type: "ephemeral" } }] }]);
    check("abort signal passed to the stream", client.calls[0].opts.signal instanceof AbortSignal, true);
    const second = client.calls[1].params.messages;
    check("second request appends assistant then tool result", [second[1].role, second[2].role, second[2].content.map((b) => [b.type, b.tool_use_id, b.is_error === true])], ["assistant", "user", [["tool_result", "t1", false]]]);
    check("cache breakpoint moves to the latest user message", [second[0].content[0].cache_control, second[2].content.at(-1).cache_control], [undefined, { type: "ephemeral" }]);
    check("completed turn keeps only summary fields", Object.keys(state.completedTurns[0]).sort(), ["completedAt", "directive", "id", "report"]);
    check("conversation history has the directive and the reply", state.conversationHistory, [{ role: "user", content: "What is everyone doing?" }, { role: "assistant", content: "Two sessions idle." }]);
  }

  // 2. parallel tool calls answered in one user message
  {
    const client = fakeClient([
      msg([toolUse("a", "get_session_status", { sessionId: "s1" }), toolUse("b", "get_session_status", { sessionId: "s2" })], "tool_use"),
      msg([text("done")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    await agent.startTurn("status of both");
    const results = client.calls[1].params.messages[2];
    check("both results in one user message, in call order", [results.role, results.content.map((b) => b.tool_use_id)], ["user", ["a", "b"]]);
  }

  // 3. invalid input becomes an error result and the loop continues
  {
    const client = fakeClient([
      msg([toolUse("x", "get_session_status", {})], "tool_use"),
      msg([text("ok")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    await agent.startTurn("check");
    const result = client.calls[1].params.messages[2].content[0];
    check("invalid input -> is_error tool result", [result.is_error, result.content], [true, "Invalid input for get_session_status: missing required field sessionId"]);
    check("loop continued to the final message", agent.getState().report, "ok");
  }

  // 4. ask_user round trip
  {
    const client = fakeClient([
      msg([toolUse("q1", "ask_user", { question: "Which session?" })], "tool_use"),
      msg([text("ok")], "end_turn"),
    ]);
    const { agent, interactions } = makeAgent(client);
    const run = agent.startTurn("pick one");
    await waitFor(() => interactions.length === 1, "interaction request");
    check("interaction payload", [interactions[0].type, interactions[0].question, typeof interactions[0].interactionId], ["ask_question", "Which session?", "string"]);
    check("state shows the pending interaction", agent.getState().pendingInteraction?.question, "Which session?");
    check("respond returns true", agent.respondToInteraction(interactions[0].interactionId, { type: "ask_question", answer: "B" }), true);
    await run;
    check("answer reaches the model as the tool result", client.calls[1].params.messages[2].content[0].content, "User answered: B");
    const state = agent.getState();
    check("interaction resolved and cleared", [state.resolvedInteractions.length, state.pendingInteraction], [1, undefined]);
    check("ask_user shows as a completed event", state.events.map((e) => [e.label, e.isCompleted]), [["ask_user", true]]);
    check("unknown interaction id is rejected", agent.respondToInteraction("nope", { type: "ask_question", answer: "x" }), false);
  }

  // 5. request_confirmation
  for (const [approved, expected] of [[false, "User denied: send directive to s1"], [true, "User approved: send directive to s1"]]) {
    const client = fakeClient([
      msg([toolUse("c1", "request_confirmation", { action: "send directive to s1", detail: "run the tests" })], "tool_use"),
      msg([text("ok")], "end_turn"),
    ]);
    const { agent, interactions } = makeAgent(client);
    const run = agent.startTurn("go");
    await waitFor(() => interactions.length === 1, "confirmation request");
    check(`confirmation payload (${approved})`, [interactions[0].type, interactions[0].action, interactions[0].detail], ["request_confirmation", "send directive to s1", "run the tests"]);
    agent.respondToInteraction(interactions[0].interactionId, { type: "request_confirmation", approved });
    await run;
    check(`confirmation result (${approved})`, client.calls[1].params.messages[2].content[0].content, expected);
  }

  // 6. follow-up message injected before the next request
  {
    const ref = {};
    const client = fakeClient([
      async () => { ref.agent.sendMessage("also check s2"); return msg([toolUse("t", "get_coordination_state", {})], "tool_use"); },
      msg([text("fin")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    ref.agent = agent;
    await agent.startTurn("look");
    const messages = client.calls[1].params.messages;
    check("follow-up appended after the tool results", [messages.length, messages[3]], [4, { role: "user", content: [{ type: "text", text: "also check s2", cache_control: { type: "ephemeral" } }] }]);
    check("follow-up recorded in history", agent.getState().conversationHistory.filter((e) => e.role === "user").map((e) => e.content), ["look", "also check s2"]);
  }

  // 7. cancel aborts the in-flight request cleanly
  {
    const client = fakeClient([
      ({ opts }) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })))),
    ]);
    const { agent } = makeAgent(client);
    const run = agent.startTurn("x");
    await tick();
    agent.cancel();
    await run;
    const state = agent.getState();
    check("cancel leaves a clean idle state", [state.isRunning, state.error, state.events.at(-1)?.label, state.completedTurns.length], [false, undefined, "Cancelled", 0]);
  }

  // 8. refusal
  {
    const client = fakeClient([msg([], "refusal")]);
    const { agent } = makeAgent(client);
    await agent.startTurn("x");
    check("refusal is reported", [agent.getState().error, client.calls.length], ["Claude declined this directive.", 1]);
  }

  // 9. max_tokens with a tool call
  {
    const client = fakeClient([msg([toolUse("t", "list_active_sessions", {})], "max_tokens")]);
    const { agent } = makeAgent(client);
    await agent.startTurn("x");
    check("token cap is reported and the tool is not run", [agent.getState().error, client.calls.length], ["The coordinator's response was cut off at the token limit.", 1]);
  }

  // 10. step cap
  {
    const endless = () => msg([toolUse("t", "list_active_sessions", {})], "tool_use");
    const client = fakeClient([endless(), endless(), endless()]);
    const { agent } = makeAgent(client, { maxSteps: 2 });
    await agent.startTurn("x");
    check("step cap", [agent.getState().error, client.calls.length], ["Coordinator stopped after 2 steps without finishing.", 2]);
  }

  // 11. auth error
  {
    const authError = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
    const client = fakeClient([authError]);
    const { agent } = makeAgent(client);
    await agent.startTurn("x");
    check("auth error message", agent.getState().error, "The Anthropic API rejected the key. Update it in Settings → Integrations → Coordination.");
  }

  // 12. guards
  {
    const client = fakeClient([
      ({ opts }) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })))),
    ]);
    const { agent } = makeAgent(client);
    check("sendMessage while idle is refused", agent.sendMessage("x"), false);
    const run = agent.startTurn("a");
    await tick();
    let rejected = "";
    try { await agent.startTurn("b"); } catch (e) { rejected = e.message; }
    check("second startTurn while running rejects", rejected, "A coordinator turn is already running");
    agent.cancel();
    await run;
  }

  // 13. cancel during a tool call aborts the fetch; the next turn starts clean
  {
    let abortedFetches = 0;
    const pending = [];
    const hangingFetch = (url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => { abortedFetches++; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      pending.push(() => resolve({ ok: true, status: 200, json: async () => [] }));
    });
    const hangingTools = createCoordinatorTools({ serverPort: 7000, fetch: hangingFetch });
    const client = fakeClient([
      msg([toolUse("t", "list_active_sessions", {})], "tool_use"),
      msg([text("B done")], "end_turn"),
    ]);
    const agent = new CoordinatorAgent({ client, tools: hangingTools });
    const runA = agent.startTurn("A");
    await waitFor(() => pending.length === 1, "tool fetch in flight");
    agent.cancel();
    await tick();
    check("stop aborts the in-flight tool fetch", abortedFetches, 1);
    for (const release of pending) release();
    await runA;
    await agent.startTurn("B");
    check("new turn starts from a clean transcript", client.calls[1].params.messages, [{ role: "user", content: [{ type: "text", text: "B", cache_control: { type: "ephemeral" } }] }]);
    check("only the new turn is recorded", agent.getState().completedTurns.map((t) => t.directive), ["B"]);
  }

  // 14. a stale loop that settles after a restart must not touch the new turn
  {
    const pending = [];
    const stubbornFetch = () => new Promise((resolve) => pending.push(() => resolve({ ok: true, status: 200, json: async () => [] })));
    const stubbornTools = createCoordinatorTools({ serverPort: 7000, fetch: stubbornFetch });
    const client = fakeClient([
      msg([toolUse("t", "list_active_sessions", {})], "tool_use"),
      msg([text("B done")], "end_turn"),
    ]);
    const agent = new CoordinatorAgent({ client, tools: stubbornTools });
    const runA = agent.startTurn("A");
    await waitFor(() => pending.length === 1, "tool fetch pending");
    agent.cancel();
    await agent.startTurn("B");
    check("B finishes while A's fetch is still pending", [agent.getState().report, agent.getState().isRunning], ["B done", false]);
    pending[0]();
    await runA;
    const state = agent.getState();
    check("stale turn A did not disturb B", [state.report, state.error, state.isRunning, state.completedTurns.map((t) => t.directive), client.calls.length], ["B done", undefined, false, ["B"], 2]);
  }

  // 15. a follow-up that lands during the final call still reaches the model
  {
    const ref = {};
    const client = fakeClient([
      async () => { ref.agent.sendMessage("one more thing"); return msg([text("done")], "end_turn"); },
      msg([text("done again")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    ref.agent = agent;
    await agent.startTurn("look");
    check("late follow-up triggers one more step", [client.calls.length, client.calls[1].params.messages.at(-1)], [2, { role: "user", content: [{ type: "text", text: "one more thing", cache_control: { type: "ephemeral" } }] }]);
    check("report comes from the last step", agent.getState().report, "done again");
  }

  // 16. completed turns are capped so the IPC payload stays bounded
  {
    const script = [];
    for (let i = 0; i < 25; i++) script.push(msg([text(`r${i}`)], "end_turn"));
    const { agent } = makeAgent(fakeClient(script));
    for (let i = 0; i < 25; i++) await agent.startTurn(`d${i}`);
    const turns = agent.getState().completedTurns;
    check("completed turns capped at 20, oldest dropped", [turns.length, turns[0].directive, turns.at(-1).directive], [20, "d5", "d24"]);
  }

  // 17. max_tokens without a tool call keeps the partial text as the report
  {
    const { agent } = makeAgent(fakeClient([msg([text("partial…")], "max_tokens")]));
    await agent.startTurn("x");
    check("partial text kept", [agent.getState().report, agent.getState().error], ["partial…", undefined]);
  }

  // 18. context window exceeded is an error, not a report
  {
    const { agent } = makeAgent(fakeClient([msg([text("…")], "model_context_window_exceeded")]));
    await agent.startTurn("x");
    check("context window exceeded", [agent.getState().report, agent.getState().error], ["", "The coordinator ran out of context window."]);
  }

  // 19. a denied confirmation skips the rest of that batch; an approved one lets it run
  for (const [approved, expectSkipped] of [[false, true], [true, false]]) {
    const posted = [];
    const recordingFetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") posted.push(new URL(url).pathname);
      return { ok: true, status: 201, json: async () => ({ id: "dir-1", state: "queued" }) };
    };
    const recordingTools = createCoordinatorTools({ serverPort: 7000, fetch: recordingFetch });
    const client = fakeClient([
      msg([
        toolUse("c1", "request_confirmation", { action: "send directive to s1", detail: "run the tests" }),
        toolUse("d1", "send_directive", { sessionId: "s1", text: "run the tests" }),
      ], "tool_use"),
      msg([text("ok")], "end_turn"),
    ]);
    const interactions = [];
    const agent = new CoordinatorAgent({ client, tools: recordingTools, onInteraction: (p) => interactions.push(p) });
    const run = agent.startTurn("go");
    await waitFor(() => interactions.length === 1, "confirmation request");
    agent.respondToInteraction(interactions[0].interactionId, { type: "request_confirmation", approved });
    await run;
    const results = client.calls[1].params.messages[2].content;
    check(`batch after ${approved ? "approval" : "denial"}: mutation ${expectSkipped ? "skipped" : "ran"}`, [posted, results[1].is_error === true, results[1].content.startsWith("Skipped")], expectSkipped ? [[], true, true] : [["/api/coordinator/directives"], false, false]);
    if (expectSkipped) check("skipped result explains why", results[1].content, "Skipped: the user denied the preceding confirmation, so this call was not made");
  }

  // 20. cancel while a question is pending clears it from the state
  {
    const client = fakeClient([msg([toolUse("q1", "ask_user", { question: "Which?" })], "tool_use")]);
    const { agent, interactions } = makeAgent(client);
    const run = agent.startTurn("pick");
    await waitFor(() => interactions.length === 1, "question pending");
    agent.cancel();
    await run;
    check("cancel clears the pending interaction", [agent.getState().pendingInteraction, agent.getState().isRunning], [undefined, false]);
  }

  // 21. send_directive needs a fresh approval bound to the exact text
  {
    const posted = [];
    const recordingFetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") posted.push(JSON.parse(init.body).text);
      return { ok: true, status: 201, json: async () => ({ id: "dir-1", state: "queued" }) };
    };
    const recordingTools = createCoordinatorTools({ serverPort: 7000, fetch: recordingFetch });
    const client = fakeClient([
      msg([toolUse("d0", "send_directive", { sessionId: "s1", text: "run the tests" })], "tool_use"),
      msg([toolUse("c1", "request_confirmation", { action: "send directive to s1", detail: "run the tests" })], "tool_use"),
      msg([toolUse("d1", "send_directive", { sessionId: "s1", text: "format the disk" })], "tool_use"),
      msg([toolUse("d2", "send_directive", { sessionId: "s1", text: "run the tests" })], "tool_use"),
      msg([toolUse("d3", "send_directive", { sessionId: "s1", text: "run the tests" })], "tool_use"),
      msg([text("done")], "end_turn"),
    ]);
    const interactions = [];
    const agent = new CoordinatorAgent({ client, tools: recordingTools, onInteraction: (p) => interactions.push(p) });
    const run = agent.startTurn("go");
    await waitFor(() => interactions.length === 1, "confirmation request");
    agent.respondToInteraction(interactions[0].interactionId, { type: "request_confirmation", approved: true });
    await run;
    const resultOf = (i) => client.calls[i].params.messages.at(-1).content[0];
    check("unapproved directive is refused", [resultOf(1).is_error, resultOf(1).content], [true, "send_directive requires an approved request_confirmation whose detail is exactly the directive text; ask for confirmation first"]);
    check("approval bound to other text does not cover it", resultOf(3).is_error, true);
    check("matching approval lets it through once", [resultOf(4).is_error === true, resultOf(5).is_error], [false, true]);
    check("only the approved text was posted", posted, ["run the tests"]);
  }

  // 22. record_decision needs an approval bound to the exact choice
  {
    const posted = [];
    const recordingFetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") posted.push(new URL(url).pathname);
      return { ok: true, status: 201, json: async () => ({ id: "dec-1" }) };
    };
    const recordingTools = createCoordinatorTools({ serverPort: 7000, fetch: recordingFetch });
    const client = fakeClient([
      msg([toolUse("r0", "record_decision", { topic: "db", choice: "postgres", rationale: "r" })], "tool_use"),
      msg([toolUse("a0", "acknowledge_directive", { directiveId: "dir-1" })], "tool_use"),
      msg([text("done")], "end_turn"),
    ]);
    const agent = new CoordinatorAgent({ client, tools: recordingTools });
    await agent.startTurn("go");
    check("unapproved decision is refused, acknowledge is not gated", [client.calls[1].params.messages.at(-1).content[0].is_error, client.calls[2].params.messages.at(-1).content[0].is_error === true, posted], [true, false, ["/api/coordinator/directives/dir-1/acknowledge"]]);
  }

  // 23. a turn that ends without any reply is an error, not an empty success
  {
    const { agent } = makeAgent(fakeClient([msg([thinking("hmm")], "end_turn")]));
    await agent.startTurn("x");
    check("empty reply is reported", [agent.getState().error, agent.getState().completedTurns.length], ["The coordinator finished without a reply.", 0]);
  }

  // 24. thinking summaries in the feed are bounded
  {
    const { agent } = makeAgent(fakeClient([msg([thinking("t".repeat(10_000)), text("ok")], "end_turn")]));
    await agent.startTurn("x");
    check("long thinking detail is truncated", agent.getState().events[0].detail.length < 4100, true);
  }

  // 25. a follow-up at the step cap does not throw away the finished report
  {
    const ref = {};
    const client = fakeClient([
      async () => { ref.agent.sendMessage("and also"); return msg([text("done")], "end_turn"); },
    ]);
    const { agent } = makeAgent(client, { maxSteps: 1 });
    ref.agent = agent;
    await agent.startTurn("x");
    check("report kept at the step cap", [agent.getState().report, agent.getState().error, client.calls.length], ["done", undefined, 1]);
  }

  // 26. a reply of the wrong shape is rejected and the question stays pending
  {
    const client = fakeClient([msg([toolUse("q1", "ask_user", { question: "Which?" })], "tool_use"), msg([text("ok")], "end_turn")]);
    const { agent, interactions } = makeAgent(client);
    const run = agent.startTurn("pick");
    await waitFor(() => interactions.length === 1, "question pending");
    const id = interactions[0].interactionId;
    check("wrong interaction type rejected", agent.respondToInteraction(id, { type: "request_confirmation", approved: true }), false);
    check("non-string answer rejected", agent.respondToInteraction(id, { type: "ask_question", answer: 42 }), false);
    check("question still pending", agent.getState().pendingInteraction?.interactionId, id);
    agent.respondToInteraction(id, { type: "ask_question", answer: "B" });
    await run;
    check("well-formed reply accepted", client.calls[1].params.messages[2].content[0].content, "User answered: B");
  }

  // 27. after a mid-output fallback, blocks before the fallback marker are not echoed or run
  {
    const client = fakeClient([
      msg([
        thinking("declined model's reasoning"),
        toolUse("old", "list_active_sessions", {}),
        { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
        text("continuing"),
        toolUse("new", "get_coordination_state", {}),
      ], "tool_use"),
      msg([text("done")], "end_turn"),
    ]);
    const { agent } = makeAgent(client);
    await agent.startTurn("x");
    const echoed = client.calls[1].params.messages[1].content.map((b) => b.type);
    check("pre-fallback thinking and tool_use are dropped from the echo", echoed, ["fallback", "text", "tool_use"]);
    check("only the post-fallback tool ran", client.calls[1].params.messages[2].content.map((b) => b.tool_use_id), ["new"]);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
