# Coordinator Agent on the Claude API — Design Spec

**Date:** 2026-10-12
**Status:** Approved (Mahit, in session: "remove the prbe investigation agent from this, we don't use it anymore")
**Supersedes the PRBE dependency in:** `2026-08-20-coordinator-session-design.md` (the local coordinator runtime, directive queue and panel from that spec are kept unchanged)

## Problem

The Workspace Coordinator's natural-language brain is `@prbe.ai/electron-sdk`,
which hardcodes `wss://middleware.prbe.ai` and `https://api.prbe.ai`. Both
names no longer exist in DNS and the prbe.ai product line is retired, so every
directive fails with "WebSocket connection error" (the SDK's fallback text when
Electron 41's WebSocket error event carries no message). There is no URL
override in any published SDK version.

## Decision

Replace the PRBE SDK with a direct Claude tool-use loop in the Electron main
process, keep the local coordinator runtime, directives API and panel, and
remove every PRBE-specific artefact (dependency, baked-in key, IPC channels,
config routes, naming, `[PRBE_ERROR_*]` log tags).

## Goals

- A directive typed into the Coordinator panel runs a Claude turn that can
  inspect sessions, record decisions and queue directives through the existing
  local HTTP API, exactly as the PRBE agent could.
- The agent can ask the user a question or request confirmation mid-turn,
  using the existing interaction dialog.
- Follow-up messages typed while a turn runs reach the model on its next step.
- Stop cancels the in-flight API call and leaves the panel in a clean state.
- Credentials come from Settings (stored locally) or `ANTHROPIC_API_KEY`.
- Zero references to PRBE remain in code, config, workflows or UI copy.

## Non-goals

- Persisting coordinator turns across app restarts (they were in-memory before).
- A model picker in Settings. The model is a constant with a config-file override.
- Changing the coordinator runtime, directive state machine or panel layout.

## Architecture

```
renderer (CoordinatorPanel, CoordinatorInteractionDialog, useCoordinatorAgentStore)
   │ IPC  coordinator-agent:*                      ▲ coordinator-agent:state
   ▼                                               │
electron/coordinatorAgent.ts  ── CoordinatorAgent (loop, state, interactions)
   │ runs tools via                                │ Anthropic SDK (beta messages, streaming)
electron/coordinatorTools.ts  ── definitions + runToolCall(name, input)
   │ HTTP to the embedded Hono server
server /api/sessions, /api/coordinator/*  (unchanged)
server /api/coordinator-agent/config      (replaces /api/prbe/config)
```

### `electron/coordinatorTools.ts`

Pure module, no Electron import. `createCoordinatorTools({ serverPort,
launchCwd, fetch })` returns `{ definitions, run }`:

- `definitions`: `Anthropic.Beta.BetaTool[]` with flat string-parameter JSON
  schemas (inputs are tiny, so the API's buffered validation is kept rather
  than eager input streaming) for the eight existing tools:
  `list_active_sessions`, `get_session_status`, `read_session_output`,
  `get_session_activity`, `get_coordination_state`, `record_decision`,
  `send_directive`, `acknowledge_directive`. Descriptions say when to call them.
- Two interaction tools, `ask_user` (`question`, optional `context`) and
  `request_confirmation` (`action`, `detail`, optional `reason`), are declared
  here too but executed by the agent, because they block on the renderer.
- `run(name, input)` validates the input against the schema (every `required`
  key present, every value a string) and returns `{ content, isError }`. Tool
  failures become `is_error` tool results, never thrown. Results are capped at
  20k characters before they reach the model. `read_session_output` reads the
  session's persisted scrollback through the app's own `loadBuffer` (JSON
  envelopes under the data dir, legacy `.txt` migrated), never raw files.

### `electron/coordinatorAgent.ts`

`CoordinatorAgent` is a class with injected dependencies so it is testable
without Electron or the network:

```ts
new CoordinatorAgent({
  client,            // Anthropic client (fake in tests)
  model,             // default "claude-opus-5"
  tools,             // from createCoordinatorTools
  onState,           // (state: CoordinatorAgentState) => void, forwarded over IPC
  onInteraction,     // (payload) => void, forwarded over IPC
})
```

Methods: `startTurn(directive)`, `cancel()`, `sendMessage(text)`,
`respondToInteraction(id, response)`, `getState()`.

Loop per turn (manual loop; chosen over the SDK tool runner because user
follow-ups must be injected between steps and interaction tools block on the
renderer):

1. `messages = [{ role: "user", content: directive }]`, fresh per directive.
2. Drain queued follow-up messages into a trailing `user` message.
3. `client.beta.messages.stream({ model, max_tokens: 32000, system: [preamble,
   cache_control ephemeral], tools, messages, thinking: { type: "adaptive",
   display: "summarized" }, betas: ["server-side-fallback-2026-07-01"],
   fallbacks: "default" }, { signal })` → `finalMessage()`.
4. Append the assistant message. Emit feed events: one per thinking block
   (summary as detail), one per text block (shown as the agent message), one
   per tool call (input as detail, completed when its result lands).
5. `end_turn` → the last text block is the report; done. `refusal` → error,
   tools not run. `max_tokens` with a tool call → error, tools not run.
   `pause_turn` → re-send. Otherwise run every tool call, interaction tools
   awaiting the renderer, and append all results in one `user` message.
6. Hard cap of 40 steps per turn → error "Coordinator stopped after 40 steps".
7. `end_turn` with a follow-up queued during the call → one more step so the
   follow-up is answered. `max_tokens` with no tool call keeps the partial text
   as the report. `model_context_window_exceeded` → error. `compaction` is
   re-sent like `pause_turn`. Completed turns are capped at 20 in memory.
   Each turn carries its own abort controller and cancelled flag; a cancelled
   turn that settles after a new one started never touches the new state.
8. Approval is enforced in code, not only in the prompt: `send_directive` and
   `record_decision` run only when the user approved a `request_confirmation`
   earlier in the turn whose `detail` equals the directive text / decision
   choice exactly, and each approval covers one call. Once the user denies a
   confirmation, the rest of that tool batch is skipped. `send_directive`
   also refuses a target whose `agentId` is `shell`, since a directive is
   pasted and submitted into the target terminal.
9. A cache breakpoint sits on the latest user message each step so earlier
   steps are read from cache. After a mid-output fallback, thinking and
   tool_use blocks before the fallback marker are neither echoed nor run.
   A turn that ends with no text is an error. Completed turns keep only
   id, directive, report and time so IPC snapshots stay small.

Cancellation aborts the stream through an `AbortController`, rejects any
pending interaction, and marks the turn cancelled with no error.

### State and IPC

`CoordinatorAgentState` (renderer-safe, in `client/src/types/coordinatorAgent.ts`
and mirrored in the main process):

```
isRunning, currentDirective, events[], report, error?, agentMessage?,
pendingInteraction?, resolvedInteractions[], conversationHistory[],
completedTurns[]
```

Every change pushes the full state over `coordinator-agent:state`; interaction
requests also go over `coordinator-agent:interaction`. Renderer → main:
`coordinator-agent:is-available`, `start-turn`, `cancel`, `send-message`,
`respond-interaction`, `get-state`.

### Config and credentials

`server/services/coordinatorAgentConfig.ts` reads and writes
`coordinator-agent.json` in the app's data dir (`OPENUI_DATA_DIR`, else
`${LAUNCH_CWD}/.openui-desktop`), mode 0600, written atomically
(`{ apiKey?, model? }`).
Resolution order: saved key → `ANTHROPIC_API_KEY` → none. The route
`GET/POST /api/coordinator-agent/config` returns `{ hasApiKey, source:
"settings" | "env" | null, model }` and accepts `{ apiKey }` (empty string
removes it), mirroring the title-generation config route. Settings → Integrations
gets a "Coordinator" card with an Anthropic API key field in place of the PRBE
card. The release workflow no longer writes `resources/default-config.json`.

### Error handling

SDK errors map to one sentence shown under "Coordinator Error":
`AuthenticationError` → key rejected, update it in Settings;
`RateLimitError` → rate limited, retry shortly; `APIConnectionError` →
could not reach the Anthropic API; other `APIError` → status + message;
missing credentials → add a key in Settings. The error string is also logged.

### Removal list

`@prbe.ai/electron-sdk`, `electron/prbe.ts`, `server/services/prbe.ts`,
`server/routes/prbe.ts`, `client/src/{types/prbe.ts, stores/usePRBEStore.ts,
hooks/usePRBEIPC.ts, components/PRBEPanel.tsx, PRBEInteractionDialog.tsx}`,
the `prbeApiKey` default-config loader in `electron/main.ts`, the "Inject
PRBE API key" release step, the `REQUEST_PATH_ACCESS` and
`REVIEW_SANITIZED_OUTPUT` interaction types (PRBE-only), and all 28
`[PRBE_ERROR_*]` log-tag prefixes (the log lines stay).

## Testing

- `scripts/test-coordinator-agent.mjs` (`npm run test:coordinator-agent`)
  against the built `dist/electron` output with a scripted fake client and
  fake fetch: tool round trip, parallel tool calls answered in one message,
  invalid input → `is_error`, `ask_user` round trip through
  `respondToInteraction`, follow-up injection, cancel, refusal, step cap,
  auth-error message, config precedence.
- `npm run build`, client `tsc --noEmit`, existing `test:coordinator` and
  `test:status` stay green.
- Manual: launch the built app, open the coordinator, run a directive against
  the real API with a key in Settings.
