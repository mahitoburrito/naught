# Session move: fork the filesystem to a node and continue the session there

**Date:** 2026-10-12
**Branch:** `feat/compute-nodes-and-session-move`
**Status:** Approved (design reviewed in conversation; remaining choices delegated, see *Decisions taken without asking*)
**Depends on:** `2026-10-12-compute-nodes-design.md` (nodes, bootstrap, `naught` CLI, reverse tunnel)

## Problem

An agent working locally hits a job that needs a GPU, more cores, or a
machine that can stay up overnight. Today the only option is to start a new
session on a devbox and re-explain everything. What is wanted: take the
session as it stands, including the working tree at the directory the agent
was started in and the conversation so far, put it on a node, and carry on
from the same card. And bring it back the same way.

## What already exists

- **Harness session state is on disk and self-contained.** Claude Code keeps
  one append-only `~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl`
  per session; `claude --resume <id>` finds it from any directory, but
  restores the cwd recorded inside it. Codex keeps
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` whose first line
  (`session_meta`) records `id` and `cwd`; `codex resume <uuid>` resumes it.
  Both therefore resume cleanly when the working directory exists **at the
  same absolute path** on the node.
- **The server knows the Claude session id** (`session.claudeSessionId`, set
  by the status hook); after the companion spec it also knows
  `transcriptPath`. Codex has no hook, so its id is found on disk.
- **Restart** (`POST /sessions/:id/restart`) re-spawns a session's PTY in
  place and re-runs its command: the relaunch step is this, with a new
  command and devbox.
- **Devbox launch, instrumented**, and the **reverse tunnel** from the
  companion spec give a remote session file access and authoritative status.
- **Credentials**: Claude on the Mac authenticates from the keychain, which
  no node can read; `~/.codex/auth.json` is a plain file. The companion spec
  stores node credentials and writes them to `~/.naught/env` on the node.

## Scope

In scope: move a local Claude, Codex or shell session to a ready node;
bring it back; agent-initiated moves through `naught session move`; a sheet
that says what will happen and what is copied; a resumable pipeline; the
conflict rule on bring-back; tests.

Out of scope: moving between two nodes (bring back, then move); copying
global harness configuration (`~/.claude/settings.json`, `~/.codex/config.toml`,
MCP servers); multi-repo worktree sessions in the first cut (the sheet
refuses them with a clear message; the mechanism generalises later); Windows.

## Decisions taken without asking

| decision | choice | why |
| --- | --- | --- |
| Transfer mechanism | a manifest diff plus `tar` over ssh, not `rsync` | macOS ships `openrsync` with partial flag support; `tar -T` and `sha256` exist everywhere, and the manifest is needed anyway for the conflict check |
| What is copied by default | tracked files and untracked files not ignored by git; for non-git directories, everything except `node_modules`, `.venv`, `venv`, `__pycache__`, `.cache` | Keeps the first copy small and keeps `.env` files home |
| Ignored files | an *include ignored files* toggle, off, with the extra size shown | Secrets and caches are opt-in |
| Linked git worktree | the mother repo's `.git` directory is copied too (excluding other worktrees' metadata) | The worktree's `.git` file points at it by absolute path; with mirrored paths git just works |
| Harness state copied | Claude: the session's transcript, its subagent directory and its todos; Codex: the rollout file | The documented minimum; nothing that carries machine-local paths |
| Quiesce | `/exit` for Claude, `/quit` for Codex, `exit` for shells; kill the PTY after 10 s | Graceful first; transcripts are already flushed at idle |
| Verify timeout | 60 s | Claude on a cold node takes 10–20 s to print its first prompt |
| Bring-back conflict rule | compare against the move-time manifest; unchanged → sync; changed → sheet with Overwrite / fresh worktree / Cancel | Never silently clobber local edits |
| Node after bring-back | *terminate node* ticked when no other session is attached | Frictionless and matches the spend rule |

## Entry points

- Card context menu: **Move to node…** (local sessions) / **Bring back**
  (sessions on a node). Also in the command palette.
- `naught session move --to <node-id> | --to new:<provider>:<gpu> | --home`
  from inside the session. The CLI knows the session from
  `OPENUI_SESSION_ID`.

A move is refused up front when the session is already on a node (use
*Bring back*), when it is a multi-repo worktree session, when the harness
credential for the node is missing (Claude token / OpenAI key), when the node
is not ready, or when the node's preflight fails.

## The move sheet

Shows, before anything happens:

- **Destination**: a ready node, or *New node…* (the companion spec's inline
  form; the move starts when the node is ready).
- **Conversation**: *Claude Code session `a1b2…` found* / *Codex session
  `01a1…` found* / *Shell: files only*. When the harness is running but its
  session id is unknown (hooks never fired), the sheet says the agent will
  start fresh on the node and asks to confirm.
- **Files**: the path, file count and size for the default set; the toggle
  for ignored files with its extra size; for a linked worktree, the mother
  repo's `.git` size on its own line.
- **Agent state**: Working → "Move when the agent goes idle" (default, the
  server waits) or Cancel. Idle / Needs input → move now.
- **Credentials**: which node credential will be used.

## Pipeline

`server/services/sessionMove.ts`. The state is persisted on the session
(`session.move`) and in the state file so a crash is resumable:

```ts
interface MoveState {
  direction: "out" | "home";
  state: "waiting-idle" | "prepare" | "quiesce" | "sync-files" | "sync-agent" | "relaunch" | "verify" | "done" | "error";
  nodeId: string;
  startedAt: number;
  harness: { kind: "claude"; sessionId: string; transcriptDir: string } | { kind: "codex"; sessionId: string; rolloutPath: string } | { kind: "shell" };
  roots: string[];                     // local absolute paths copied (cwd, plus mother .git)
  manifest?: ManifestSummary;          // tree hash, file count, bytes, taken at the move
  includeIgnored: boolean;
  error?: string;
  history: Array<{ direction; nodeId; at: number; manifestHash: string }>;
}
```

Steps, moving out:

1. **waiting-idle** (optional): subscribe to the status engine; proceed on
   idle or waiting-input.
2. **prepare**: resolve the harness session (Claude from the session record;
   Codex by scanning rollouts whose `session_meta.cwd` equals the session's
   cwd and whose timestamp is after the session's `createdAt`, newest wins).
   Build the manifest with `naught_manifest.py` locally (path, size, mtime,
   sha256; git-aware listing when `.git` is present). Preflight the node:
   `testDevbox`, `python3`, `tar`, the harness CLI, free disk ≥ 2× the copy.
3. **quiesce**: type the exit command through `writeTerminalData`; wait for
   the PTY exit; kill after 10 s. The card shows *Moving…* with the step name.
4. **sync-files**: run the manifest on the node for the same roots (empty on
   a first move); diff; stream changed files with `tar -C / -T - | ssh …
   tar -C / -x`; delete remote extras inside the roots; re-run the remote
   manifest and require equal tree hashes.
5. **sync-agent**: Claude: copy `~/.claude/projects/<escaped>/<id>.jsonl`,
   `<id>/` (subagents) if present, and `~/.claude/todos/<id>*` to the same
   relative paths under the node user's home. Codex: the rollout file to its
   same relative path. Codex auth when the opt-in is on. Sizes are small; the
   same tar stream carries them.
6. **relaunch**: set `devboxId`, `remotePath = cwd`, and the command: Claude
   `claude --resume <id>`, Codex `codex resume <id>`, shells keep theirs. Run
   the restart path, which uses the instrumented bare-ssh launch and types
   `cd <cwd> && . ~/.naught/env && exec <command>`.
7. **verify**: Claude: a `SessionStart` hook for the same session id within
   60 s. Codex and shell: the lifecycle reaches *at_prompt* within 60 s. On
   failure: `state = error`, the terminal tail is attached, nothing local is
   touched, the card offers *Retry* and *Move back*.

Nothing in the local working tree is modified or deleted by a move out.

Bringing home runs the same steps with source and destination swapped, plus:

- **conflict check** before sync-files: the local manifest is compared to
  the move-time manifest. Equal → continue. Different → the sheet lists the
  files that differ and offers **Overwrite local**, **Bring back into a new
  worktree** (git repos only: `git worktree add <repo>-worktrees/<branch>-from-<node>`,
  then the session's cwd becomes that path), or **Cancel**.
- Transcripts come back by overwrite: the node's file is a strict superset
  because the local harness was stopped before the move. A size check guards
  the assumption; a smaller remote file aborts with an error rather than
  truncating.
- After relaunch and verify, *terminate node* (from the sheet) calls the
  companion spec's terminate with reason `bring-back`.

## Agent-initiated moves

`naught session move` posts the request with the session id. The server
answers immediately (`accepted`, with the plan: destination, files, harness)
and the CLI prints "This session will be relaunched on <node> after this
turn; your next turn resumes there." The server waits for that session's
`Stop` hook (Claude) or idle (Codex, shell) and then runs the pipeline. The
agent's own conversation shows the move as a normal gap between turns.

Because bootstrap ships the `naught` CLI to nodes and the reverse tunnel
makes the IDE reachable, a remote agent can run `naught session move --home`
or request another node.

## Surfaces

Routes under `/api/sessions/:sessionId/move`:

| route | purpose |
| --- | --- |
| `POST /plan` | dry run: harness found, manifest summary, preflight, refusals |
| `POST /` | start (body: `nodeId` or `new`, `includeIgnored`, `whenIdle`) |
| `POST /home` | bring back (body: `conflict: "overwrite" \| "worktree"`, `terminateNode`) |
| `GET /` | state |
| `POST /retry`, `POST /cancel` | from the error state |

`AgentSession` (client) gains `devboxId`, `remotePath` (already on the server
record), and `move`. The card shows the step while moving and a node badge
after; the context menu swaps *Move to node…* for *Bring back*.

## Components

| unit | responsibility |
| --- | --- |
| `resources/remote-terminal/naught_manifest.py` | manifest (git-aware), used locally and on nodes |
| `server/services/move/manifest.ts` | run the manifest, diff, summaries |
| `server/services/move/transfer.ts` | tar-over-ssh streaming, deletes, verification |
| `server/services/move/harness.ts` | find Claude/Codex session state, paths on both sides, resume commands |
| `server/services/sessionMove.ts` | the state machine, persistence, resume on startup |
| `server/routes/move.ts` | routes |
| `client/src/components/move/MoveSheet.tsx` | the sheet (both directions) |
| `AgentNodeContextMenu`, `AgentNodeCard`, `CommandPalette` | entries and badges |
| `bin/naught.js` | `session move` |

## Testing

- `scripts/test-move.mjs` (`npm run test:move`): manifest listing for a
  normal repo, a linked worktree (mother `.git` included, sibling worktrees
  excluded), a non-git directory (default excludes), and the ignored toggle;
  diff and delete computation; Codex rollout resolution against fixture
  files; Claude path escaping (including the 200-character hash case);
  state-machine transitions with injected failures at every step (nothing
  local changes on failure; retry resumes at the failed step); conflict
  detection on bring-back.
- Integration, Docker-backed (`scripts/test-move-docker.mjs`, skipped when
  Docker is not running): an `sshd` container with the Naught public key
  stands in for a node; a shell session is created on the isolated smoke
  server (port 7968, scratch `LAUNCH_CWD`), moved, verified to be at a
  prompt in the container, edited there, and brought back with the change
  present locally.
- The live smoke from the companion spec gains a move-out / bring-back of a
  shell session on a CPU Modal sandbox.

## Risks

- **Transcript formats are undocumented** for both harnesses. The move
  never edits them; it only copies files whole. Path mirroring is what makes
  that enough. If a harness changes where it keeps state, `harness.ts` is
  the one place to update.
- **A worktree's mother `.git` can be large.** The sheet shows the size
  before the move; subsequent syncs are incremental.
- **Quiesce races the transcript flush.** Idle is required before quiesce,
  and the verify step catches a broken resume before the local session is
  considered gone (the local files are untouched regardless).
- **Clock skew** between Mac and node is irrelevant to the diff, which uses
  size and content hash, not mtime.
