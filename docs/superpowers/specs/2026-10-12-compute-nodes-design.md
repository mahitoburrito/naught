# Compute nodes: provision a node or GPU from the IDE

**Date:** 2026-10-12
**Branch:** `feat/compute-nodes-and-session-move`
**Status:** Approved (design reviewed in conversation; remaining choices delegated, see *Decisions taken without asking*)
**Companion spec:** `2026-10-12-session-move-design.md` (moving a session onto a node and back)

The product is **Naught** (the GitHub repo was renamed from `openui-desktop`
on 2026-09-21). Every *new* user-facing surface in this spec carries the new
name. Existing identifiers (`openui-control`, `OPENUI_*` env, `.openui-desktop`
state dir, 51 files) are left alone; a rename pass is separate work.

## Problem

A session that needs a GPU, or just a bigger machine, has no way to get one.
Devboxes (PR #21) let a session run on a box that already exists, but the box
has to be provisioned by hand, outside the app, with a provider CLI the agent
cannot drive. The team's compute lives on Modal (credits) and Thunder Compute
(credits); neither is reachable from Naught today.

Two things are wanted:

1. A human or an agent can say *"give me an H100"* and get a node that Naught
   sessions can run on, with the provider key stored once as a secret.
2. Spend is impossible to forget: policy caps, an approval gate above the
   caps, and email the moment billing starts and while nodes stay up.

## What already exists

- **Devboxes** (`server/services/devboxes.ts`, `routes/devboxes.ts`,
  `settings/DevboxesTab.tsx`, the *Run on* selector in `NewSessionModal`).
  A devbox is a name plus ssh details; `buildSshTarget` turns it into ssh
  arguments and `buildDevboxLaunchCommand` wraps the agent command. A
  provisioned node is exactly a devbox whose details were filled in by code.
- **Secrets** live in `${LAUNCH_CWD}/.openui-desktop/.env` as plain
  `KEY="value"` lines (Linear, Gemini, PRBE keys). `updateEnvValue` in
  `titleGenerator.ts` and `saveEnvFile` in `linear.ts` both edit that file;
  the API only ever returns `hasApiKey`.
- **The remote protocol** (`openui_ssh_wrapper.cjs`, `terminalRemote.ts`)
  instruments a *bare* `ssh <host>` typed in a session: remote file reads,
  patches, completions, git. It passes anything with a remote command or `-t`
  through untouched, which is what the devbox launch shape uses, so devbox
  sessions today are plain terminals with inferred status.
- **The control CLI** (`bin/openui-control.js`) talks to the running app over
  a private unix socket; every session has a private shim directory first on
  PATH (`prepareShellShimEnvironment`).
- **Status hooks** (`claude-code-plugin/hooks/status-reporter.sh`) POST to
  `OPENUI_HOST:OPENUI_PORT/api/status-update`. The server binds 127.0.0.1, so
  a hook on a remote box cannot reach it.

## Scope

In scope: provider keys as secrets; a provider interface with Modal and
Thunder Compute implementations; provisioning, lifecycle and reconciliation;
policy with auto-approval and an approval sheet; billing emails via Resend;
the `naught` CLI for agents; Settings → Compute; provisioned rows in
Devboxes; *New node…* in the Run-on selector; a live-nodes indicator; and
two fixes to remote sessions (instrumented launch, reverse tunnel for hooks)
that every devbox benefits from.

Out of scope: renaming existing identifiers; other providers (the interface
is one file per provider, nothing else changes); Modal volumes or snapshots as
a persistence layer; Windows (the shim directory is already POSIX-only).

## Decisions taken without asking

The user delegated the remaining choices ("make decisions that would make the
most sense for a frictionless experience"). These are the ones that were not
settled in conversation:

| decision | choice | why |
| --- | --- | --- |
| Policy defaults | 2 concurrent nodes, any GPU, 8 h max lifetime with auto-terminate, $5/hr per node | One H100 on Modal is $3.95/hr; anything multi-GPU goes to the approval sheet |
| Recipient address default | `git config --global user.email` | The only address the machine knows; shown and editable in Settings |
| Sender address default | `Naught <support@prbe.ai>` | prbe.ai is already verified on the team's Resend account |
| Modal base image | `ubuntu:22.04`, or `nvidia/cuda:12.4.0-devel-ubuntu22.04` when a GPU is requested | Matches the SDK's own examples; Modal caches the built image |
| Thunder template default | `ubuntu-22.04`, with the live template list offered | The documented example value |
| Node user | whatever the provider gives (`root` on Modal, `ubuntu` on Thunder) | Fighting it buys nothing |
| SSH key | a Naught-owned ed25519 keypair, generated once | Never touch the user's personal keys; one revocation point |
| Idle | no attached session has had PTY input or output for 60 min | The data the status engine already has |
| Where provider calls run | in the server process via the official `modal` npm SDK and plain `fetch` for Thunder | No Python, no CLI installs; Electron 41 ships Node ≥ 22 which the SDK requires |
| Secrets file | the existing `.env`, plaintext | Consistent with every other key the app stores; moving to `safeStorage` is a separate change for all keys at once |

## Secrets and settings

Keys are written with one shared helper, `server/services/secrets.ts`
(`updateEnvValue` moves there from `titleGenerator.ts`; `linear.ts` keeps its
own save path untouched). Keys and their environment names:

| secret | env name | detected from |
| --- | --- | --- |
| Modal token | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | `~/.modal.toml` active profile (the SDK reads it natively) |
| Thunder token | `TNR_API_TOKEN` | `~/.thunder/token` |
| Resend key | `RESEND_API_KEY` | – |
| Claude token for nodes | `CLAUDE_CODE_OAUTH_TOKEN` | – (`claude setup-token` prints it) |
| OpenAI key for nodes | `OPENAI_API_KEY` | – |

Resolution order for a provider: the value set in Naught, then the process
environment, then the detected file. Settings shows which one is in effect
("set in Naught" / "from ~/.modal.toml"). The API returns `hasKey` and
`source`, never the value.

Provider keys never leave this machine. Node credentials (the last two rows,
plus `~/.codex/auth.json` when the opt-in is on) are the only secrets copied
to a node, written to `~/.naught/env` (mode 0600) during bootstrap and sourced
by the launch command.

**Settings → Compute** (new tab, between Devboxes and Appearance), four
sections:

- **Providers**: one row per provider with the key field(s), a *Test* button
  (Modal: list sandboxes in the `naught` app; Thunder: `GET /instances/list`),
  the detected-from badge, and a *Remove* for keys set in Naught.
- **Policy**: max concurrent nodes, allowed GPU classes (checkbox list fed by
  the providers' offers, default all), max lifetime hours (auto-terminate),
  max $/hr per node. Requests inside the caps go through; anything else waits
  in the approval sheet.
- **Notifications**: Resend key, *to* address (default from git), *from*
  address, reminder interval (default 4 h), idle alert (default 60 min), a
  *Send test email* button. Empty *to* means no email and the section says so
  in red text; nothing else is blocked.
- **Node credentials**: Claude token, OpenAI key, "sync `~/.codex/auth.json`
  to nodes" toggle (off). A one-line explanation that nodes cannot reach the
  Mac's keychain, which is why these exist.

Settings and policy persist in the app config (`LinearConfig.compute`, the
misnamed config object every other setting lives in); keys go to `.env`.

## Data model

`DevboxConfig.source` gains `"provisioned"`, and a provisioned box carries:

```ts
interface ProvisionRecord {
  provider: "modal" | "thunder";
  instanceId: string;            // sandbox id or Thunder uuid
  gpu?: string;                  // provider's identifier, e.g. "H100", "A10G"
  gpuCount: number;              // 0 for CPU-only
  cpu: number;
  memoryGb: number;
  diskGb?: number;               // Thunder only
  image?: string;                // Modal: image tag; Thunder: template id
  status: "pending" | "provisioning" | "ready" | "terminating" | "terminated" | "error";
  requestedBy: { kind: "user" } | { kind: "session"; sessionId: string };
  requestedAt: number;
  startedAt?: number;            // billing start = provider reports ready
  readyAt?: number;              // bootstrap finished
  terminatedAt?: number;
  terminateReason?: "user" | "agent" | "max-lifetime" | "provider" | "bring-back";
  hourlyUsd: number;             // estimate shown everywhere with "est."
  maxLifetimeHours: number;      // snapshot of policy at request time
  lastActivityAt: number;        // newest PTY I/O across attached sessions
  emails: { started?: number; reminderCount: number; lastReminderAt?: number; idleAlertAt?: number; terminated?: number };
  error?: string;
}
```

The provider fills `host`, `user`, `port`, `identityFile` on the devbox (so
`buildSshTarget` and every consumer work unchanged) and `defaultPath` with the
node user's home. `inSshConfig` is always false for provisioned boxes.

Policy and notification settings:

```ts
interface ComputeConfig {
  policy: { maxConcurrentNodes: number; allowedGpus: string[] | "any"; maxLifetimeHours: number; maxHourlyUsd: number };
  notifications: { to?: string; from: string; reminderHours: number; idleAlertMinutes: number };
  nodeCredentials: { syncCodexAuth: boolean };
}
```

The Naught keypair lives at `${LAUNCH_CWD}/.openui-desktop/keys/naught_ed25519`
(0600) and `.pub`, generated with `ssh-keygen -t ed25519 -N ""` on first use.

## Providers

`server/services/compute/provider.ts`:

```ts
interface ComputeOffer { provider; gpu?: string; gpuCount: number; cpu: number; memoryGb: number; diskGb?: number; image?: string; hourlyUsd: number; available?: boolean; label: string }
interface ComputeSpec  { provider; gpu?: string; gpuCount: number; cpu: number; memoryGb: number; diskGb?: number; image?: string; name: string; maxLifetimeHours: number }
interface SshEndpoint  { host: string; port: number; user: string }

interface ComputeProvider {
  id: "modal" | "thunder";
  configured(): Promise<{ ok: boolean; source?: "naught" | "env" | "detected"; detail?: string }>;
  offers(): Promise<ComputeOffer[]>;
  provision(spec: ComputeSpec, publicKey: string): Promise<{ instanceId: string }>;
  waitReady(instanceId: string, signal: AbortSignal): Promise<SshEndpoint>;
  status(instanceId: string): Promise<"provisioning" | "ready" | "terminated" | "error">;
  terminate(instanceId: string): Promise<void>;
  estimateHourlyUsd(spec: ComputeSpec): number;
}
```

**Modal** (`compute/modal.ts`, npm `modal`): one app `naught`
(`apps.fromName("naught", { createIfMissing: true })`). The image is the base
above plus `openssh-server git rsync curl ca-certificates python3 nodejs
npm`, the Claude installer (`curl -fsSL https://claude.ai/install.sh | bash`),
`npm i -g @openai/codex`, `mkdir /run/sshd`, and the Naught public key in
`/root/.ssh/authorized_keys`. The sandbox runs `/usr/sbin/sshd -D -e` with
`unencryptedPorts: [22]`, `gpu`, `cpu`, `memoryMb`, `timeoutMs` from the
lifetime cap, and `name` set to the node name. `waitReady` polls
`sb.tunnels()` until port 22 reports a host and port, then waits for a TCP
accept. `status` uses `sb.poll()`. Offers are a static table of the GPU
classes the SDK accepts (T4, L4, A10G, L40S, A100-40GB, A100-80GB, H100, H200,
B200) with hourly estimates from Modal's public price list plus the sandbox
CPU and memory rates; a CPU-only offer is included.

**Thunder Compute** (`compute/thunder.ts`, `fetch` against
`https://api.thundercompute.com:8443/v1`, bearer token):
`POST /instances/create { num_gpus, gpu_type, cpu_cores, disk_size_gb,
template, public_key }` returns `uuid` and `identifier`; `waitReady` polls
`GET /instances/list` until the entry reports a running status with `ip` and
`port`, then TCP-probes it; user is `ubuntu`; `DELETE /instances/{id}`
terminates. Offers come from `GET /v2/specs` joined with `GET /v2/pricing`
and `GET /thunder-templates`, cached for ten minutes. Thunder has no stop
API, so *stop* is not offered for either provider: a node is live or gone.

## Orchestrator

`server/services/compute/nodes.ts` owns the request lifecycle:

```
request ─► policy ─┬─ inside caps ──────────────┐
                   └─ outside ─► pending approval ┤ approve
                                                  ▼
                              provision ─► waitReady ─► bootstrap ─► ready
                                     │ any failure
                                     ▼
                                   error (provider terminate attempted, no devbox left behind)
```

- **policy** evaluates concurrent live nodes, the GPU class, the lifetime and
  the hourly estimate; it returns `allowed` or a list of reasons. Reasons are
  shown on the approval sheet and returned to the CLI.
- **bootstrap** runs over the real ssh with the Naught key: creates
  `~/.naught/`, writes `env` from node credentials, confirms `rsync`,
  `python3`, `claude` and `codex` are present (installing the two CLIs when
  missing, which is the Thunder case), copies the `naught` CLI and the status
  plugin to `~/.naught/`, and records versions on the devbox.
- **ledger**: `startedAt` is set when the provider reports ready, because
  that is when the provider starts billing; the UI shows elapsed time and
  `hourlyUsd × elapsed` as *est. cost*.
- **tick** (every 60 s): refreshes `lastActivityAt` from attached sessions,
  sends reminders and idle alerts, terminates nodes past `maxLifetimeHours`,
  and polls provider status for live nodes so a sandbox that timed out on the
  provider side shows *terminated* within a minute.
- **reconcile** on startup: every provisioned devbox is checked against its
  provider; gone ones are marked terminated (with the *terminated* email),
  live ones resume their ledger and timers.
- **approvals**: pending requests are persisted with the devbox record so a
  restart does not lose them; approve runs the pipeline, deny marks the record
  `terminated` with reason `user` and the CLI gets `denied`.

Attached sessions are those with `devboxId` equal to the node's id. A node is
idle when none of them has had PTY input or output for `idleAlertMinutes`.

## Email

`server/services/compute/notify.ts` posts to `https://api.resend.com/emails`
with `Idempotency-Key: naught-<nodeId>-<event>` where event is `started`,
`reminder-<n>`, `idle-<n>` or `terminated`, so a restart within Resend's
24-hour window cannot double-send. Each mail names the node, provider, GPU,
when billing started, uptime, est. cost so far, the sessions attached, and
how to stop it (Settings → Devboxes, or `naught node terminate <id>`). A
failed send is logged and retried on the next tick; it never blocks a
provision.

## The `naught` CLI

`bin/naught.js`, placed in every session's shim directory and shipped to
nodes during bootstrap. It talks HTTP to `http://127.0.0.1:${OPENUI_PORT}`
(on a node, the reverse tunnel below makes that address reach the IDE) and
sends `OPENUI_SESSION_ID` as the requester. Output is JSON on stdout, human
text on stderr, exit code 0/1/2 (ok / denied-or-error / pending).

```
naught node offers [--provider modal|thunder]
naught node create --provider modal --gpu H100 [--count 1] [--cpu 4] [--memory 16] [--name x] [--wait 600]
naught node list
naught node status <id>
naught node wait <id> [--timeout 600]
naught node terminate <id>
naught session move --to <node-id|new:<provider>:<gpu>> | --home     (companion spec)
```

`create` blocks until the node is ready (prints the ssh target, the node's
home path and the devbox id), or exits 2 with the request id when the policy
parked it for approval; `wait` resumes blocking. The agent can then
`ssh <target>` itself (instrumented) or start a session on it through the UI.

## Surfaces

Routes, all under `/api/compute`:

| route | purpose |
| --- | --- |
| `GET /providers`, `PUT /providers/:id/key`, `DELETE /providers/:id/key`, `POST /providers/:id/test` | keys and tests |
| `GET /offers?provider=` | offers (cached) |
| `GET /nodes`, `POST /nodes`, `GET /nodes/:id`, `DELETE /nodes/:id` | request, list, inspect, terminate |
| `POST /nodes/:id/approve`, `POST /nodes/:id/deny` | approval sheet |
| `GET /policy`, `PUT /policy`, `GET /notifications`, `PUT /notifications`, `POST /notifications/test` | settings |

Every node change broadcasts a `compute:nodes` WebSocket message with the
full list so all surfaces update at once.

UI:

- **Settings → Compute**, described above.
- **Devboxes tab**: provisioned rows show a provider chip, GPU, status chip
  (the agent-status palette's colours, see `theme/agentStatus.ts`), uptime,
  est. cost, and *Terminate* (confirm). No edit; details come from the
  provider.
- **New-session modal, Run on**: a *New node…* entry that expands an inline
  form (provider, GPU class, count, cpu/memory preset, name) and provisions on
  *Create session*; the session is created once the node is ready, with the
  modal showing progress and the provisioning error inline if it fails.
- **Approval sheet**: a modal that opens when a request is parked, listing
  provider, spec, est. $/hr, the policy reasons, and who asked (session name).
  Approve / Deny. Pending count also shows on the live-nodes indicator.
- **Live-nodes indicator**: in the header, right of the title, visible
  whenever a node is live or pending: `2 nodes · $6.45/hr est.`; click opens
  Settings → Devboxes. Per PRODUCT.md, consequential state is never a toast.
- **Session card**: a devbox session already shows `box:/path`; provisioned
  nodes show the provider icon too.

## Remote session fixes

Both apply to every devbox, provisioned or not.

**Instrumented launch.** `buildDevboxLaunchCommand` returns the bare
`ssh <target>` so the shim instruments it, and the session manager types
`cd <path> && exec <agent command>` once the remote shell is ready (the
remote-terminal manager emits `ready`; fall back to a 3 s delay when the
instrumentation bypassed). Remote file reads, diffs, completions and git then
work for devbox sessions. The old shape stays as the fallback when the shim is
unavailable (Windows, missing python3 on the box).

**Reverse tunnel for hooks.** When a session has a `devboxId`, the shim adds
`-R 0:127.0.0.1:${OPENUI_PORT}` to the control master and reads the allocated
remote port from ssh's output; the typed launch command exports
`OPENUI_HOST=127.0.0.1 OPENUI_PORT=<allocated> OPENUI_SESSION_ID=<id>` and
`--plugin-dir ~/.naught/claude-code-plugin` for Claude. Remote cards get
authoritative status, the agent's session id and transcript path, which the
companion spec needs. `/api/status-update` also stores `transcriptPath` on
the session (the hook already sends it).

## Components

| unit | responsibility |
| --- | --- |
| `server/services/secrets.ts` | `.env` read/update, key resolution with source |
| `server/services/compute/provider.ts` | interfaces, offer and spec types |
| `server/services/compute/modal.ts`, `thunder.ts` | provider implementations |
| `server/services/compute/policy.ts` | pure policy evaluation |
| `server/services/compute/sshKeys.ts` | the Naught keypair |
| `server/services/compute/bootstrap.ts` | node preparation over ssh |
| `server/services/compute/nodes.ts` | orchestrator, ledger, tick, reconcile, approvals |
| `server/services/compute/notify.ts` | Resend mail |
| `server/routes/compute.ts` | the routes |
| `bin/naught.js` | the CLI |
| `client/src/components/settings/ComputeTab.tsx` | Settings tab |
| `client/src/components/compute/ApprovalSheet.tsx`, `LiveNodesIndicator.tsx`, `NewNodeForm.tsx` | UI pieces |
| `DevboxesTab`, `NewSessionModal`, `Header`, `AgentNodeCard` | edits |

## Testing

- `scripts/test-compute.mjs` (`npm run test:compute`, same runner style as
  `test-devboxes.mjs`): policy evaluation (every cap, combinations), offer
  parsing from recorded Thunder responses, Modal spec to SDK options mapping,
  hourly estimates, ledger and tick behaviour with a fake clock (start,
  reminders at 4 h, idle at 60 min, auto-terminate at the cap, no duplicate
  emails after a simulated restart), idempotency keys, CLI argument parsing
  and exit codes, `buildDevboxLaunchCommand` for the instrumented shape.
- Provider HTTP is behind a `fetch` injection point and the Modal client
  behind a factory, so tests never touch the network.
- `test:devboxes`, `test:status`, `test:coordinator`, `build:electron`,
  `build:client` stay green (one pre-existing client tsc error in
  `PRBEPanel.tsx` is the known baseline).
- Opt-in live smoke `scripts/smoke-compute-live.mjs`, gated on
  `NAUGHT_LIVE_SMOKE=1`: provisions a CPU-only Modal sandbox, connects over
  ssh, runs `claude --version` and `codex --version`, terminates. Spends
  cents of credits, never runs in CI.

## Risks

- **Provider API drift.** Thunder's REST shapes come from their docs with no
  example payloads; the parser is defensive and the Test button is the
  cheapest way to find out. Modal's SDK is 0.x; the dependency is pinned.
- **A node outliving the app.** If Naught quits with nodes live, nothing
  terminates them. Mitigations: the reminder emails keep going as soon as
  the app is back, reconcile on start, and the provider-side lifetime
  (`timeoutMs` on Modal) is the hard stop. A quit-with-live-nodes dialog is a
  cheap follow-up.
- **Plaintext secrets.** Same posture as every existing key; called out, not
  changed here.
- **`-R` port allocation.** Parsing ssh's "Allocated port N" line is the one
  brittle piece of the reverse tunnel; when it cannot be parsed the launch
  proceeds without hooks and the card says *inferred status*, which is today's
  behaviour.
