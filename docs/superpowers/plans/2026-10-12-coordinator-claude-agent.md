# Coordinator Agent on the Claude API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead `@prbe.ai/electron-sdk` brain of the Workspace Coordinator with a direct Claude tool-use loop, and remove every PRBE artefact.

**Architecture:** A pure `CoordinatorAgent` class (manual streaming tool loop over `client.beta.messages.stream`) plus a pure tools module, both testable with a fake client and the real embedded server contract; a thin Electron IPC wrapper; the renderer panel/store/dialog renamed and rewired; config moves to `coordinator-agent.json`. Spec: `docs/superpowers/specs/2026-10-12-coordinator-claude-agent-design.md`.

**Tech Stack:** TypeScript (CommonJS electron build via `tsconfig.electron.json`), `@anthropic-ai/sdk` 0.133, Hono, React 18 + zustand, Node test scripts under `scripts/` run against `dist/electron`.

---

## File map

| File | Responsibility |
|---|---|
| `server/services/coordinatorAgentConfig.ts` (new) | load/save `coordinator-agent.json`; resolve credentials (settings > env) |
| `server/routes/coordinatorAgent.ts` (new, replaces `routes/prbe.ts`) | `GET/POST /api/coordinator-agent/config` |
| `electron/coordinatorAgentTypes.ts` (new) | state / event / interaction types shared by agent + IPC (no Node imports) |
| `electron/coordinatorTools.ts` (new) | tool definitions (JSON schema) + validated `run(name, input)` against the local HTTP API |
| `electron/coordinatorAgent.ts` (new) | `CoordinatorAgent`: turn loop, feed events, interactions, follow-ups, cancel, error mapping |
| `electron/coordinatorAgentIpc.ts` (new, replaces `electron/prbe.ts`) | builds the real client/tools, registers `coordinator-agent:*` IPC, forwards state |
| `scripts/test-coordinator-agent.mjs` (new) | behaviour tests for the three pure modules |
| `client/src/types/coordinatorAgent.ts` (new, replaces `types/prbe.ts`) | renderer-safe mirror of the types + `window.electronAPI` augmentation |
| `client/src/stores/useCoordinatorAgentStore.ts` (replaces `usePRBEStore.ts`) | zustand store |
| `client/src/hooks/useCoordinatorAgentIPC.ts` (replaces `usePRBEIPC.ts`) | IPC listeners |
| `client/src/components/CoordinatorPanel.tsx` (replaces `PRBEPanel.tsx`) | panel |
| `client/src/components/CoordinatorInteractionDialog.tsx` (replaces `PRBEInteractionDialog.tsx`) | question / confirmation dialog |
| `client/src/components/SettingsModal.tsx`, `Header.tsx`, `App.tsx`, `stores/rightDock.ts` | rewire |
| `electron/main.ts`, `server/index.ts`, `package.json`, `.github/workflows/release.yml`, `.gitignore`, `docs/warp-terminal-parity.md` | removal + mount + script |

---

### Task 1: Config service and route

**Files:** Create `server/services/coordinatorAgentConfig.ts`, `server/routes/coordinatorAgent.ts`, `scripts/test-coordinator-agent.mjs`. Modify `server/index.ts:9,71`, `package.json` scripts. Delete `server/services/prbe.ts`, `server/routes/prbe.ts`.

- [ ] **Step 1: Write the failing tests** (`scripts/test-coordinator-agent.mjs`, same `check()` helper as `scripts/test-coordinator.mjs`):

```js
const cfg = await import(join(here, "..", "dist", "electron", "server", "services", "coordinatorAgentConfig.js"));
const dir = mkdtempSync(join(tmpdir(), "coord-cfg-"));
check("empty dir loads empty config", cfg.loadCoordinatorAgentConfig(dir), {});
cfg.saveCoordinatorAgentConfig({ apiKey: "sk-ant-1", model: "claude-opus-5" }, dir);
check("save then load round-trips", cfg.loadCoordinatorAgentConfig(dir), { apiKey: "sk-ant-1", model: "claude-opus-5" });
check("settings key beats env", cfg.resolveCoordinatorCredentials({ apiKey: "sk-ant-1" }, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-ant-1", source: "settings" });
check("env key used when settings empty", cfg.resolveCoordinatorCredentials({}, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-env", source: "env" });
check("no key anywhere", cfg.resolveCoordinatorCredentials({}, {}), { apiKey: undefined, source: null });
cfg.saveCoordinatorAgentConfig({ apiKey: "" }, dir);
check("empty key is dropped on save", cfg.loadCoordinatorAgentConfig(dir), {});
```

- [ ] **Step 2: Run to verify it fails:** `npm run test:coordinator-agent` → FAIL (module not found).
- [ ] **Step 3: Implement** `coordinatorAgentConfig.ts` (`DEFAULT_COORDINATOR_MODEL = "claude-opus-5"`, file `${launchCwd}/.openui-desktop/coordinator-agent.json`, `launchCwd` defaults to `process.env.LAUNCH_CWD || homedir()`), and the route returning `{ hasApiKey, source, model }` on GET and after POST `{ apiKey }` (empty string removes). Mount at `/api/coordinator-agent`. Add `"test:coordinator-agent": "npm run build:electron && node scripts/test-coordinator-agent.mjs"`.
- [ ] **Step 4: Run to verify it passes.** 
- [ ] **Step 5: Commit** `feat(coordinator): config service for the Claude-backed agent`.

### Task 2: Tools module

**Files:** Create `electron/coordinatorTools.ts`, `electron/coordinatorAgentTypes.ts`. Test in `scripts/test-coordinator-agent.mjs`.

- [ ] **Step 1: Failing tests** (fake `fetch` records `{url, method, body}` and answers from a map; temp `launchCwd` with `.openui-desktop/buffers/<id>.txt`):

```js
const { createCoordinatorTools, INTERACTION_TOOL_NAMES } = await import(.../electron/coordinatorTools.js);
const tools = createCoordinatorTools({ serverPort: 7000, launchCwd: dir, fetch: fakeFetch });
check("ten tool definitions", tools.definitions.map(t => t.name), ["list_active_sessions","get_session_status","read_session_output","get_session_activity","get_coordination_state","record_decision","send_directive","acknowledge_directive","ask_user","request_confirmation"]);
check("definitions stream input eagerly", tools.definitions.every(t => t.eager_input_streaming === true), true);
check("interaction tool names", INTERACTION_TOOL_NAMES, ["ask_user", "request_confirmation"]);
check("list_active_sessions hits /api/sessions", await tools.run("list_active_sessions", {}), { content: JSON.stringify([{ id: "s1" }], null, 2), isError: false });
check("send_directive posts author coordinator", JSON.parse(lastCall.body), { sessionId: "s1", text: "do x", decisionId: undefined, clientRequestId: undefined, author: "coordinator" });
check("record_decision splits sessionIds", JSON.parse(lastCall.body).scope, { kind: "sessions", sessionIds: ["s1", "s2"] });
check("missing required field is an error result", await tools.run("get_session_status", {}), { content: "Invalid input for get_session_status: missing required field sessionId", isError: true });
check("non-string field is an error result", (await tools.run("get_session_status", { sessionId: 5 })).isError, true);
check("unknown tool", await tools.run("nope", {}), { content: "Unknown tool: nope", isError: true });
check("HTTP error becomes error result", await tools.run("acknowledge_directive", { directiveId: "d-missing" }), { content: "Directive was not acknowledged: directive not found", isError: true });
check("read_session_output tails the buffer", await tools.run("read_session_output", { sessionId: "s1" }), { content: "hello", isError: false });
check("interaction tools are not run here", (await tools.run("ask_user", { question: "?" })).isError, true);
```

- [ ] **Step 2: Verify RED.** - [ ] **Step 3: Implement** (definitions with `input_schema` of flat string properties + `required`, `eager_input_streaming: true`; `validateToolInput`; `request()` helper throwing `Error(body.error || "HTTP n")`; handlers ported from `electron/prbe.ts` with identical URLs, bodies and error prefixes). - [ ] **Step 4: Verify GREEN.** - [ ] **Step 5: Commit** `feat(coordinator): tool definitions and runner for the Claude agent`.

### Task 3: Agent loop

**Files:** Create `electron/coordinatorAgent.ts`. Test in `scripts/test-coordinator-agent.mjs` with a fake client:

```js
function fakeClient(script) { // script: array of Message | Error | (call) => Promise<Message>
  const calls = [];
  return { calls, beta: { messages: { stream(params, opts) {
    const next = script.shift(); calls.push({ params, opts });
    return { on() { return this; }, abort() {}, async finalMessage() {
      if (typeof next === "function") return next({ params, opts });
      if (next instanceof Error) throw next; return next; } };
  } } } };
}
const msg = (content, stop_reason) => ({ id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
```

- [ ] **Step 1: Failing tests** (each builds `new CoordinatorAgent({ client, tools, onState, onInteraction })` and awaits `startTurn("…")`):
  1. tool round trip: script `[msg([thinking, tool_use list_active_sessions], "tool_use"), msg([text "Two sessions idle."], "end_turn")]` → second call's last message is a `user` message with exactly one `tool_result` whose `tool_use_id` matches; `state.report === "Two sessions idle."`; events = ["Thinking", "list_active_sessions"] both completed; `completedTurns.length === 1`; first call params: `model === "claude-opus-5"`, `betas` contains `server-side-fallback-2026-07-01`, `fallbacks === "default"`, `thinking.display === "summarized"`, `system[0].cache_control.type === "ephemeral"`, tools length 10.
  2. parallel tool calls answered in one user message with two `tool_result` blocks in call order.
  3. invalid tool input → `tool_result.is_error === true` and the loop continues to the final message.
  4. `ask_user`: script `[msg([tool_use ask_user {question:"Which?"}], "tool_use"), msg([text "ok"], "end_turn")]`; `onInteraction` receives `{ type: "ask_question", interactionId, question: "Which?" }`; `state.pendingInteraction` set; `agent.respondToInteraction(id, { type: "ask_question", answer: "B" })` → tool_result content `"User answered: B"`; `resolvedInteractions.length === 1`; `pendingInteraction` undefined afterwards.
  5. `request_confirmation` denied → tool_result content `"User denied: <action>"`.
  6. follow-up: a scripted function response calls `agent.sendMessage("also check s2")` before returning a tool_use message; the next call's messages contain a trailing `user` text block `"also check s2"` after the tool results, and `conversationHistory` has it as a user entry.
  7. cancel: scripted function returns a promise that rejects with `Object.assign(new Error("aborted"), { name: "APIUserAbortError" })` when `opts.signal` aborts; call `agent.cancel()` → `isRunning false`, `error undefined`, last event label `"Cancelled"`, `completedTurns.length === 0`.
  8. refusal: `msg([], "refusal")` → `error === "Claude declined this directive."`, no further calls.
  9. max_tokens with tool_use → `error === "The coordinator's response was cut off at the token limit."`.
  10. step cap: `new CoordinatorAgent({ ..., maxSteps: 2 })` with an endless tool_use script → `error === "Coordinator stopped after 2 steps without finishing."`.
  11. auth error: script `[new Anthropic.AuthenticationError(401, {...}, "invalid x-api-key", new Headers())]` → `error === "The Anthropic API rejected the key. Update it in Settings → Coordination."`.
  12. `startTurn` while running rejects with `"A coordinator turn is already running"`; `sendMessage` while idle returns `false`.
- [ ] **Step 2: Verify RED.** - [ ] **Step 3: Implement** per the spec's loop (system preamble = the existing `COORDINATOR_PREAMBLE` text, `max_tokens: 32000`). - [ ] **Step 4: Verify GREEN.** - [ ] **Step 5: Commit** `feat(coordinator): Claude tool-use loop replaces the PRBE agent`.

### Task 4: Electron wiring

**Files:** Create `electron/coordinatorAgentIpc.ts`. Modify `electron/main.ts` (drop `loadDefaultConfig`, import/init/cleanup). Delete `electron/prbe.ts`.

- [ ] `initCoordinatorAgent(mainWindow, serverPort)`: resolves credentials on every `start-turn`, (re)builds `new Anthropic({ apiKey })` + tools + agent when the key changes, forwards `onState` → `coordinator-agent:state`, `onInteraction` → `coordinator-agent:interaction`. Handlers: `is-available` → `{ hasApiKey, source }`; `start-turn` → `{ success } | { success: false, error }` (missing key error: "Add an Anthropic API key in Settings → Coordination to use the coordinator."); `cancel`; `send-message`; `respond-interaction`; `get-state`. `cleanupCoordinatorAgent()` cancels.
- [ ] `npm run build:electron` passes. Commit `refactor(electron): wire the coordinator agent over IPC, drop prbe.ts`.

### Task 5: Renderer

- [ ] Types, store, hook, panel, dialog renamed as in the file map; IPC channels `coordinator-agent:*`; store fields `isRunning/currentDirective/events/report/error/agentMessage/pendingInteraction/resolvedInteractions/conversationHistory/completedTurns/hasApiKey/credentialSource`. Panel: same layout, `.replace(/_/g, " ")` instead of `replaceAll`, empty state says to add a key when `hasApiKey` is false. Dialog keeps the question + confirmation variants only. Settings → Coordination card: Anthropic API key (states: env / settings / none). Header, rightDock, App rewired.
- [ ] `cd client && npx tsc --noEmit` passes; `npm run build:client` passes. Commit `feat(ui): coordinator panel talks to the Claude-backed agent`.

### Task 6: Remove the rest of PRBE

- [ ] Strip `[PRBE_ERROR_xxxx] ` prefixes (28 lines, 7 files) with `perl -pi -e 's/\[PRBE_ERROR_[A-Za-z0-9]+\] //g'` on the affected files and drop the two `// Probe Agent Error Log Trigger` comments. Delete the "Inject PRBE API key" step from `.github/workflows/release.yml`, the `resources/default-config.json` line from `.gitignore`. Update `docs/warp-terminal-parity.md:59` "PRBE dialogs" → "coordinator dialogs". `grep -ri prbe` over the tree (excluding node_modules, dist, specs) returns nothing. Commit `chore: remove the last PRBE references`.

### Task 7: Verification

- [ ] `npm run build`, `cd client && npx tsc --noEmit`, `npm run test:coordinator-agent`, `npm run test:coordinator`, `npm run test:status` all green; paste outputs.
- [ ] Launch the built app from the worktree with `PORT=7968 LAUNCH_CWD=<scratch>` and run one directive with a real key (if available); otherwise record that the live run is pending a key.
