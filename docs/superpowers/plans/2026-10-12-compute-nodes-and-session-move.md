# Compute Nodes + Session Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human or an agent provision a Modal or Thunder Compute node from Naught with keys stored as secrets, under a spend policy with email, and move a running session's working tree and conversation onto such a node and back.

**Architecture:** Provisioned nodes are devboxes filled in by a `ComputeProvider` (Modal via the `modal` npm SDK, Thunder via REST); an orchestrator owns policy, approval, ledger, reconcile and Resend mail; a `naught` CLI on every session's PATH exposes it to agents. A move is a persisted state machine: manifest + tar-over-ssh to the same absolute path, harness transcript copy, relaunch through the existing restart path with `--resume`, verify; bring-back is the same in reverse with a manifest conflict check. Two remote fixes (instrumented bare-ssh launch, reverse tunnel for hooks) make remote sessions first-class.

**Tech Stack:** TypeScript (Electron 41 / Node 24 in-process server, Hono routes, node-pty), React 18 + zustand client, `modal` 0.7.2 SDK, Resend HTTP API, Thunder REST, Python 3 helper script for manifests, `scripts/test-*.mjs` runner style (`check(name, actual, expected)`), Docker sshd fixture for integration.

**Specs:** `docs/superpowers/specs/2026-10-12-compute-nodes-design.md`, `docs/superpowers/specs/2026-10-12-session-move-design.md`.

**Conventions for every task:** run from the worktree `~/Desktop/devtools/openui-desktop-worktrees/compute-and-move`. Build server code with `npm run build:electron` (tests import from `dist/electron/server/...`). Client typecheck: `cd client && npx tsc --noEmit` (one pre-existing error in `PRBEPanel.tsx:93` is the baseline). Commit after each task with the attribution trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never touch `~/.ssh`, never spend credits outside the opt-in live smoke.

---

## File structure

**Server, new**

| file | responsibility |
| --- | --- |
| `server/services/secrets.ts` | `.env` read/write (moved from `titleGenerator.ts`), `resolveSecret`, detection from `~/.modal.toml` / `~/.thunder/token` |
| `server/services/compute/provider.ts` | `ComputeProvider`, `ComputeOffer`, `ComputeSpec`, `SshEndpoint`, `ProviderId` |
| `server/services/compute/policy.ts` | pure `evaluatePolicy(policy, spec, liveCount)` |
| `server/services/compute/sshKeys.ts` | the Naught ed25519 keypair |
| `server/services/compute/notify.ts` | Resend mail with idempotency keys, message bodies |
| `server/services/compute/thunder.ts` | Thunder provider (fetch injected) |
| `server/services/compute/modal.ts` | Modal provider (client factory injected) |
| `server/services/compute/sshExec.ts` | `runOverSsh(devbox, command, {input, timeoutMs})` using the real ssh and the Naught key |
| `server/services/compute/bootstrap.ts` | node preparation script + `ensureNodeAssets` |
| `server/services/compute/nodes.ts` | orchestrator: request/approve/deny/terminate/list, ledger tick, reconcile |
| `server/routes/compute.ts` | `/api/compute/*` |
| `server/services/move/manifest.ts` | run `naught_manifest.py` locally/remotely, diff, summaries |
| `server/services/move/transfer.ts` | tar streaming, deletes, verification |
| `server/services/move/harness.ts` | Claude/Codex state discovery, resume + exit commands |
| `server/services/sessionMove.ts` | the move state machine |
| `server/routes/move.ts` | `/api/sessions/:id/move*` |
| `resources/remote-terminal/naught_manifest.py` | manifest tool, both sides |
| `bin/naught.js` | the CLI (`node`/`session` commands); exports `parseArgs`, `run` for tests |
| `scripts/test-compute.mjs`, `scripts/test-move.mjs`, `scripts/test-move-docker.mjs`, `scripts/smoke-compute-live.mjs` | tests |

**Server, modified**

| file | change |
| --- | --- |
| `server/types/index.ts` | `ProvisionRecord`, `ComputeConfig`, `MoveState`, `DevboxConfig.source` union + `provision?`, `Session.transcriptPath`, `Session.move`, `Session.codexSessionId`, `PersistedNode.move`, `LinearConfig.compute` |
| `server/services/devboxes.ts` | `source: "provisioned"` in `normalise`, `buildDevboxLaunch` (instrumented shape), `upsertProvisionedDevbox`, `updateProvision` |
| `server/services/persistence.ts` | carry `devboxId`, `remotePath`, `move` through validation and serialisation |
| `server/services/sessionManager.ts` | restore `devboxId`/`remotePath`/`move`; `naught` shim in `prepareShellShimEnvironment`; `relaunchSession()` extracted from the restart route; remote-ready typed launch; hook env exports |
| `server/routes/api.ts` | restart route calls `relaunchSession`; `/status-update` stores `transcriptPath`; `GET /sessions` exposes `devboxId`, `remotePath`, `devboxName`, `move`; session creation accepts `newNode` |
| `server/routes/devboxes.ts` | GET includes `provision`; DELETE of a provisioned box routes to terminate |
| `server/index.ts` | mount routes, start the node tick after restore, resume in-flight moves |
| `server/services/titleGenerator.ts` | import `updateEnvValue`/`loadEnvFile` from `secrets.ts` |
| `resources/remote-terminal/openui_ssh_wrapper.cjs` | `-R 0:127.0.0.1:<port>` on the master when `OPENUI_REMOTE_HOOKS_PORT` is set; parse the allocated port; emit `tunnel` metadata |
| `server/services/terminalRemote.ts` | accept the `tunnel` envelope, expose `hookPort(sessionId)` and `onReady(sessionId, cb)` |
| `package.json` | `modal` dependency, `bin.naught`, `files` entry, `test:compute`, `test:move`, `test:move:docker`, `smoke:compute-live` scripts |

**Client, new**

| file | responsibility |
| --- | --- |
| `client/src/hooks/useComputeNodes.ts` | poll `/api/compute/nodes` every 5 s; expose nodes, pending approvals, live cost |
| `client/src/components/compute/LiveNodesIndicator.tsx` | header indicator |
| `client/src/components/compute/ApprovalSheet.tsx` | approve/deny modal |
| `client/src/components/compute/NewNodeForm.tsx` | inline provisioning form (used by the Run-on selector and the move sheet) |
| `client/src/components/settings/ComputeTab.tsx` | Settings → Compute |
| `client/src/components/move/MoveSheet.tsx` | move out / bring back sheet |

**Client, modified**

| file | change |
| --- | --- |
| `client/src/stores/useStore.ts` | `AgentSession` gains `devboxId`, `devboxName`, `remotePath`, `move` |
| `client/src/App.tsx` | map the new fields in `pollStatus` and restore; mount `ApprovalSheet` and `MoveSheet` |
| `client/src/components/Header.tsx` | mount `LiveNodesIndicator` |
| `client/src/components/SettingsModal.tsx` | `compute` tab |
| `client/src/components/settings/DevboxesTab.tsx` | provisioned rows |
| `client/src/components/NewSessionModal.tsx` | *New node…* option |
| `client/src/components/AgentNode/AgentNodeContextMenu.tsx`, `index.tsx`, `AgentNodeCard.tsx` | Move / Bring back entries, node badge, moving state |
| `client/src/components/CommandPalette.tsx` | Move / Bring back actions |

---

## Phase A — compute foundations

### Task A1: Shared secrets module

**Files:**
- Create: `server/services/secrets.ts`
- Modify: `server/services/titleGenerator.ts` (replace its local `loadEnvFile`/`updateEnvValue` with imports)
- Test: `scripts/test-compute.mjs` (new; starts here, grows through phase A)

- [ ] **Step 1: Write the failing tests** in `scripts/test-compute.mjs` (runner style copied from `scripts/test-devboxes.mjs`): with `LAUNCH_CWD` pointed at a `mkdtempSync` dir, `readEnvFile()` returns `{}` when missing; `updateEnvValue("TNR_API_TOKEN", "abc")` then `readEnvFile().TNR_API_TOKEN === "abc"`; updating again replaces the line (file has one `TNR_API_TOKEN=` line); `updateEnvValue(k, "")` removes it; quotes inside values are escaped and read back; `resolveSecret("TNR_API_TOKEN", { env: {}, detectors: {...} })` returns `{ value, source: "naught" }` from the file, `source: "env"` from a passed env, `source: "detected"` from a detector, `undefined` when nothing; `parseModalToml(text)` picks the `active = true` profile's `token_id`/`token_secret` and falls back to the only profile.
- [ ] **Step 2: Run** `npm run build:electron && node scripts/test-compute.mjs` → fails (module missing).
- [ ] **Step 3: Implement** `secrets.ts`:
  ```ts
  export function envFilePath(): string            // ${LAUNCH_CWD}/.openui-desktop/.env
  export function readEnvFile(): Record<string,string>
  export function updateEnvValue(key: string, value: string): void
  export type SecretSource = "naught" | "env" | "detected";
  export function resolveSecret(key: string, options?: { env?: NodeJS.ProcessEnv; detector?: () => string | undefined }): { value: string; source: SecretSource } | undefined
  export function parseModalToml(text: string): { tokenId: string; tokenSecret: string; profile: string } | undefined
  export function detectModalToken(): { tokenId: string; tokenSecret: string } | undefined   // reads ~/.modal.toml or MODAL_CONFIG_PATH
  export function detectThunderToken(): string | undefined                                 // ~/.thunder/token
  ```
  `titleGenerator.ts` imports `readEnvFile as loadEnvFile` and `updateEnvValue` and deletes its own copies.
- [ ] **Step 4: Run** the tests → pass. `npm run test:status` still green (title generation untouched in behaviour).
- [ ] **Step 5: Commit** `feat(secrets): shared .env helper with resolution and provider detection`.

### Task A2: Types, persistence and restore fields

**Files:**
- Modify: `server/types/index.ts`, `server/services/persistence.ts`, `server/services/sessionManager.ts` (restore block ~2230), `server/services/devboxes.ts` (`normalise`), `server/routes/api.ts` (`GET /sessions`, `/status-update`)

- [ ] **Step 1: Add types** exactly as in the specs: `ProviderId`, `ProvisionRecord`, `ComputeConfig` (with `DEFAULT_COMPUTE_CONFIG` exported from `compute/policy.ts` later), `MoveState`, `ManifestSummary { hash: string; files: number; bytes: number; roots: string[] }`; `DevboxConfig.source: "manual" | "ssh-config" | "provisioned"`, `provision?: ProvisionRecord`; `Session.transcriptPath?`, `Session.codexSessionId?`, `Session.move?: MoveState`; `PersistedNode.move?: MoveState`; `LinearConfig.compute?: ComputeConfig`.
- [ ] **Step 2: Persistence**: in the node validator add `devboxId: boundedIdentifier(node.devboxId, 256)`, `remotePath: boundedString(node.remotePath, MAX_CWD_CHARS)`, `move: validateMoveState(node.move)` (checks `direction`, `state` enum, `nodeId`, numbers; returns `undefined` on anything odd); serialise `move: session.move`. In `restoreSessions` set `devboxId: node.devboxId, remotePath: node.remotePath, move: node.move`.
- [ ] **Step 3: Tests** in `test-compute.mjs`: a persisted node with `devboxId`, `remotePath` and a valid `move` round-trips through `validatePersistedNode` (export it if private, or test through `loadState`/`saveState` on a temp dir); an invalid `move.state` is dropped.
- [ ] **Step 4: `GET /sessions`** adds `devboxName` (lookup via `getDevbox`), `move`; `/status-update` stores `body.transcriptPath` when it is a string ≤ 4096 chars and the hook event is not `SessionEnd`.
- [ ] **Step 5: Build, run `test:compute`, `test:devboxes`, `test:status`** → green. **Commit** `feat(types): provision, compute config and move state; persist devbox fields on restore`.

### Task A3: Policy

**Files:** Create `server/services/compute/policy.ts`; test in `scripts/test-compute.mjs`.

- [ ] **Step 1: Tests**: `DEFAULT_COMPUTE_CONFIG.policy` equals `{ maxConcurrentNodes: 2, allowedGpus: "any", maxLifetimeHours: 8, maxHourlyUsd: 5 }`; `evaluatePolicy(policy, spec, { liveNodes: 2 })` → `{ allowed: false, reasons: ["Already 2 of 2 nodes live"] }`; GPU not in list → reason `GPU H100 is not in the allowed list (A10G, T4)`; `hourlyUsd` 7.9 > 5 → `Estimated $7.90/hr exceeds the $5.00/hr cap`; lifetime 10 > 8 → `Lifetime 10h exceeds the 8h cap`; all inside → `{ allowed: true, reasons: [] }`; multiple failures list every reason.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** `evaluatePolicy(policy: ComputeConfig["policy"], spec: ComputeSpec & { hourlyUsd: number }, context: { liveNodes: number }): { allowed: boolean; reasons: string[] }` and `normaliseComputeConfig(input: unknown): ComputeConfig` (fills defaults, clamps numbers ≥ 0, `allowedGpus` to `"any"` or a deduped string list). **Step 4: Run** → pass. **Step 5: Commit** `feat(compute): spend policy evaluation`.

### Task A4: Naught SSH keypair

**Files:** Create `server/services/compute/sshKeys.ts`; test.

- [ ] **Step 1: Tests**: with `LAUNCH_CWD` a temp dir, `await ensureNaughtKeypair()` creates `.openui-desktop/keys/naught_ed25519` (mode `0600`) and `.pub` starting with `ssh-ed25519 `; a second call returns the same public key without rewriting (mtime unchanged); `publicKeyText()` is trimmed, single line.
- [ ] **Step 3: Implement** with `spawn("ssh-keygen", ["-t","ed25519","-N","","-C","naught","-f",path])`, `mkdirSync(..., {mode: 0o700})`, `chmodSync`. Export `naughtKeyPath()`, `ensureNaughtKeypair(): Promise<{ privateKeyPath: string; publicKey: string }>`.
- [ ] **Step 5: Commit** `feat(compute): naught-owned ssh keypair`.

### Task A5: Resend notifications

**Files:** Create `server/services/compute/notify.ts`; test.

- [ ] **Step 1: Tests** with an injected `fetch` recorder: `sendNodeEmail({ kind: "started", node, config, apiKey }, fetchStub)` POSTs to `https://api.resend.com/emails` with `Authorization: Bearer re_x`, header `Idempotency-Key: naught-<id>-started`, body `from`, `to`, `subject` containing the node name and `est.`, `text` containing provider, GPU, "billing started", and the two ways to stop it; `kind: "reminder", n: 3` → key `naught-<id>-reminder-3` and subject containing the uptime; `kind: "idle", n: 1` → key `naught-<id>-idle-1`; `kind: "terminated"` → key `naught-<id>-terminated`; a non-2xx response rejects with the response text; missing `to` returns `{ skipped: "no-recipient" }` without calling fetch.
- [ ] **Step 3: Implement** `renderNodeEmail(kind, node, extras)` (pure, returns `{ subject, text }`) and `sendNodeEmail(...)`. Cost line: `hourlyUsd * hours` formatted `$x.xx est.`. Include `Idempotency-Key`.
- [ ] **Step 5: Commit** `feat(compute): Resend billing emails with idempotency`.

### Task A6: Provider interface + Thunder provider

**Files:** Create `server/services/compute/provider.ts`, `server/services/compute/thunder.ts`; fixtures inline in the test.

- [ ] **Step 1: Tests** with injected `fetch`: `configured()` → `{ ok: false }` without a token, `{ ok: true, source }` with one, and `POST /providers/thunder/test` semantics via `test()` calling `GET /instances/list`; `offers()` parses a `/v2/specs` response `{ specs: { "h100": { displayName: "H100", gpuCount: 1, vcpuOptions: [4,8], ramPerVCPUGiB: 4, vramGB: 80, storageGB: {min: 100, max: 1000} } } }` joined with `/v2/pricing` `{ pricing: { "h100": 1.47 } }` into `ComputeOffer { provider: "thunder", gpu: "h100", gpuCount: 1, cpu: 4, memoryGb: 16, diskGb: 100, hourlyUsd: 1.47, label: "H100 · 4 vCPU · 16 GB" }` (one offer per vcpu option); unknown pricing → `hourlyUsd: 0` and `label` ending `· price unknown`; `provision(spec, pubkey)` POSTs `/instances/create` with `{ num_gpus, gpu_type, cpu_cores, disk_size_gb, template, public_key }` and returns `{ instanceId: uuid }` (identifier kept in a side map for list lookups); `waitReady` polls `/instances/list` (response is a map keyed by id) until the entry has `status` matching `/running|active/i` and non-empty `ip`, returns `{ host: ip, port: port || 22, user: "ubuntu" }`, honours the abort signal; `status()` maps running→`ready`, missing→`terminated`, `error`→`error`, else `provisioning`; `terminate()` DELETEs `/instances/{identifier}`; `estimateHourlyUsd` uses the cached pricing.
- [ ] **Step 3: Implement.** Base URL `https://api.thundercompute.com:8443/v1`. Every request sets `Authorization: Bearer <token>` and a 20 s timeout via `AbortSignal.timeout`. Offers cached 10 min. Defensive parsing: every field read through small helpers (`num()`, `str()`), never throw on shape surprises, log once.
- [ ] **Step 5: Commit** `feat(compute): provider interface and Thunder Compute provider`.

### Task A7: Modal provider

**Files:** Create `server/services/compute/modal.ts`; test.

- [ ] **Step 1: Tests** with an injected client factory returning a fake `{ apps.fromName, images.fromRegistry().dockerfileCommands, sandboxes.create, sandboxes.fromId, sandboxes.list }`: `buildModalImageCommands({ gpu: "H100" })` starts `FROM`-equivalent base `nvidia/cuda:12.4.0-devel-ubuntu22.04` and contains `apt-get install -y openssh-server git rsync curl ca-certificates python3 nodejs npm`, `curl -fsSL https://claude.ai/install.sh | bash`, `npm i -g @openai/codex`, `mkdir -p /run/sshd`, the public key echoed into `/root/.ssh/authorized_keys`, `PermitRootLogin prohibit-password`; CPU-only uses `ubuntu:22.04`; `toSandboxParams(spec, policy)` → `{ command: ["/usr/sbin/sshd","-D","-e"], unencryptedPorts: [22], gpu: "H100", cpu: 4, memoryMiB: 16384, timeoutMs: 8*3600*1000, name }` and omits `gpu` for CPU-only; `provision()` calls `sandboxes.create(app, image, params)` and returns `{ instanceId: sb.sandboxId }`; `waitReady` resolves `{ host, port, user: "root" }` from `tunnels()[22].tcpSocket` and retries while `tunnels()` throws or lacks 22; `status()` maps `poll() === null` → `ready`, number → `terminated`; `terminate()` calls `sb.terminate()`; `offers()` lists the static table with `hourlyUsd` = GPU rate + sandbox cpu/mem rates for the preset; `configured()` reports `source` from `resolveSecret` order (`MODAL_TOKEN_ID`+`MODAL_TOKEN_SECRET` in Naught, env, then `~/.modal.toml`).
- [ ] **Step 3: Implement.** Static GPU table: `T4 0.59`, `L4 0.80`, `A10G 1.10`, `L40S 1.95`, `A100-40GB 2.10`, `A100-80GB 2.50`, `H100 3.95`, `H200 4.54`, `B200 6.25` $/hr; sandbox CPU `$0.1419/core-hr`, memory `$0.024/GiB-hr` (per-second rates × 3600). Presets: `small 2 vCPU / 8 GB`, `medium 4 / 16`, `large 8 / 32`. The real client: `new ModalClient({ tokenId, tokenSecret })` from `import("modal")` (dynamic import keeps startup fast and lets the test inject). App name `naught`, `createIfMissing: true`.
- [ ] **Step 5: Commit** `feat(compute): Modal sandbox provider with sshd image`.

### Task A8: ssh exec helper and node bootstrap

**Files:** Create `server/services/compute/sshExec.ts`, `server/services/compute/bootstrap.ts`; test.

- [ ] **Step 1: Tests**: `sshArgsFor(devbox, { identityFile })` returns `["-o","BatchMode=yes","-o","ConnectTimeout=10","-o","StrictHostKeyChecking=accept-new","-i",identityFile,"-p","2222","root@h"]`; `buildBootstrapScript({ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" }, assetsTar: true })` is a `set -eu` POSIX script that creates `~/.naught` (0700), writes `~/.naught/env` (0600) with `export CLAUDE_CODE_OAUTH_TOKEN='x'` (single-quote escaped), installs the Claude CLI when `command -v claude` fails, installs codex via npm when missing and npm exists, extracts the asset tar from stdin into `~/.naught/`, prints `NAUGHT_BOOTSTRAP_OK <versions json>` last; `runOverSsh` is exercised with an injected spawner that records args and feeds stdin.
- [ ] **Step 3: Implement** `runOverSsh(devbox, command, { input?: Buffer|string, timeoutMs = 60000, identityFile? , spawn? }) → { code, stdout, stderr }`; `bootstrapNode(devbox, { credentials, assetsTar }) → { ok, versions, error? }`; `buildAssetsTar()` packs `bin/naught.js`, `claude-code-plugin/`, `resources/remote-terminal/naught_manifest.py` from the resource root into a tar (use `tar -c` via spawn with `-C` roots; no new dependency); `ensureNodeAssets(devbox)` compares `~/.naught/assets.version` with the local hash and re-ships when different (used by launch and move preflight).
- [ ] **Step 5: Commit** `feat(compute): ssh exec helper and node bootstrap script`.

### Task A9: Orchestrator

**Files:** Create `server/services/compute/nodes.ts`; modify `server/services/devboxes.ts` (`upsertProvisionedDevbox`, `updateProvision`); test with a fake provider, fake clock, fake mailer.

- [ ] **Step 1: Tests**: `requestNode(spec, requester)` inside policy → record `status: "provisioning"` immediately, provider `provision` called, after the fake `waitReady` resolves and bootstrap passes the devbox is `ready` with `host/user/port/identityFile` filled, `startedAt` set, the mailer got `started`; outside policy → `status: "pending"` with `reasons`, no provider call; `approveNode(id)` continues; `denyNode(id)` → `terminated` with reason `user`; provider failure → `error`, `terminate` attempted, email not sent; `tick()` with the fake clock: after 4 h → one `reminder` (n=1), after 8 h → second, no duplicates when tick runs twice in the same hour; idle 60 min with no attached session → `idle` (n=1) once, then again only after another 60 min idle; past `maxLifetimeHours` → `terminate` called with reason `max-lifetime` and the `terminated` mail; `reconcile()` marks a node `terminated` when the provider says so; `listNodes()` returns provisioned devboxes with `provision`; `liveNodes()` counts `provisioning|ready`; `terminateNode(id, reason)` is idempotent.
- [ ] **Step 3: Implement.** State lives in the devbox config (`provision` record) so it survives restarts; in-memory map of in-flight promises. `attachedSessions(nodeId)` reads `sessions` from `sessionManager` and uses `lastOutputTime`/`lastInputTime` for `lastActivityAt`. `startNodeTicker()` every 60 s (`unref`). `onNodesChanged(listener)` for routes/CLI long-poll. Provider registry `{ modal, thunder }` built lazily from secrets. `requestNode` returns `{ node, pending: boolean }`. `waitForNode(id, timeoutMs)` resolves on `ready|error|terminated`.
- [ ] **Step 5: Commit** `feat(compute): node orchestrator with policy, approvals, ledger and reconcile`.

### Task A10: Routes

**Files:** Create `server/routes/compute.ts`; modify `server/index.ts` (mount at `/api/compute`, call `startNodeTicker()` + `reconcileNodes()` after `restoreSessions()`), `server/routes/devboxes.ts` (DELETE on a provisioned box → `terminateNode`), `server/routes/api.ts` (`startSessionFromApiInput` accepts `newNode: ComputeSpec` and awaits `requestNode` + `waitForNode` before building the launch; a pending approval returns 202 `{ pending: true, nodeId }`).

- [ ] **Step 1: Tests** (`test-compute.mjs`, using Hono's `app.request`): `GET /api/compute/providers` → `[{ id: "modal", configured, source }, { id: "thunder", ... }]` without values; `PUT /providers/thunder/key { token }` writes `TNR_API_TOKEN`; `PUT /providers/modal/key { tokenId, tokenSecret }`; `DELETE` clears; `GET /policy` defaults; `PUT /policy` normalises; `GET/PUT /notifications` (`to` defaults from `git config --global user.email`, read once at startup via `execFile`); `POST /notifications/test` sends through the mailer; `POST /nodes` with the fake provider returns 201 `{ node }`; pending returns 202; `POST /nodes/:id/approve|deny`; `DELETE /nodes/:id`.
- [ ] **Step 3: Implement.** Keep provider instances injectable for tests (`setProviderRegistry`). **Step 5: Commit** `feat(compute): HTTP routes and startup wiring`.

### Task A11: The `naught` CLI

**Files:** Create `bin/naught.js` (CommonJS, Node ≥ 18, zero deps); modify `server/services/sessionManager.ts` (`prepareShellShimEnvironment` writes a `naught` shim: `#!/bin/sh` + `ELECTRON_RUN_AS_NODE=1 exec <execPath> <bin/naught.js> "$@"`, resolved from the package root; also an `openui-naught` alias is not needed), `package.json` (`bin.naught`, `files`), test.

- [ ] **Step 1: Tests**: `parseArgs(["node","create","--provider","modal","--gpu","H100","--cpu","4"])` → `{ cmd: "node.create", provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, wait: 600 }`; `--count 2`; unknown flag → usage error; `run(args, { fetch: stub, env: { OPENUI_PORT: "7968", OPENUI_SESSION_ID: "s1" } })` for `node create` POSTs `/api/compute/nodes` with `requestedBy: { kind: "session", sessionId: "s1" }`, then polls `GET /api/compute/nodes/:id` until `ready`, prints JSON `{ id, name, ssh: "ssh -p 22 root@h", home, status }` and exits 0; `pending` → exits 2 with `{ id, status: "pending", reasons }`; `error` → exit 1; `node list|status|terminate|offers`; `session move --to <id>` POSTs `/api/sessions/s1/move`; `--home` POSTs `/home`; no `OPENUI_PORT` → exit 1 with a message naming Naught.
- [ ] **Step 3: Implement.** `main()` only runs when `require.main === module`. Base URL `http://127.0.0.1:${OPENUI_PORT}` (`OPENUI_HOST` override for nodes). Human text on stderr, JSON on stdout.
- [ ] **Step 5: Commit** `feat(cli): naught command for agents (node create/list/status/wait/terminate/offers, session move)`.

## Phase B — remote session fixes (all devboxes)

### Task B1: Instrumented launch

**Files:** Modify `server/services/devboxes.ts`, `server/services/sessionManager.ts` (`createSession`, `relaunchSession`), `server/routes/api.ts`, `server/services/terminalRemote.ts` (`onReady`), `scripts/test-devboxes.mjs`.

- [ ] **Step 1: Tests**: `buildDevboxLaunch(devbox, agentCommand, remotePath, { hooks: { port: 40123, sessionId: "s1" } })` → `{ launch: "ssh 'user@host'", remote: "cd '/w' && export OPENUI_HOST=127.0.0.1 OPENUI_PORT=40123 OPENUI_SESSION_ID='s1' && [ -f ~/.naught/env ] && . ~/.naught/env; exec claude --plugin-dir ~/.naught/claude-code-plugin" }` (plugin-dir only for a `claude` command; `exec $SHELL -l` when no agent command); the legacy `buildDevboxLaunchCommand` still returns the `-t` form (fallback).
- [ ] **Step 3: Implement**: `createSession` gets `remoteCommand?: string` and `devboxLaunch?: { launch, remote, fallback }`. When the shell is up, it types `launch` as the tracked command; `terminalRemoteManager.onReady(sessionId, cb)` fires the typed `remote` command (automation write, submit); on `fallback` or after 6 s without `ready`, it kills the PTY command line (Ctrl-C) and types the legacy `-t` form instead. Extract `relaunchSession(sessionId, overrides?: { command?: string; devboxId?: string; remotePath?: string })` from the restart route (same body) and have the route call it.
- [ ] **Step 5: Commit** `feat(devbox): launch remote agents through the instrumented ssh path`.

### Task B2: Reverse tunnel for hooks

**Files:** Modify `resources/remote-terminal/openui_ssh_wrapper.cjs`, `server/services/terminalRemote.ts`, `server/services/sessionManager.ts` (env `OPENUI_REMOTE_HOOKS_PORT` = server port for devbox sessions), test in `test-devboxes.mjs` for the parser.

- [ ] **Step 1: Tests**: `parseAllocatedPort("Allocated port 43125 for remote forward to 127.0.0.1:6968\n")` → 43125 (export the pure function from the wrapper via `module.exports` when not main); the wrapper's master args contain `-R 0:127.0.0.1:6968` only when `OPENUI_REMOTE_HOOKS_PORT=6968`.
- [ ] **Step 3: Implement**: the master is run with `stdio: ["ignore","pipe","pipe"]`, stderr captured; on success emit `metadata("tunnel", { controlPath, port })`. `terminalRemote.ts` accepts `{ action: "tunnel", controlPath, port }`, stores `session.hookPort`, exposes `hookPort(sessionId)`. The session manager builds the remote command's exports with that port; when absent the exports are omitted (card keeps inferred status).
- [ ] **Step 5: Commit** `feat(devbox): reverse tunnel so remote status hooks reach Naught`.

## Phase C — session move

### Task C1: Manifest tool

**Files:** Create `resources/remote-terminal/naught_manifest.py`, `server/services/move/manifest.ts`; test `scripts/test-move.mjs`.

- [ ] **Step 1: Tests** (temp dirs built with `git init` where needed): the Python tool run with `--root <dir> [--include-ignored]` prints JSON lines `{ "p": relpath, "s": size, "h": sha256, "m": mode }` sorted by path and a final `{ "summary": { "files", "bytes", "hash" } }` where `hash` = sha256 over `p\0h\0` lines; a git repo lists tracked + untracked-not-ignored (`.gitignore`d `node_modules/x` absent unless `--include-ignored`); `.git` itself is listed when `--git-dir` is passed (mother `.git` case, excluding `worktrees/<other>`); a linked worktree's `.git` *file* is included; non-git dir excludes `node_modules`, `.venv`, `venv`, `__pycache__`, `.cache` by default; symlinks are recorded with `"l": target` and not followed. `manifest.ts`: `buildManifest(root, opts)` (local, spawns `python3`), `diffManifests(src, dst)` → `{ changed: string[]; deleted: string[]; bytes }`, `summarize(manifest)`, `manifestRootsFor(session)` → `[cwd]` plus the mother `.git` for a linked worktree (reads the `.git` file `gitdir:` pointer, resolves `commondir`).
- [ ] **Step 3: Implement** (Python ≥ 3.8, stdlib only; `git ls-files -z --cached --others --exclude-standard` when git is available and the root is a work tree, else `os.walk`). **Step 5: Commit** `feat(move): manifest tool and diff`.

### Task C2: Transfer

**Files:** Create `server/services/move/transfer.ts`; test with a local runner that executes the "remote" side with `sh -c` in a second temp dir.

- [ ] **Step 1: Tests**: `syncRoots({ from: local, to: remote, roots, manifests, runRemote, includeIgnored })` streams only changed files (`tar -C / -cf - --null -T -` on the source, `tar -C / -xpf -` on the destination), deletes `deleted` paths on the destination, then re-runs the destination manifest and returns `{ hash, files, bytes }` equal to the source; a destination hash mismatch throws `TransferVerifyError`; path mirroring: destination paths are the same absolute paths; parent directories created with `mkdir -p`.
- [ ] **Step 3: Implement** with an injectable `runRemote(command, { input })` (real: `runOverSsh`); the reverse direction swaps which side runs over ssh (`ssh target 'tar -c …' | tar -x` locally). **Step 5: Commit** `feat(move): tar-over-ssh transfer with verification`.

### Task C3: Harness state

**Files:** Create `server/services/move/harness.ts`; test with fixture transcript files in temp `HOME`s.

- [ ] **Step 1: Tests**: `claudeProjectDirName("/Users/me/proj")` → `-Users-me-proj`; a 250-char path → 200 chars + `-` + 8-char sha256 prefix (document the rule; the test pins our implementation); `findClaudeState({ home, sessionId, cwd })` → `{ transcript, subagentsDir?, todos: string[] }` existing paths only; `findCodexState({ home, cwd, since })` scans `sessions/**/rollout-*.jsonl`, parses only the first line, returns the newest whose `payload.cwd === cwd` and timestamp ≥ `since`, with `{ sessionId, rolloutPath }`; `resumeCommand("claude", id)` → `claude --resume <id>`, codex → `codex resume <id>`, shell → original command; `exitCommand` → `/exit`, `/quit`, `exit`; `remoteHomeRelative(localPath, localHome)` → the path relative to the home dir for re-rooting on the node.
- [ ] **Step 5: Commit** `feat(move): locate Claude and Codex session state`.

### Task C4: The state machine

**Files:** Create `server/services/sessionMove.ts`; modify `server/services/sessionManager.ts` (`relaunchSession` from B1, `waitForIdle(sessionId)`, `waitForPtyExit`), `server/services/agentStatus.ts` (`onStatusCommitted(listener)` called from `commitStatus`), `server/index.ts` (resume in-flight moves after restore); test with injected steps.

- [ ] **Step 1: Tests**: `planMove(session, { nodeId })` returns refusals for: already remote, multi-repo worktree, missing credential for the harness, node not ready, preflight failure; otherwise `{ harness, roots, manifest summary, includeIgnoredExtraBytes }`. `startMove` with injected `{ waitIdle, quiesce, sync, syncAgent, relaunch, verify }` walks `waiting-idle → prepare → quiesce → sync-files → sync-agent → relaunch → verify → done`, persisting `session.move.state` at each step (saveState spy); a failure at `sync-files` leaves `state: "error"` with the message, the session still local, `history` unchanged; `retryMove` resumes from the failed step; `bringHome` runs the reverse and with `conflict: "worktree"` calls `git worktree add` and updates `cwd`; a smaller remote transcript aborts before overwrite; `terminateNode` is called with reason `bring-back` when requested and no other session is attached.
- [ ] **Step 3: Implement** the step runner as a table `{ [state]: async (ctx) => nextState }` so retry is trivial; the real step implementations compose C1–C3, `runOverSsh`, `writeTerminalData` for quiesce, `relaunchSession`, and verification via `onStatusCommitted` (Claude: `SessionStart` hook with the expected id, through `session.claudeSessionId` being set) or lifecycle `at_prompt`.
- [ ] **Step 5: Commit** `feat(move): resumable move / bring-back state machine`.

### Task C5: Move routes and CLI wiring

**Files:** Create `server/routes/move.ts`; modify `server/index.ts`, `bin/naught.js` (already has `session move`; wire the agent-initiated flow: `POST /move` with `afterTurn: true` waits for the next `Stop` hook / idle).

- [ ] **Step 1: Tests** (Hono `app.request` with a stub session): `POST /api/sessions/:id/move/plan`, `POST /move`, `GET /move`, `POST /move/home`, `POST /move/retry`, `POST /move/cancel` status codes and bodies; a move on an unknown session → 404.
- [ ] **Step 5: Commit** `feat(move): routes and agent-initiated moves`.

### Task C6: Docker integration test

**Files:** Create `scripts/test-move-docker.mjs`; `package.json` script `test:move:docker`.

- [ ] **Step 1:** Skips (exit 0, prints `skipped: docker not running`) when `docker info` fails. Otherwise: builds a tiny `sshd` image (`FROM ubuntu:22.04`, `openssh-server python3 git tar`), injects the Naught public key, runs it with `-p 0:22`, registers a manual devbox pointing at it, starts the isolated server (`PORT=7968`, scratch `LAUNCH_CWD`, `node -e 'require(".../dist/electron/server/index.js").startServer()'`), creates a `shell` session in a temp git repo with one commit and one untracked file, `POST /move`, polls `GET /move` until `done`, asserts the repo exists in the container at the same absolute path with both files, writes a new file in the container, `POST /move/home`, asserts the file arrived locally and the session is local again; tears everything down.
- [ ] **Step 5: Commit** `test(move): docker-backed end-to-end move and bring-back`.

## Phase D — client

### Task D1: Nodes hook, live indicator, approval sheet

- [ ] `useComputeNodes.ts`: `useEffect` polling `/api/compute/nodes` every 5 s (and immediately), returns `{ nodes, pending, liveCount, hourlyUsd, refresh }`.
- [ ] `LiveNodesIndicator.tsx`: renders nothing when `liveCount + pending.length === 0`; otherwise a pill `N nodes · $x.xx/hr est.` (+ `· 1 awaiting approval`), click → `setSettingsOpen(true)` with tab `devboxes` (add `settingsTab` to the store). Colours from the status palette (`theme/agentStatus.ts`): `running` for live, `waiting_input` for pending.
- [ ] `ApprovalSheet.tsx`: modal listing each pending node (provider, GPU, size, est. $/hr, reasons, requester session name), Approve / Deny buttons calling the routes; mounted in `App.tsx`.
- [ ] Typecheck, commit `feat(ui): live nodes indicator and approval sheet`.

### Task D2: Settings → Compute

- [ ] `ComputeTab.tsx` with the four sections from the spec, loading `/api/compute/providers|policy|notifications`, saving immediately on change (like Devboxes; the modal's footer treats `compute` like `devboxes`: no Save button), key inputs with `hasKey` placeholders (`••••• set in Naught` / `from ~/.modal.toml`), *Test* with inline result, *Send test email*. Add `{ id: "compute", label: "Compute", icon: Cpu }` to `TABS` after Devboxes.
- [ ] Commit `feat(ui): Settings → Compute`.

### Task D3: Provisioned rows in Devboxes

- [ ] `DevboxesTab.tsx`: `Devbox.source` includes `"provisioned"`, `provision?: ProvisionRecord` (client copy of the type in `client/src/types/compute.ts`); provisioned rows show provider chip, GPU, status chip, uptime (`formatUptime`), est. cost, *Terminate* (confirm inline) instead of *Remove*; a *Provision a node* button opening `NewNodeForm`. Commit `feat(ui): provisioned nodes in Devboxes`.

### Task D4: New node from the session modal

- [ ] `NewNodeForm.tsx`: provider select (configured ones only; otherwise a line linking to Settings → Compute), offer select (from `/api/compute/offers`), count, name; `onSubmit(spec)`. In `NewSessionModal`: Run-on select gets `<option value="__new__">New node…</option>`; when chosen the form shows inline and submit sends `newNode: spec` instead of `devboxId`; a 202 (pending) shows "Waiting for approval" on the card via the existing `creating` state. Commit `feat(ui): provision a node from the new-session modal`.

### Task D5: Session cards and the move sheet

- [ ] Store/App: `AgentSession` gains `devboxId`, `devboxName`, `remotePath`, `move`; `pollStatus` and `restoreServerSessionToCanvas` map them.
- [ ] `AgentNodeCard`: badge `⇡ <devboxName>` when `devboxId`; while `move` is active, a `Moving · <step>` line; on `move.state === "error"`, a red line with Retry.
- [ ] `AgentNodeContextMenu`: *Move to node…* (local) / *Bring back* (remote) above Delete; `index.tsx` opens `MoveSheet` through a store flag `moveSheetFor: { nodeId, direction }`.
- [ ] `MoveSheet.tsx`: calls `/move/plan` on open, renders destination (ready nodes + `NewNodeForm`), conversation line, files summary with the ignored toggle, agent state (`Move when idle` default), credentials line, refusals; *Move*. Bring-back variant: conflict list with the three choices, *terminate node afterwards* checkbox.
- [ ] `CommandPalette`: `Move session to node…` / `Bring session back` for the selected session.
- [ ] Typecheck, commit `feat(ui): move sheet, node badges, context menu entries`.

## Phase E — verification and docs

### Task E1: Full verification

- [ ] `npm run build:electron && npm run build:client` (client: the one baseline error only).
- [ ] `npm run test:compute`, `test:move`, `test:devboxes`, `test:status`, `test:coordinator` → all green; `npm run test:move:docker` → green or skipped with the reason printed.
- [ ] Isolated smoke server (`PORT=7968`, scratch `LAUNCH_CWD`): `GET /api/compute/providers`, `PUT` a fake Thunder token, `GET /api/compute/offers?provider=thunder` returns an error object not a crash (no network in tests → `fetch` to Thunder fails fast and the route returns 502 with the message), `GET /api/compute/nodes` → `[]`.
- [ ] Opt-in live smoke only if `NAUGHT_LIVE_SMOKE=1` and Modal creds resolve: provision CPU sandbox, `claude --version`, `codex --version`, terminate. Record the result in the final report; it is not required for the branch.

### Task E2: Docs

- [ ] `README.md`: a *Compute nodes* section (providers, secrets, policy, emails, the `naught` CLI) and a *Move a session to a node* section; `docs/warp-terminal-parity.md` row for remote hooks. Commit `docs: compute nodes and session move`.

---

## Self-review notes

- Spec coverage: secrets (A1), data model (A2), policy (A3), key (A4), email (A5), providers (A6/A7), bootstrap (A8), orchestrator/ledger/tick/reconcile/approvals (A9), routes (A10), CLI (A11), instrumented launch (B1), reverse tunnel + transcriptPath (B2/A2), manifest/transfer/harness/state machine/routes/docker (C1–C6), every UI surface (D1–D5), tests and live smoke (E1), docs (E2).
- Type names used consistently: `ProvisionRecord`, `ComputeConfig`, `ComputeSpec`, `ComputeOffer`, `SshEndpoint`, `MoveState`, `ManifestSummary`, `relaunchSession`, `runOverSsh`, `ensureNodeAssets`, `requestNode`/`approveNode`/`denyNode`/`terminateNode`/`listNodes`/`waitForNode`, `buildDevboxLaunch`.
