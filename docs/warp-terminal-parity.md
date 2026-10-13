# Warp capability parity for OpenUI

This is the implementation ledger for bringing Warp's strongest terminal and
agent-workbench behavior into OpenUI without turning OpenUI into a visual clone.
OpenUI remains an agent command center with an infinite canvas; Warp is the
behavioral reference for terminal semantics, resilience, and workflow speed.

## Source and license boundary

- Upstream reference: <https://github.com/warpdotdev/warp>
- Latest clean-room behavior audit: Warp commit `a01df387ae5697f05d08ac180a081e9e60b7200c`
  (2026-07-11).
- Product behavior: <https://docs.warp.dev/>
- Warp's `warpui_core` and `warpui` crates are MIT licensed.
- The rest of Warp's client is AGPL-3.0. OpenUI is MIT licensed, so terminal
  behavior is being reimplemented from public protocols, documentation, and
  observed invariants. AGPL implementation code is not copied into OpenUI.
- Warp's hosted model routing, billing, and conversation orchestration are not
  in the client repository. Equivalent OpenUI behavior must use OpenUI-owned or
  provider APIs rather than pretending the open-source client contains it.

## Capability matrix

| Area | Warp behavior to preserve | OpenUI baseline | Status / proof |
|---|---|---|---|
| Semantic command blocks | Command, output, cwd, timing, exit status, selection, copy, rerun, bookmark | Raw xterm byte stream | Foundation implemented in `terminalLifecycle.ts`; persisted block history and APIs added. Focus Mode now opens a full-pane semantic block view while keeping xterm mounted underneath for full-screen and protocol correctness. Bounded plain-text snapshots strip destructive controls, compact redraw frames, cap per-block DOM output, and paginate up to the persisted 250-block limit. Blocks expose live status, command, output, cwd, duration, exit code, shell depth, notes, bookmarks, filtering, sticky headers, keyboard traversal, insert, run-or-queue, command/output copy, and server-redacted Markdown copy with explicit sensitive confirmation. Active CLI-agent `CSI 2 J` frame redraws replace obsolete primary-screen frames even when the sequence is chunk-split, while later ordinary shell blocks preserve clear-style history. Exit classification follows Warp's non-error cases: Ctrl-C is `interrupted`, benign SIGPIPE/pager closure (141) is successful, and Windows control-C is interrupted. Failed blocks carry a stable reason: Warp-compatible command-not-found for 127/9009, conventional POSIX not-executable for 126, or a conservative generic exit error. |
| Shell integration | Structured prompt, command-start, completion, cwd events | Login shell only | OSC 133/633 parser plus zsh, Bash, fish, and PowerShell adapters implemented. Each instrumented shell now has a process-local epoch ID and explicit exit marker. Automatic nested zsh/Bash tests pass on macOS, and automatic nested zsh/Bash/fish plus PowerShell 7.6.3 tests pass in clean Linux ARM64. The fixtures deliberately let user startup files move system paths ahead of OpenUI's private shim, then verify that the adapter safely restores process-local ordering. Mutable shell-defined completion names refresh after prompts only when their sanitized payload changes; empty updates remove deleted names while stable builtins and keywords remain bootstrap-only. A missing or non-executable `$SHELL` now follows Warp's executable-aware fallback strategy instead of creating an asynchronously dead PTY; OpenUI tries zsh, Bash, fish, then a portable raw `/bin/sh`. Bash and PowerShell reconcile authoritative command text only when their monotonic history ID advances, so `HISTCONTROL`, `HISTIGNORE`, duplicate suppression, and PSReadLine filters cannot rename a block to a stale command. Authoritative command metadata removes OSC terminators but preserves literal newlines, while the lifecycle boundary canonicalizes PTY CRLF back to LF. Existing zsh preexec/precmd/exit hooks, Bash array or string `PROMPT_COMMAND` plus DEBUG/EXIT traps, and Fish preexec/postexec/posterror/exit handlers remain installed. OpenUI and user prompt hooks observe the original command status; Fish parser errors synthesize the otherwise missing command lifecycle through `fish_posterror`. Once an authenticated epoch exists, bare prompt markers from async prompt frameworks or nested shells cannot close an executing block or erase typeahead; current-epoch markers retain conservative recovery authority. PowerShell conservatively emits unknown when its exit event exposes no status. |
| Lifecycle recovery | Duplicate, missing, stale, split, and out-of-order shell evidence cannot corrupt blocks | No semantic state | Conservative state machine implemented and smoke-tested for split OSC, duplicate start/finish, prompt-without-finish, cwd URL, and terminal exit. |
| Terminal find | Non-blocking command/output search, partial results, regex/case modes, selected-block scope, stable traversal, live-output invalidation, stale-query cancellation, filtered-row exclusion | Synchronous history substring filter | Background worker service and versioned long-poll API implemented. It scans bounded blocks in newest/oldest order, returns partial snapshots, preserves exact counts while bounding details, supports command/output/note/cwd and selected-block scopes, cancels superseded client queries, rescans live blocks, strips unsafe terminal controls from excerpts, and kills pathological regex workers on timeout. Callers may provide bounded, validated per-block hidden output-line ranges; the worker excludes those rows before both exact counting and retained-match selection. Replacing visibility live immediately clears affected stale results and rescans only the changed blocks, so newly visible rows return without restarting the search. Closing a search clears its results. Focus Mode now exposes a pane-scoped, non-blocking find rail with case/regex toggles, live counts, bounded excerpts, block identity, and command reinsertion. Direct xterm-row highlighting and next/previous viewport focus remain. |
| Focused terminal workbench | Terminal is the primary task surface with session navigation, pane context, keyboard-first tools, split layouts, and auxiliary panels | Canvas header remained visible above a thin Focus Mode toolbar; session state and terminal tools were scattered | Focus Mode now replaces canvas chrome with a macOS titlebar-safe session strip, active-state indicators, add-session picker, browser preview, layout controls, and shortcuts. Each pane presents agent status, cwd, branch, tool activity, offline recovery, maximize, and close actions around an unframed xterm surface. A contextual rail switches between live find, command history, and FIFO queue without taking terminal input away. Cmd+P now opens one vertically and horizontally centered Command Center over the active terminal. It unifies commands, cross-session history, saved commands, paths, sessions, parameter entry, and saved-command management while keeping terminal context visible behind a restrained scrim. Single-pane, two-pane, in-flight queue, find results, history, and 900 px window states were rendered from the live client with no console errors. Inactive canvas controls are hidden from assistive technology while Focus Mode owns the window. |
| Terminal transport | Bounded PTY/input transport, resize coalescing, slow/dead-client isolation, reconnect | Unbounded JSON messages and direct WebSocket sends | WebSocket path and 128 KiB frame limits, strict text message schemas, 64 KiB input chunks, a 4 MiB/s input budget, 16 ms last-value resize coalescing, a 16 MiB outbound queue ceiling, heartbeat termination, and send-error isolation are implemented. Cached xterm instances reconnect with capped exponential backoff after transient/slow-client closes and reset before replay; protocol-policy closes do not loop. |
| Inline images | SIXEL and iTerm2 inline image (IIP) output rendered in the terminal grid | Image sequences discarded, printing garbage | `@xterm/addon-image` loaded before `open()` so its parser hooks cover the first byte of output. Budgets are tightened from the addon defaults because they are per terminal and this app keeps one alive per opened session: 8 MB image store, 2048x2048 decode limit, 4 MB per sequence. The decode limit is deliberately below the store limit, since the storage evictor admits an over-sized image once it has nothing left to evict. The addon enables the CSI 14/16/18 t size reports so programs can size their output; those replies travel on the allowlisted `terminalResponse` transport, not the user-input path. Verified end to end through a live PTY: a SIXEL band and a scaled IIP PNG both decode into an `xterm-image-layer` canvas. |
| Renderer | GPU-accelerated grid rendering with a safe fallback | xterm DOM renderer only | `@xterm/addon-webgl` with automatic fallback: a lost context disposes the addon, returns the terminal to the DOM renderer, and retries GPU once before staying on DOM for the session. Activation failure (no WebGL2) falls through the same path. Contexts follow what is on screen rather than creation order: a terminal claims one when a pane attaches and gives it back when its last pane detaches, and at most 4 are held at once, well under Chromium's per-renderer ceiling. Cached terminals preserve separate normal/alternate-buffer viewport anchors across pane moves, fits, and reconnect replay. Bottom-pinned views follow output, manual scroll positions remain stable, Chromium's reparented scroll element is explicitly resynchronized with xterm's logical buffer, and a settled full-row refresh prevents blank overview cards. |
| Terminal replies | Emulator answers to a program's query are not user input | DSR/CPR and DA replies were sent on the user-input path | xterm fires `coreService.onUserInput` immediately before `onData` and only for real typing, so replies are separated by provenance rather than by matching their bytes, which covers DSR/CPR, DA1/2/3, DECRQM, XTSMGRAPHICS and the CSI t size reports at once. They are sent on `terminalResponse`, whose server allowlist admits only digits, separators and a known final, so a program cannot smuggle text or a newline into the tty through its own query. This also stops a reply from being attributed to the user server-side, where `lastInputTime` cancels a pending agent fallback chain. |
| Terminal geometry | New PTYs start at the size they will be read at | Every PTY spawned at 80x24 until the first client resize | Spawn geometry is remembered from the geometry clients report, as a high-water mark rather than last-writer-wins (a client sends its pre-fit 80x24 the moment its socket opens, and spawning too wide only costs a re-wrap while spawning too narrow bakes hard line breaks into the buffer). Seeded at startup from persisted session geometry so the first session of a launch is not stuck at the default. Fits are skipped for panes below a usable size, because FitAddon proposes a 2x1 grid for a zero-sized box, which reflows the scrollback and repaints a full-screen TUI into two columns. |
| OSC 52 clipboard policy | Explicit deny, write-only, and read/write access with deny as the safe default | No explicit clipboard policy on live PTY output | Implemented without a visible UI change. `OPENUI_OSC52_CLIPBOARD_ACCESS` accepts only `deny`, `write_only`, or `read_write`; missing and unknown values fail closed to deny. A chunk-safe, 64 KiB-bounded server parser recognizes ESC and C1 OSC/ST forms before live broadcast, preserves unrelated OSC, drops malformed or oversized clipboard controls, and strips every OSC 52 operation from semantic blocks and persisted scrollback even when renderer access is allowed. The xterm handler accepts only `c`, `p`, or `s`, strict standard base64, fatal UTF-8, and bounded clipboard data. Read replies use a separately validated, history-neutral `terminalResponse` transport rather than user input. Clipboard permission failures fail closed. |
| Safe hyperlinks and browser navigation | Browser URL state accepts only HTTP(S); terminal links cannot invoke arbitrary privileged protocols | Popup URLs reached Electron `shell.openExternal` without a main-process allowlist, and embedded pages could navigate or open arbitrary schemes | Implemented at the privileged Electron boundary without a visible UI change. One pure policy canonicalizes and permits only fully qualified HTTP(S), rejects credentials, raw backslashes, C0/C1/DEL controls, malformed or missing hosts, relative/protocol-relative locations, non-string IPC payloads, and inputs or canonical URLs over 8,192 characters. The main app denies cross-origin top-frame navigation and validates every popup before `shell.openExternal`; the embedded browser applies the same policy to IPC locations, redirects, popups, and its external fallback. User-entered domains default to HTTPS while localhost, IPv4, and bracketed IPv6 default to HTTP. |
| Secure local control | Typed allowlisted CLI actions, owner-only discovery, deterministic multi-instance selection, browser/network isolation, stable errors | Unauthenticated HTTP API on an unspecified listen interface; no instance discovery or control CLI | Second backend slice implemented as an OpenUI-native adaptation of Warp Control. The ordinary app server binds only `127.0.0.1`, rejects non-loopback Host headers and non-local browser origins, emits no permissive CORS policy, and applies the same origin gate to terminal WebSockets. A separate versioned 64 KiB NDJSON protocol uses a mode-0600 Unix socket inside a mode-0700 per-user directory, so its transport is the same-user authority boundary and discovery contains no bearer credential. Records are channel/version/process scoped, bounded, owner-only, stale-pruned, path-confined, and removed on exit. The typed 32-action catalog now covers instance/app/action/capability discovery; bounded session list/inspect/create/activate/reopen; and runtime tab/pane list, inspect, create/split, activate/focus/navigate, move/resize, maximize/restore, rename/reset, and close. Structural mutations share the persisted workspace revision model, serialize through one control queue, return created pane identity, canonicalize cwd, and retain authoritative canvas sessions across view close. `openui-control` exposes every implemented route with deterministic explicit instance selection. Terminal command execution, prompt submission, staged input, file content, arbitrary dispatch, and unsupported action families remain excluded. The CLI is bundled for macOS/Linux; Windows and `OPENUI_DISABLE_LOCAL_CONTROL=1` fail closed. Warp's remaining 84-action catalog families and protected Scripting settings UI remain. |
| PTY write coordination | Preserve transaction order across user input, commands, bootstrap, and in-band automation; pace large writes through proxy PTYs | Independent direct `node-pty.write` calls | One bounded writer now owns every live PTY. It serializes all user, command, shell-integration, rerun, upload, and automation transactions; splits them into UTF-8-safe 4 KiB chunks; applies minimal pacing to multi-chunk writes and 50 ms pacing while an SSH/container proxy command is active; rejects more than 2 MiB of queued input; and discards stale queues on exit, restart, or deletion. Programmatic text observes chunk-split terminal mode `?2004`, wraps the body only while bracketed paste is enabled, and keeps Enter outside the wrapper. Initial multiline launches wait for the shell's observed bracketed-paste readiness instead of racing a fixed startup delay. Delayed startup automation is generation-bound and cannot target a restarted PTY. Real PTY tests prove both a 51 KiB paste followed immediately by EOF and a multiline injected command arrive without truncation, interleaving, or accidental multiple submission. |
| Terminal mode lifecycle | Structured alternate-screen, editor, mouse, focus, cursor-key, and synchronized-output modes with conservative cleanup | Regexes for individual `?47`/`?1047`/`?1049` and `?2004` controls | A bounded incremental VT parser now accepts split ESC and C1 CSI forms plus batched DECSET/DECRST parameters. It tracks application cursor keys, mutually exclusive click/drag/all-motion mouse modes, focus reporting, mutually exclusive UTF-8/SGR mouse encodings, alternate scroll, alternate screen, bracketed paste, and synchronized output. OSC/DCS/SOS/PM/APC payloads are parsed as control strings, so embedded CSI-looking bytes cannot forge mode state. Command completion, prompt recovery, shell-epoch transitions, restart, and exit clear command-owned state before a shell may freshly re-advertise editor modes. Current mode state is exposed in lifecycle snapshots/history export; xterm.js remains responsible for rendering and device input. |
| Kitty keyboard protocol | Progressive key disambiguation, report-all/alternate/text/event flags, bounded push/pop state, and query replies | Regex query/push/pop plus modified Enter only; unbounded shared stack | A chunk-safe renderer parser now handles ESC and C1 CSI query, set/replace/union/difference, push, and counted-pop commands; flags are truncated to the five defined bits, CSI capture is capped at 128 characters, and each primary/alternate-screen stack is capped at Warp's 4,096 entries. Alternate-screen entry starts isolated flags and exit restores primary flags. OSC/DCS/SOS/PM/APC payloads cannot forge negotiation. Query replies use the separately allowlisted history-neutral terminal-response path (`0..31`) instead of user input. Negotiated encoding covers ambiguous Escape/modifier/control keys, report-all printable/control/F13-F35 keys, shifted alternate keys, associated text, repeat/release events, and standalone modifiers. Shift+Enter honors Kitty before OpenUI's multiline shortcut; IME/dead keys and macOS Option composition pass through. Windows consumes negotiation without activation or replies because ConPTY cannot safely forward it. Reconnect replay resets and reconstructs protocol state. |
| Queued terminal commands | Queue shell commands behind active work, preserve strict FIFO, and advance on the dispatched command's completion | Busy programmatic execution was rejected | Backend implemented as a bounded runtime-only per-session queue with list/add/edit/reorder/delete/clear APIs. Pending commands preserve exact text, one command is in flight at a time, and only its exact semantic block ID may release the next item. A long-running command holds later work; nonzero exit still advances; pending additions stay at the tail; running items are immutable; dispatch failure rolls back only before any block starts; and partial writes are never replayed automatically. PTY exit/replacement, restart, hard/soft deletion, and session loss discard stale queued work. Focus Mode now exposes the active immutable item, numbered pending work, multiline add with Cmd/Ctrl-Enter, reorder, remove, and clear controls in a non-modal rail. Cloud-agent conversation routing and a shared shell/prompt submission editor remain out of scope. |
| Git subprocess environment | Git, Git hooks, and companion tools use the user's interactive login-shell PATH regardless of Finder/Dock launch | Server-inherited PATH and several interpolated Git command strings | Backend implemented. The first Git operation lazily captures only `PATH` from the preferred zsh/Bash/Fish/PowerShell environment, deduplicates concurrent capture, and caches by shell/home/inherited environment. Nonce sentinels isolate PATH from startup banners; Unix capture starts detached with no stdin; time, output, value length, and cache count are bounded; a failed capture without valid markers falls open to the inherited PATH. Every worktree, scan, diff, checkpoint, discard, patch-apply, fetch, stash, and commit Git subprocess receives the captured environment. Git is always invoked with fixed argv; worktree branch names pass `git check-ref-format` and are expanded to explicit local/remote refs before use. Hooks can therefore find Homebrew/MacPorts/Nix/asdf tools without exposing or caching the rest of the shell environment. |
| Session Git status and operations | Repository status, review diffs, commit/push/PR chains, and GitHub metadata work identically on local and SSH-backed sessions | Local path-based diff/checkpoint helpers; no remote review or mutation surface | Backend implemented from Warp's remote Git status/operations specs. Session status resolves the repository on the active host, parses NUL-delimited porcelain and numstat data without shell quoting assumptions, reports branch/main/upstream/ahead/behind, bounded file stats, and up to 50 unpushed commits with file lists. Session diffs, whole-file/hunk/all discard, commit-only, commit-and-push, commit-and-create-PR, standalone push, and PR create/view share one fixed-argv local/SSH runner. Branches pass `git check-ref-format`; paths remain repository-confined; hooks, Git LFS, and `gh` receive the active shell PATH; read output, time, files, commits, messages, and metadata are bounded. Mutations serialize per session/repository, reject merge/cherry-pick/revert/rebase state, and return a fresh post-operation snapshot. A reconnecting/fallback remote epoch returns unavailable and never touches a coincident local repository. |
| Command history/search | Search previous commands and workflows from the terminal without exposing detected credentials | Session titles only | Cross-session searchable history, redacted JSON/NDJSON export, and confirmed retention clearing are implemented. Secret detection is quote-aware across shell assignments, dotenv/JSON fields, semantic flags, common short credential flags, userinfo and authorization headers, provider-token formats, URI passwords, and multiline private keys. Password-prompt keystrokes are never captured while a command executes. Control-normalized text is rescanned before persistence/search/share, and bounded in-memory raw replay/known-secret state is discarded at PTY epoch end. Running blocks are immutable and bookmarks are protected by default. Focus Mode exposes per-session filtering and a unified Cmd+P surface that ranks cross-session history beside workflows and live completions. Enter inserts and Cmd+Enter executes through the semantic queue. |
| Block actions | Copy command/output, re-input, execute, bookmark, share | Terminal selection only | Re-input/execute/queue and bookmark/note APIs are implemented. The semantic block view exposes click, Command-click, Shift-click, Shift-arrow, and Command-A selection plus command/output copy, insert, run-or-queue, bookmark, note, and server-generated redacted Markdown copy. Command-Shift-S or the header action opens a pane-adjacent share sheet for the exact selection or entire session, with Markdown/plain-text/JSON formats, output inclusion, safe-SGR JSON, a capped DOM preview, full bounded copy/download, and explicit sensitive-history confirmation. Sensitive replay is never stored in the queue. External publication remains. |
| Input editor | IDE-style multiline editing, selections, cursor movement, syntax awareness | Shell/readline or TUI owns input | Shell-owned editing remains authoritative. The lifecycle tracker handles chunk-split bracketed-paste input markers, multiline paste as one command, terminal mode `?2004` enable/disable, Unicode backspace, CRLF, and opaque cursor/history escapes without fabricating command text. Typed zsh/Bash heredocs, Fish grammar continuations, and PowerShell here-strings retain exact canonical newlines in one semantic block. Bash PS2 and PSReadLine continuation prompts carry invisible epoch markers so physical lines can be appended without treating stdin to a running program as command history; stale/missing markers fail closed. Commands, reruns, uploads, and agent automation use the advertised paste mode so multiline content remains one edit; a separate IDE-style editor is not started. |
| File and image attachments | Paste or drop local context into the active agent input with visible attachment state | File drop paths only; macOS clipboard screenshots could arrive without renderer `File` items | Implemented for live local sessions. File drops and pasted PNG/JPEG/GIF/WebP/SVG images are saved under the session cwd in `.openui-uploads`, with 20-file and 50 MiB-per-file bounds plus executable/package extension blocking. Saved paths enter the same serialized, bracketed-paste-aware PTY writer as other programmatic input, without an automatic Enter, and the UI confirms whether the path was actually inserted. Renderer clipboard `File` items are preferred; Electron adds a native macOS clipboard fallback that converts TIFF/PNG clipboard images to a bounded PNG IPC payload when Chromium exposes no file. Candidate persistence can now be isolated with `OPENUI_DATA_DIR` independently of the real `LAUNCH_CWD`, so QA data does not force new sessions into a temporary working directory. |
| Completions | History, filesystem, command/signature, and workflow suggestions | Shell-native completion | Provider backend implemented for actions, workflows, history, sessions, filesystem paths, live shell PATH executables, static shell builtins/keywords, live aliases/functions/fish abbreviations/variable names, and structured command signatures with fuzzy ranking. Mutable names plus bounded `PATH`/`PATHEXT` execution context are recaptured after every prompt with shell-native primitives, but unchanged payloads produce no PTY metadata or lifecycle broadcast. Bash and zsh also publish bounded changed-only `CDPATH`; `cd` completion preserves its shell order, exact pwd insertion point, relative and home-relative roots, first display-token occurrence, directory-only filtering, and explicit-token bypasses. Fish and PowerShell retain ordinary cwd-relative directory completion because Warp does not publish CDPATH for those adapters. Top-level routing follows Warp: path-like fragments are file-only, `$` fragments are variable-only, and ordinary single tokens include commands plus cwd directories only when the active shell supports autocd. Bash and zsh track their live `autocd` option, Fish is always enabled, and PowerShell is disabled; matching commands always precede directory suggestions, files remain excluded, and directory symlinks are followed once for classification. Signature lookup now uses a bounded span-preserving parser instead of whitespace splitting: it respects POSIX backslash and PowerShell backtick escaping, single/double and unfinished quotes, separators only outside quoted/escaped text, leading POSIX environment assignments, and the last open `$()`/backtick command. Logical fragments drive matching while replacements retain original offsets and existing quote/escape style. Terminal variadic positionals and option arguments repeat with Warp-style stop-at-next-option behavior, `--flag=value` is self-contained, combined short switches extend in place, exact multi-character options win over cluster parsing, and `--` disables later option/subcommand interpretation. Discovery is bounded, PATH-order preserving, cached, executable-filtered, PATHEXT-aware, and never executes candidates or returns general environment values, alias bodies, function bodies, or package-script bodies. Empty and relative PATH entries resolve against the terminal cwd; the private OpenUI child-shell shim is removed before executable metadata leaves the server. A bounded registry supplies nested subcommands, flags, typed file/folder/CDPATH arguments, package scripts, and worktree-aware loose/packed Git refs for `cd`, `pushd`, Git, npm/pnpm/Yarn, Bun, Docker/Compose, kubectl, and GitHub CLI. Cursor-relevant Docker/Compose and kubectl arguments resolve live images, containers, services, contexts, namespaces, resource types/names, pods, and containers through bounded fixed-argv subprocesses while preserving typed scope flags. Instrumented SSH sessions run the same PATH, file/folder/CDPATH, package-script, Git-ref, Docker, and kubectl providers on the remote host over one persistent command channel; local PATH, environment, and filesystem providers are disabled for that epoch. It preserves Warp's completed-token/deepest-subcommand/flag-argument lookup semantics without loading or executing third-party completion generators. Editor UI, broader cloud-provider resources, and arbitrary third-party generators remain. |
| Global command palette | Search actions, workflows, sessions, launch configs, files, settings | OpenUI action palette | Typed suggestion prefixes (`actions:`, `saved:`, `workflows:`, `history:`, `sessions:`, `files:`, `commands:`, `variables:` and short aliases) are implemented server-side and exposed through the Focus Mode Cmd+P Command Center. Terminal-safe actions, session navigation, saved commands, and the saved-layout editor are live there; the existing global app palette remains separate for canvas-level actions. The Command Center provides visible All/Saved/History/Paths/Sessions filters plus persistent arrow, Enter, Cmd+Enter, and Escape guidance. Settings routing still needs dedicated UI ownership. |
| Tabs and split panes | Nested splits, focus navigation, resize, zoom, close recovery, latest-cwd pane creation | Canvas nodes and focus mode | Runtime backend implemented without replacing canvas ownership. A versioned, owner-only persisted workspace maps each live session into at most one pane; tabs hold bounded nested horizontal/vertical trees with stable node IDs, normalized weights, same-axis split flattening, cross-tree moves, directional focus, zoom, tab activation/rename, and optimistic revision conflicts. Pane/tab close collapses unary branches and restores adjacent focus while retaining the authoritative canvas session; a bounded runtime undo restores the exact tree, and a persisted detached-session set prevents read/restart reconciliation from resurrecting deliberately closed views. Session hard deletion removes references; soft-delete/undo preserves the exact tab; corrupt current state falls back to the prior atomic generation. New split sessions inherit the latest shell-native cwd, but an active SSH child uses the retained local root because OpenUI cannot safely reinterpret a remote path as local. The split/tab renderer and direct canvas affordances remain. |
| Launch configurations / saved layouts | Persist reusable tabs with nested panes, cwd, focus, startup commands, shell/agent type, and portable configuration files | Persistent canvas positions | Implemented end to end. The backend provides versioned configurations, nested split validation, active-session mapping, atomic rollback, best-effort mode, positions, multi-session launch, plain-shell panes, native YAML round trips, and Warp-compatible nested-pane YAML import/export. A successful launch materializes the validated layout into the runtime workspace; best-effort failures prune missing panes and collapse unary branches, while atomic failure leaves neither sessions nor pane references. Warp windows/tabs are explicitly flattened into one OpenUI focus layout with a warning. Focus Mode now provides a searchable inline saved-layout library and full editor beside the active PTY: capture the current tab, create/update/delete, edit pane refs/types/names/directories/commands/prompts/workflow bindings, choose initial focus, rotate nested splits, reorder leaves, reset to row/column layouts, validate absolute directories and exact layout membership, choose atomic or best effort with persistent policy copy, import conflict-aware OpenUI/Warp YAML, export either format, protect unsaved changes, and keep launch success/partial-failure feedback visible. The editor is available from the toolbar, `Ctrl+Cmd+L`, and Cmd+P. Current Warp now recommends Tab Configs over legacy Launch Configurations; OpenUI retains the launch API for compatibility while adopting the durable Tab Config interaction model. URL deep links, default-layout assignment, top-level launch parameters, shell executable selection, and worktree templates remain. |
| Workflows | Parameterized searchable commands, dynamic arguments, repo/local scope | Launch prompt templates | Implemented end to end and presented as Saved Commands. The backend provides CRUD, placeholders, hyphenated arguments, static and explicitly confirmed/bounded dynamic options, required/default/option validation, optional shell quoting, global/workspace scopes, sensitive-parameter launch gating, and Warp-compatible YAML import/export. Cmd+P searches saved commands and advances in place to parameter inputs with a debounced server-rendered command preview. The complete searchable library and editor now live inside the centered Command Center rather than a separate right rail; Cmd+Shift+R opens that same surface directly. It retains search and scope filters, command-driven `{{argument}}` discovery, parameter renaming that preserves placeholders, text/static/dynamic value policy, sensitive and shell-quote controls, shell applicability, attribution, unsaved-change protection, create/update/delete, selected/all export, conflict-aware import, and insert or run-or-queue execution. Dynamic option commands remain explicit and use the bounded redacted server contract. |
| Session restoration | Restore scrollback, layout, metadata, and disconnected state safely | Raw output buffer and session nodes | Backend restoration is implemented with versioned state/scrollback/block envelopes plus a versioned runtime tab/split workspace, mode-0600 atomic writes and prior-generation fallback, bounded and redacted inert-text replay, deduplicated semantic history, running-to-interrupted recovery, current cwd, validated shell launch metadata, terminal size, disconnected state, legacy-buffer migration, orphan cleanup, and pane reconciliation against restored sessions. Unversioned and v1 state, JSON/text scrollback, and block arrays migrate atomically to v2 after semantic validation. Unsupported explicit versions fail closed, may read a compatible backup, remain byte-for-byte intact, and place that file under a write guard so a downgraded build's autosave cannot destroy newer data. Removing the incompatible current file explicitly releases the guard. A real SIGTERM/restart/WebSocket test proves completed history, stable workspace tab identity, and safe missing-cwd fallback. Live-process reattachment is intentionally unavailable. |
| Remote shells | SSH/subshell integration and return-to-local lifecycle epochs | Ordinary PTY bytes | Subshell epochs are implemented: a child suspends its launcher block, child commands retain shell/cwd/depth provenance, exit restores the parent, missing exit evidence recovers from the next parent event, and stale child events are ignored. Ordinary interactive zsh/Bash/fish children are automatically instrumented through private per-session PATH shims; PowerShell uses a process-local native function, including on Windows. Plain interactive `ssh target` now follows Warp's remote-server shape: a guarded private shim establishes one authenticated ControlMaster, transfers content-addressed Python and zsh/Bash/fish adapters without editing dotfiles, preflights the remote shell, launches it as a nested lifecycle epoch, and gives the server one long-lived length-framed command channel. Requests are correlated, fixed-argv, timeout/output bounded, abortable, and generation-scoped; spontaneous channel loss gets two delayed reconnect attempts and re-handshake. Control metadata carries a process-local 256-bit token, socket paths must remain inside the session's mode-0700 directory, and sensitive local wrapper variables are removed before OpenSSH can forward environment. Version/help/config, remote-command, stdio-forwarding, noninteractive, and user-ControlMaster invocations bypass byte-for-byte at argv boundaries. Missing Python 3.8, unsupported remote shells, install/check failures, and master failures fall back to ordinary SSH without blocking the session. A second private wrapper now recognizes unambiguous interactive Docker/Podman `exec` and `run` plus `kubectl exec --` launches whose exact command is bash, zsh, or fish. It preserves every user flag/target as argv, injects only fixed shell bootstrap arguments, strips local control authority, and falls through unchanged for unknown options, missing `-it`, extra shell arguments, unsupported shells, or ambiguous kubectl targets. Bash uses an in-memory rcfile, zsh uses and removes a private temporary `ZDOTDIR`, and fish uses its native init command. A third argv-preserving wrapper covers Warp's remaining built-in environment subshell families: `poetry shell`, `pipenv shell`, `aws-vault exec`, and single-token-option `flox activate`. It changes only `$SHELL`, and only to an owner-only OpenUI shim for a supported current shell; all other calls preserve the original shell environment. User-added environment-subshell commands and per-invocation deny rules now load from a versioned owner-controlled file and match bounded tokenized argv with exact or prefix semantics plus a one-token wildcard. Deny wins; no user string becomes shell source or a backtracking regex. Current Warp does not recognize `sudo -s`, tmux, or screen as built-in subshell commands, and its tmux SSH wrapper is deprecated. A GUI editor for the custom rules remains. |
| Agent file context and patches | Agent tools read batches of local or remote files through one contract and apply diffs without assuming the remote tree is locally mounted | A legacy local single-file read route; no session/SSH abstraction | Backend implemented from Warp APP-3790. Session reads accept up to 32 files, optional line ranges, independent per-file and aggregate byte ceilings, explicit UTF-8/binary handling, metadata, truncation, and structured per-file failures. Lexical traversal and realpath/symlink escape are denied. Instrumented SSH uses a native cancellable `read_files` request on the persistent remote server; a reconnecting or failed remote epoch never falls through to the local filesystem. Patch validation/application shares one local/SSH service, caps input at 256 KiB, obtains NUL-delimited affected-path metadata with fixed-argv `git apply --numstat`, confines every current/previous path, runs `git apply --check` before mutation, supports validate-only, edits, creation, and deletion, and returns conflicts without partial client-side emulation. HTTP session endpoints are smoke-tested end to end. |
| Agent profiles | Persisted model/system/tools/skills/MCP configuration | Static agent list | Full desktop UI and backend implemented. Profile management is a separate top-level workbench, deliberately kept out of New Session: a searchable three-pane library covers identity, runtime, access, immutable version history, and an exact launch-contract preview. Saving creates a new version, historical versions are read-only and roll back by promotion, archive is explicitly permanent, and unsaved drafts are guarded. New Session remains a compact agent picker and silently submits the selected profile's explicit version, so later edits cannot alter a live session. Backend proof remains: latest or pinned references, provenance, local fallback, secret rejection, provider-neutral runtime manifests/environment, Claude and Codex adapters, tool enforcement, and permission audit. Current Warp profile behavior reference: <https://docs.warp.dev/agent-platform/capabilities/agent-profiles-permissions>. |
| Model routing/fallback | Responsive, efficient, complexity-adaptive, open-weight routes and provider fallback | Agent CLI chooses its provider | Local profile command fallback is operational and preserves failed/fallback blocks. Quality/cost/complexity model routing is still not started; it requires a real inference backend and is not available in Warp's client source. |
| Permissions and approvals | Observable tool calls, safe approval/denial, queued prompts | Claude hook status and coordinator dialogs | Profile permission policy, tool allowlist, and MCP boundary now have a complete editor plus pre-launch summary. Pinned policy is enforced through Claude's structured `PreToolUse` denial contract; allowed calls retain the provider's normal approval flow. Denied/provider-flow events are bounded, persisted, and queryable per session. A live per-session permission-audit viewer and a non-Claude hook adapter remain. |
| Sharing/collaboration | Share formatted blocks and sessions | No terminal sharing | Local sharing is implemented end to end. The block workbench supports ordered multi-block selection and a non-modal side sheet for selection/session scope, Markdown/text/JSON format, output inclusion, safe-SGR JSON, server-generated preview, copy, and download. The API validates up to 250 explicit block IDs without silently widening scope. OSC/DCS controls (including clipboard writes) are stripped, redraw controls are flattened, payload sizes are bounded, secrets are rescanned, and sensitive history requires explicit confirmation before generating a redacted preview. The UI persistently states that the operation is local-only and server-redacted. No external publication service is implied or contacted; team permalinks and collaboration still require a real external service. |
| Accessibility | Keyboard-first navigation, contrast, zoom, reduced motion, screen-reader semantics | Partial keyboard shortcuts and themes | The terminal command surface uses combobox/listbox/option semantics, active-descendant selection, complete arrow/Enter/Escape handling, reduced-motion fallbacks, visible focus, and persistent key guidance. A whole-app audit remains. |

The completion matrix's earlier “Editor UI remains” note is superseded by the
Focus Mode `TerminalCommandSearch` implementation. It consumes the normalized
query returned by `/api/terminal/suggestions`, so provider prefixes never shift
signature replacement spans. The remaining completion gaps are broader cloud
resources and arbitrary third-party generators, not the terminal search UI.

## Lifecycle invariants

These are non-negotiable because most block bugs are state bugs, not rendering
bugs. They are derived from Warp's public lifecycle recovery specification in
`specs/REMOTE-1973/TECH.md` and implemented independently.

1. Shell metadata can be split across arbitrary PTY chunks.
2. Duplicate command-start and command-finished evidence is idempotent.
3. A prompt arriving without completion closes a running block as `unknown`;
   OpenUI never invents exit code 0.
4. A new command cannot overwrite preserved output from an unfinished command.
5. Terminal exit closes a running block and never leaves it permanently active.
6. A late exit or output callback from a replaced PTY cannot disconnect or
   mutate the replacement PTY.
7. Malformed or unbounded OSC input cannot hold the renderer hostage.
8. Semantic sequences never leak into user-visible terminal output.
9. Block count and per-block output are bounded; truncation is explicit.
10. Restored history is data only. Runtime parser state starts a fresh epoch.
11. A child shell cannot overwrite its parent launcher block; it owns a bounded
    epoch whose commands carry shell, cwd, and nesting-depth provenance.
12. A delayed event from a stale child epoch cannot mutate the restored parent.
    If the child exit marker is lost, the next immediate-parent event closes any
    running child command as interrupted before parent processing resumes.
13. A completed-only snapshot is valid; restoration never assumes the last
    block is active. Any actually running block becomes `interrupted`.
14. Corrupt current-generation state, scrollback, or blocks falls back to the
    prior fsynced generation. Duplicate IDs/sequences and oversized fields are
    discarded or bounded before entering runtime state.
15. Restored scrollback is flattened to inert text before WebSocket replay, so
    OSC/DCS clipboard, title, and device-control payloads cannot execute again.
16. Restart reuses the last shell-native cwd, shell/args, and terminal size when
    valid; a missing cwd or executable falls back to a safe local default.
17. One malformed, oversized, stalled, or disconnected WebSocket client cannot
    crash the server or grow its input/output queues without bound.
18. Resize bursts are last-value coalesced before reaching the PTY. The stored
    dimensions update immediately, and stale timers cannot resize a deleted PTY.
19. Full-screen redraw compaction belongs only to the active CLI-agent block;
    it never becomes a session-wide mode that changes later shell `clear`
    history.
20. Every producer writes through one per-PTY FIFO. A command, paste, upload,
    shell bootstrap, rerun, or automation prompt cannot interleave its chunks
    with another transaction.
21. PTY input chunks never split a UTF-8 code point. Queued bytes are bounded,
    overflow is rejected explicitly, and one failed transaction cannot poison
    later accepted writes.
22. Restart, exit, and deletion dispose the old writer. No delayed chunk from
    an old generation can reach a replacement PTY.
23. Programmatic multiline text is wrapped only when the active terminal has
    advertised bracketed-paste mode. The submit byte is outside the wrapper,
    so embedded newlines remain one edit and exactly one submission occurs.
24. Startup prompts and other delayed automation retain the PTY generation
    that scheduled them. A timer from an exited process cannot inject into a
    restarted replacement that happens to reuse the same session ID.
25. Persistence, search, and share redaction runs on the same control-normalized
    text that will be stored, indexed, or emitted. ANSI editing/style controls
    cannot split a secret during scanning and have it reassemble in a downstream
    consumer.
26. Shell history is authoritative only when its entry ID advances. A command
    deliberately omitted by Bash or PowerShell history keeps conservative PTY
    input evidence; an older history row can never overwrite the new block.
27. User interruption and benign pipe closure are not generic failures. Exit
    130 and Windows `STATUS_CONTROL_C_EXIT` are interrupted; 141 is successful;
    the raw exit code is preserved and other nonzero codes still fail.
28. Failure detail is derived from trusted status and raw exit code, not output
    text. Exit 127/9009 is `command_not_found`, exit 126 is `not_executable`,
    and every other failed completion is `exit_error`. Non-failed and recovered
    interrupted blocks never retain a stale failure reason.
29. A new or restored POSIX session never trusts a shell path merely because it
    is configured. The executable must exist and be runnable; otherwise OpenUI
    selects the first usable zsh, Bash, fish, or portable sh fallback. If none
    exists, session creation fails explicitly instead of returning a dead PTY.
30. OpenUI shell adapters emit literal command history, while unannounced
    OSC 133/633 producers may use VS Code escapes. The lifecycle decodes only
    the latter, so a literal `\\n` is never changed into a line break. When Bash
    exposes just one physical history line for a known multiline submission,
    that fragment may confirm completion but cannot discard the tracked command.
31. Command discovery never runs a candidate. It scans bounded PATH directories
    and entries, accepts only executable files (or Windows PATHEXT members),
    preserves the first PATH occurrence, deduplicates platform-appropriately,
    and caches by platform/PATH/PATHEXT under a bounded TTL and entry count.
32. Environment completion exposes syntactically valid names only, never values.
    A top-level `$` fragment cannot leak unrelated provider results, and a
    path-like fragment cannot be polluted by commands, actions, or history.
33. Live shell completion context is name-only and epoch-scoped. Each adapter
    emits at most 512 validated names per category in a roughly 6 KiB marker;
    alias definitions, function bodies, abbreviation expansions, variable
    values, control characters, and OpenUI-owned integration names never cross
    the PTY metadata boundary.
34. A nested shell begins with an empty completion context, so parent aliases or
    functions cannot appear active in the child. Child exit restores the exact
    suspended parent context; stale epochs, PTY restart, and terminal exit clear
    or reject context rather than merging generations. Completion context is
    runtime-only and is not written into session snapshots.
35. A signature token is eligible as a subcommand only after trailing
    whitespace confirms it. Lookup selects the deepest completed subcommand,
    skips flags before it, and consumes each recognized flag's required
    arguments so an argument that happens to equal a subcommand is not
    misclassified.
36. Command signatures are bounded inert data. Registry depth, root count,
    child count, names, and option names are validated; lookup never invokes a
    command, help process, shell script, JavaScript callback, or network source.
    Used non-repeatable options are suppressed, repeatable options remain, and
    `--option=value` completion preserves the option prefix.
37. Package-script completion shares the task manifest parser but returns names
    and generic descriptions only. `package.json` is capped at 1 MiB and 512
    safe script names; malformed, oversized, non-string, unsafe-name, and
    symlinked manifests yield no completion data. Script command bodies never
    enter the suggestion response or cache.
38. Git completion reads metadata directly and never launches `git`. Loose refs,
    `packed-refs`, linked-worktree `.git` pointers, and `commondir` are bounded;
    ref symlinks, symbolic remote `HEAD`, control characters, lock names, and
    invalid ref sequences are rejected. A two-second, 32-entry cache bounds
    repeat traversal without persisting repository metadata.
39. Signature arguments explicitly declare file, folder, manifest, or Git-ref
    templates. Filesystem enumeration is capped at 500 entries, respects hidden
    fragments, does not recurse through symlinks, distinguishes files from
    folders, and marks whitespace-bearing replacements as requiring shell
    quoting instead of silently claiming they are safe raw tokens.
40. Alias, function, fish-abbreviation, and exported-variable name sets are
    recomputed after prompts with shell-native primitives. Adapters compare the
    bounded sanitized payload before emitting, including an empty changed
    payload for deletion; builtins and keywords remain bootstrap-only. The
    lifecycle independently treats an identical repeated category as
    idempotent, and refresh work cannot replace the exit status captured at
    prompt entry.
41. `PATH` and `PATHEXT` are the only shell environment values allowed into
    executable-discovery context. They are sanitized, capped at 12,000 characters,
    changed-only, epoch-scoped, and never persisted or returned wholesale.
    Empty and relative PATH segments resolve from the terminal cwd, cache keys
    include cwd, and OpenUI's private shell-shim directory is removed before
    executable paths reach suggestion metadata. A stale child, restart, or exit
    cannot retain or overwrite the active epoch's execution context.
42. `CDPATH` is the only additional shell environment value admitted, and only
    Bash and zsh adapters emit it to match Warp's bootstrap contract. It shares
    the 12,000-character, changed-only, epoch-scoped, runtime-only lifecycle.
    Completion uses at most 64 entries in shell order; empty or `.` entries
    insert pwd at their exact position once, relative entries resolve from pwd,
    `~/` entries resolve from home, and pwd is appended only when not already
    inserted. The first display-token occurrence wins, only directories are
    returned, and `/`, `~`, `./`, `../`, `.`, and `..` navigation bypasses
    CDPATH. Values never enter snapshots or suggestion responses.
43. Autocd is a dedicated boolean capability, not a general shell-option dump.
    Bash and zsh recompute it after prompts and emit only changed `0`/`1`
    values; Fish is always enabled and PowerShell is disabled, matching Warp's
    shell model. The capability is epoch-scoped and runtime-only: malformed or
    stale markers are rejected, a child begins from its own shell default,
    parent exit restores the exact suspended value, and restart/termination
    clears it. Top-level command completion appends at most 500 sorted cwd
    directories after every matching command, follows directory symlinks only
    for classification, preserves hidden-entry rules and quoting metadata, and
    never admits ordinary files. Explicit path and variable routing is unchanged.
44. Signature input parsing is inert and capped at 64,000 characters. It keeps
    original UTF-16 replacement offsets while decoding logical tokens, treats
    `|`, `||`, `&&`, `&`, semicolon, and newline as command separators only
    outside quotes and escapes, selects the last active command or last
    unclosed `$()`/POSIX-backtick command, and removes only syntactically valid
    leading POSIX environment assignments. POSIX shells use backslash escape
    rules; an active PowerShell epoch uses backticks and doubled single quotes.
    Open single/double quotes and escaped whitespace remain one token. Existing
    quote or escape style is applied to the replacement, including inline
    `--option=value`, while unquoted replacements retain explicit
    `needsShellQuoting` metadata. Parsing never expands variables, evaluates a
    substitution, invokes a shell, or crosses the active token span.
45. Signature argument cardinality is explicit and inert. A variadic argument
    must be the terminal argument in its command or option, repeats across
    subsequent tokens, and a variadic option stops before the next option-like
    token. Inline `--option=value` consumes exactly that token and cannot bleed
    variadic suggestions forward. One shared decoder gives lookup and
    completion identical precedence: exact options first, then combined
    one-character short options with a valued option allowed only at the end.
    Cluster completion preserves the current final switch, appends unused
    switches in place, suppresses used aliases, and never treats an exact
    multi-character option such as `-it` as a cluster. `--` terminates option
    and subcommand interpretation while retaining variadic positional and path
    completion. Argument/option arrays remain bounded and the registry rejects
    ambiguous non-terminal variadics without executing any generator.
46. Live resource completion is asynchronous, cursor-scoped, and fail-closed.
    Only a resource template on the active argument may launch its allowlisted
    `docker` or `kubectl` executable; argv is fixed by OpenUI, `shell` is false,
    stdin is absent, and PATH discovery accepts absolute directories and
    executable regular-file targets only. Docker context/host/config and
    Compose file/project/directory/environment/profile flags, plus kubectl
    kubeconfig/context/cluster/user/namespace flags, are forwarded as literal
    arguments so the current terminal scope is preserved without evaluating
    the editing fragment. Shell-injection environment variables are removed,
    the complete remaining bounded environment participates in the cache key,
    and different credentials cannot share cached results. Subprocess time,
    stdout, result count, value/description size, cache lifetime/count, and
    in-flight work are bounded. A timeout, nonzero exit, malformed output,
    unsafe control character, missing executable, or relative PATH entry yields
    no live values rather than shell fallback or guessed data.
47. A semantic command queue is distinct from the PTY byte-write queue. It is
    session-scoped and runtime-only, caps pending commands at 100, each command
    at 12,000 characters, and total pending UTF-8 data at 512 KiB, and preserves
    submitted whitespace while rejecting empty or NUL-bearing input. Claiming
    the head atomically marks it in flight; no second item may dispatch until
    the exact block created for that claim reaches any terminal status. An
    unrelated user/agent block, duplicate completion, or stale PTY callback is
    a no-op. Exit status does not affect advancement, so failure is ordered but
    not queue-fatal; an unstarted rejected write returns to the head, while a
    write that may have reached the shell is never replayed. Pending rows may be
    edited, reordered, deleted, or cleared, but an in-flight row is immutable.
    Restart, disconnect, replacement, and deletion clear stale ownership before
    another process can receive it, and queued commands never participate in
    agent-command fallback selection.
48. Application-spawned Git processes inherit the user's executable discovery
    semantics, not the GUI launcher's minimal PATH. Capture runs lazily through
    the selected interactive login shell (`-i -l` for zsh/Bash/Fish; profile-
    compatible `-Command` for PowerShell), in a detached Unix session with stdin
    closed. A per-capture nonce brackets stdout so rc-file banners cannot become
    PATH data. Capture is capped at three seconds and 256 KiB of combined output;
    the extracted value is nonempty, control-free, and at most 12,000 characters.
    At most eight shell/home/inherited-environment keys are cached, including one
    shared promise for concurrent first callers. Failure, timeout, missing
    markers, invalid output, or even a nonzero shell exit without valid markers
    falls back to the inherited PATH. Only PATH is replaced. Git and every hook
    it launches receive that environment through fixed argv; filenames, branch
    names, and commit/stash messages are never interpolated into a shell string.
    Worktree branches must additionally pass `git check-ref-format`, and local
    and remote existence checks use explicit `refs/heads/` or `refs/remotes/`
    names before mutation.
49. SSH enhancement is optional and session-scoped. Only a plain interactive
    destination with no remote command, stdio tunnel, user ControlMaster, or
    incompatible mode is eligible. The local wrapper's OSC metadata is
    authenticated with a random 256-bit process token; a remote host cannot
    select a local executable or socket, and the socket must resolve directly
    inside OpenUI's private session directory. Assets are content-addressed,
    syntax-checked before atomic replacement, and require Python 3.8 plus a
    supported executable zsh/Bash/fish. Any check/install/setup failure enters
    the existing SSH session through the established master and never loops.
    The remote command protocol is a 512 KiB length-framed JSON stream with
    request IDs, fixed argv, bounded environment/arguments/output/runtime,
    process-group abort, stale-generation rejection, and exactly two delayed
    transport reconnect attempts. Remote epochs never consult the local PATH,
    environment, filesystem, manifests, Git refs, Docker, or kubectl state.
50. Session file reads have one bounded contract on local and instrumented-SSH
    hosts. A request contains 1-32 paths and at most 32 validated line ranges
    per path. Lexical traversal, NUL/control-bearing paths, and symlinks whose
    real target escapes the session cwd are rejected. UTF-8 text and explicitly
    requested base64 binary data have independent 256 KiB per-file and 320 KiB
    aggregate ceilings; line scanning is capped at 16 MiB. Missing, non-file,
    binary-disallowed, scan-limit, budget, cancellation, and I/O failures remain
    per-file results. Remote framing, response shapes, byte accounting, and
    base64 are revalidated by the client. During connect, reconnect, fallback,
    or disconnection, OpenUI returns unavailable and never reads the coincident
    local path. Every requested line range emits one segment even when it is
    wholly beyond EOF; the segment retains the requested start/range metadata,
    has empty content, and reports the file's actual line count.
51. Diff application is transactional at the tool boundary. Patch text is
    nonempty, NUL-free, and capped at 256 KiB. OpenUI passes it on stdin to
    fixed-argv Git, parses NUL-delimited `--numstat` metadata, confines both old
    and new paths to the session root, and completes `git apply --check` before
    any mutation. Validate-only never writes; an actual apply supports edits,
    creations, and deletions; stale/conflicting content returns an explicit
    conflict. SSH uses the same sequence over bounded remote stdin, so there is
    no separate degraded patch algorithm or local-filesystem fallback.
52. Session Git reads use the active host as a hard boundary. Repository root,
    porcelain status, NUL-delimited numstat, branch/main/upstream state, ahead/
    behind counts, unpushed commits, and diffs all come from one fixed-argv
    runner on that host. Paths are capped, NUL-free, relative, and confined to
    the resolved repository; at most 2,000 changed files, 2,000 files per
    commit, 50 unpushed commits, 256 KiB of output, and 256 KiB of diff data are
    admitted. Overflows fail explicitly instead of returning a plausible
    partial repository. Remote connect/reconnect/fallback/disconnect states
    never fall through to local Git.
53. Session Git mutations are serialized by session and resolved repository.
    Branch inputs pass `git check-ref-format`, commit messages are nonempty and
    capped at 16 KiB, and merge/cherry-pick/revert/rebase sentinels reject a new
    chain. Commit, optional push with explicit upstream, and optional PR create
    execute in order; push/PR failures report the already-completed stage rather
    than pretending the chain was atomic. Hooks and companion binaries receive
    the active interactive-shell PATH. Git and `gh` are always fixed argv, PR
    metadata is shape/control validated, duplicate PR creation converges on the
    existing PR, remote operations are bounded to 30 seconds, and success
    returns a fresh status snapshot rather than relying on a follow-up guess.
54. Local control has no ambient network or browser authority. The app HTTP
    listener binds only IPv4 loopback and rejects non-loopback Host headers;
    HTTP and terminal WebSocket requests carrying an Origin are accepted only
    from the active local app port or the configured local development port.
    Script control uses a separate owner-only Unix socket and owner-only,
    token-free discovery records; paths are confined to one per-user directory,
    stale records are pruned only with a matching record/socket shape, and
    cleanup removes both files. Requests and responses are single-message,
    versioned, timeout-bound, and capped at 64 KiB. Unknown actions, malformed
    parameters, stale target IDs, unsupported versions, oversize messages, and
    ambiguous instances fail with stable codes. Session creation is serialized,
    capped at 100 live sessions, accepts only an existing absolute cwd and a
    bounded title, and always creates an empty plain shell. Windows and an
    explicit disabled state publish no actionable discovery.
55. Terminal-find visibility is part of the search job, not a presentation-only
    filter. Hidden output rows are expressed as bounded, inclusive zero-based
    line ranges keyed only by blocks already in the search. Ranges are integer-
    validated, sorted, and merged before entering a worker; a hidden-row match
    contributes neither to the exact total nor to retained details. A live full
    replacement invalidates affected counts and details before publishing its
    scanning snapshot, versions in-flight work so stale worker replies cannot
    reappear, and rescans only changed blocks. Removed blocks discard their
    visibility state, and command, note, and cwd matches are never filtered by
    output-row visibility.
56. Runtime pane state is a view over authoritative OpenUI sessions, never a
    second process owner. A session ID occurs in at most one visible pane and
    cannot also be detached. Split/move operations preserve deterministic tree
    order, flatten a matching parent axis, normalize positive weights, and
    collapse zero/one-child branches. Directional focus climbs to the nearest
    matching-axis ancestor; close selects the next pane or previous pane, clears
    invalid zoom, and removes an empty tab. Closing a view retains and detaches
    its canvas session so reconciliation cannot recreate it; hard deletion
    purges visible or detached references. Mutations are revision-checked,
    count/depth/ID bounded, atomically mode-0600 persisted with backup fallback,
    and never accept string-coerced resize weights. A new pane uses explicit cwd
    when supplied, otherwise the latest active local shell cwd; while an SSH
    child owns the terminal it uses the suspended local root instead of a
    coincident local interpretation of the remote path.
57. Local-control structure actions mutate the same runtime workspace as HTTP
    callers. Targets are exact stable tab/session IDs or the current active
    target; stale explicit IDs never retarget. Tab moves swap one neighbor,
    directional pane resize climbs to the nearest matching-axis ancestor,
    applies at most ten bounded steps, and preserves a minimum sibling weight.
    Maximize and restore are idempotent. Pane split creates only an empty plain
    shell, reports the new pane/session identity, uses the shared canonical
    latest-cwd resolver, and rolls the session back if tree insertion fails.
    Pane/tab close retains canvas sessions and feeds the same bounded exact undo
    stack. All mutations serialize, unknown parameters fail, and no structural
    action can stage, submit, or execute terminal input.
58. Container shell instrumentation is a conservative argv transformation, not
    command-string rewriting. Docker and Podman must expose an exact `exec` or
    `run` subcommand, one target/image, both interactive and tty flags, and an
    exact bash/zsh/fish command with no trailing arguments. Kubectl additionally
    requires one target and its explicit `--` command separator. Known option
    values remain attached to their original tool invocation; unknown options,
    incomplete values, multiple targets, unsupported shells, and oversized
    argv fall through byte-for-byte. User-controlled values never enter a shell
    template. The wrapper invokes only the absolute pre-shim tool, forwards
    stdio and exit status, removes local SSH/container control variables, and
    treats missing or corrupt integration assets as a non-blocking bypass.
59. Environment-subshell instrumentation never rewrites or evaluates command
    arguments. Poetry and Pipenv require an exact first `shell` argument,
    aws-vault requires an exact first `exec` argument, and flox accepts only
    zero or more single-token leading options followed by exact `activate`;
    an explicit command after `--` bypasses both families.
    Other invocations fall through with the original argv and `$SHELL`. A
    recognized invocation redirects `$SHELL` only when the current shell's
    basename is supported and its corresponding shim is a current-user-owned,
    non-symlink regular file inside the mode-0700 session directory. The wrapper
    invokes only the absolute pre-shim tool, forwards stdio, signals, and exit
    status, and removes its Electron/wrapper variables before delegation.
60. OSC 52 is clipboard control-plane data, never terminal history. Access is
    deny by default and has only three exact modes: deny, write-only, and
    read/write. The incremental policy must recognize ESC and C1 forms across
    arbitrary PTY chunk boundaries, cap a sequence at 64 KiB, fail closed on a
    malformed selector or payload, and resume ordinary output after malformed,
    oversized, or incomplete input. Allowed operations may reach only the live
    renderer; their bytes never enter blocks, scrollback, restoration, search,
    sharing, or persistence. A clipboard read reply must match one exact,
    bounded OSC 52 response schema and use a history-neutral PTY transaction;
    it can never be repurposed as arbitrary terminal input.
61. A terminal hyperlink or embedded document is untrusted data until the
    Electron main process validates its destination. Only canonical HTTP and
    HTTPS URLs with a host and without credentials may reach navigation or
    `shell.openExternal`; renderer-side confirmation or xterm protocol parsing
    is defense in depth, not the authority boundary. Control-bearing,
    backslash-bearing, malformed, relative, protocol-relative, custom-scheme,
    non-string, and oversized values fail closed. The OpenUI application window
    may navigate only within its exact local origin, while the sandboxed browser
    view may navigate only among validated web URLs.
62. Secret-bearing terminal data is sanitized before it becomes searchable
    history. Detection is independent of a provider-specific prefix and handles
    quoted/multi-word values, structured key/value text, credential flags and
    headers, URI passwords, known provider formats, and multiline private-key
    material. Every persistence path normalizes controls and rescans before
    storing; a secret cannot be assembled only after its first scan. Input typed
    while a command is executing is never inferred as a command, so password
    prompts do not create history. Raw sensitive replay values and the bounded
    known-secret set exist only for the live PTY epoch and are erased on exit or
    restart after accumulated blocks receive a final sanitization pass.
63. Persistence schema versions are an authority boundary, not decorative
    metadata. The application-state, scrollback, and terminal-block readers
    accept only the original unversioned shape, explicit v1, and current v2;
    validated legacy data migrates atomically to v2 with its pre-migration
    generation retained as backup. Any other explicit version is unsupported,
    never coerced, and never rewritten during load. A compatible backup may be
    used in memory, but the incompatible current path becomes read-only so
    periodic autosave cannot perform an implicit downgrade. Only removing that
    current file or running a build that supports its version releases the
    guard. Corrupt JSON and semantically invalid current data continue to use
    the separate validated-backup recovery path.

64. Custom subshell recognition is data, never executable shell policy. The
    user file and its pattern/token counts are bounded; unsupported versions,
    symlinks, non-owner files, group/world-writable files, unsafe executable
    names, reserved wrapper names, NULs, embedded wildcards, and oversized
    tokens fail closed. Matching runs over the wrapper's existing argv with
    exact or prefix length semantics; `*` consumes exactly one whole token and
    a deny match has precedence over custom and built-in recognition. A
    recognized rule may change only `$SHELL` to an owner-only integration shim.
    The original absolute executable, argv, stdio, signals, and exit status are
    otherwise preserved, and private wrapper state is removed before exec.

65. Shell integration composes with user hooks and preserves the command's
    observable status. Zsh uses its native ordered preexec, precmd, and zshexit
    hook arrays without replacing existing entries. Bash captures string or
    array `PROMPT_COMMAND` entries, dispatches OpenUI with the original status,
    restores that status immediately before the preserved user sequence, and
    never replaces a DEBUG trap; its EXIT wrapper forwards the same status to
    the prior handler. Fish registers separate event handlers, including
    `fish_posterror`: because a parser error emits neither preexec, postexec,
    nor prompt evidence, that event supplies the rejected command and one
    generic failed lifecycle at status 1. Re-sourcing remains idempotent and no
    adapter edits a user's startup files.

66. Multiline command identity comes from shell evidence plus authenticated
    continuation state, never from the visible prompt text. Authoritative
    command metadata preserves literal LF after removing OSC terminators, and
    the lifecycle boundary canonicalizes PTY CRLF to LF. Bash `PS2` and
    PSReadLine continuation prompts prepend an invisible marker carrying the
    process-local epoch; only a current marker on an inferred active block may
    append another physical line. Empty and whitespace-only lines are
    preserved, input is bounded to 64 KiB, and uncertain editing fails closed.
    Missing or stale markers never turn stdin sent to a running program into
    history. Secret-bearing bodies are redacted and their raw replay remains
    live-only. Zsh and Fish retain their shell-native full preexec command, and
    PowerShell retains its exact history command. No adapter edits a user's
    startup files.

67. After an epoch-scoped adapter is active, only current-epoch prompt markers
    may act as lifecycle barriers. Bare OSC 133/633 `A` or `B` markers remain
    compatible before an authenticated epoch exists, but afterward they are
    treated as ambiguous repaint metadata: Powerlevel10k/Starship-style async
    output and nested-shell prompts cannot close an executing block, erase
    typeahead, or create a phantom block. A current-epoch prompt marker still
    recovers a missing completion as `unknown`; a stale epoch remains rejected.
    This protects semantic state without rewriting prompt functions, key
    bindings, or user startup files.

68. Terminal mode state comes only from syntactically complete CSI controls at
    VT ground state. ESC and C1 CSI forms may be split across arbitrary PTY
    chunks and may batch several numeric DEC private parameters under one
    `h`/`l` final. Parameter capture is capped at 128 characters. CSI-looking
    bytes inside OSC, DCS, SOS, PM, or APC strings never mutate state. Mouse
    tracking and mouse encoding preserve their mutually exclusive semantics.
    Command completion and recovery clear alternate-screen, bracketed-paste,
    application-cursor, mouse, focus, alternate-scroll, and synchronized-output
    state; a subsequent prompt may independently re-enable its line editor's
    bracketed-paste mode. Epoch change, restart, and exit also reset parser and
    mode state, so no partial control or stale TUI mode crosses generations.

69. Kitty keyboard negotiation is a bounded terminal control plane, not user
    input. Only exact ESC/C1 CSI `?`, `=`, `>`, and `<` commands ending in `u`
    are consumed; incomplete commands stay buffered under a 128-character cap,
    malformed/oversized sequences pass through, and control-string payloads
    cannot forge commands. Active flags are masked to `0x1f`; replace, union,
    difference, push, and counted pop preserve a base state under a 4,096-entry
    cap. Primary and alternate screens own separate stacks. Query replies are
    restricted to `CSI ? 0..31 u` on the history-neutral response transport.
    Encoding activates only under disambiguate/report-all flags, preserves IME,
    dead keys, macOS Option composition, alternate/text/event semantics, and
    standalone modifier identity. Windows consumes negotiation inertly because
    ConPTY cannot safely carry the protocol. Reconnect replay begins from a
    clean parser/stack and reconstructs state from terminal output.

70. Focus Mode owns the visible and accessible workbench while it is active.
    Canvas chrome is removed rather than layered above the terminal, and the
    inactive canvas subtree is hidden from assistive technology. The active
    session determines the find/history/queue rail and footer context; changing
    pane or session retargets those tools without mutating PTY input. Cmd-F,
    Cmd-J, Cmd-Shift-H, and Escape are window-level workbench actions, while
    ordinary keystrokes remain terminal input. Find cancellation is tied to the
    rail/query lifecycle, queue polling is bounded to the open rail, and history
    actions call the semantic block APIs rather than replaying untrusted text in
    the renderer. The terminal stays authoritative in single, split, narrow,
    offline, and needs-input states.

### Custom environment subshell policy

New terminal sessions read `~/.openui-desktop/terminal-subshells.json`. The
file must be a regular current-user-owned file that is not group/world writable.
For example:

```json
{
  "version": 1,
  "addedSubshellCommands": [
    { "argv": ["nix", "develop"], "match": "prefix" },
    { "argv": ["custom-env", "enter", "*"], "match": "exact" }
  ],
  "subshellCommandsDenylist": [
    { "argv": ["poetry", "shell", "--plain"], "match": "exact" }
  ]
}
```

The first argv element is an executable basename resolved once from the
terminal's original PATH. `prefix` permits trailing arguments; `exact` does
not. A literal `*` matches one complete argument. Embedded wildcards and shell
or regex syntax have no special meaning and patterns containing embedded `*`
are rejected. Rules are compiled into mode-0600 files inside the per-session
mode-0700 runtime directory. Shell, container, and SSH wrapper basenames are
reserved so custom policy cannot replace their stricter planners.

## OpenUI shell epoch extension

OpenUI keeps normal OSC 633 behavior and adds bounded process-local epoch
metadata to its own adapters. `I` announces the shell and epoch, `Q` carries
epoch-scoped cwd, `A`/`C` identify prompt and execution evidence, `D` carries
exit status plus epoch, `M` carries a validated boolean shell capability, and
`X` marks shell exit. `R` is reserved for bounded, authenticated local SSH
transport control and is never rendered or applied as shell lifecycle state.
Epoch IDs are opaque,
control-free, limited to 128 characters, and nesting is capped at 16. Legacy
events without epochs continue to work in the active shell, while mismatched
epoch events are ignored rather than guessed into history.

PowerShell's documented `PowerShell.Exiting` event does not expose the process
exit code. Its `X` event therefore leaves the status empty; OpenUI records the
child's final command as `unknown`, while the parent shell's later `D` event
still records the PowerShell process exit code. This avoids fabricating zero.

Interactive child-shell bootstrap is runtime-only. OpenUI creates a mode-0700,
hashed per-session directory under the user's `~/.openui-desktop` runtime area,
prepends it only to that PTY's `PATH`, and removes it with the session. The zsh
shim uses a private `ZDOTDIR` that delegates to the user's existing startup
files before loading OpenUI; Bash uses a private `--rcfile`; fish uses its
documented init-command option. PowerShell defines a process-local wrapper for
the currently running executable. Absolute shell paths and explicit
configuration-suppression flags remain an intentional conservative fallback.

## Edge-case backlog

### Shell protocol

- Shell expansions beyond inert quote/escape parsing and pasted commands
  containing literal control characters beyond bracketed-paste framing.
- Shell-specific syntax-error subtypes beyond Fish's generic parser failure and
  conservative `exit_error` remain. Fish `fish_posterror` now closes the exact
  rejected command with status 1; command-not-found, not-executable, Ctrl-C,
  Windows control-C, benign SIGPIPE, shell exit, and empty-input classification
  are covered.
- Background jobs completing after a later foreground command. Warp models
  these as distinct background blocks using its server-side terminal grid.
  OpenUI currently delegates emulation to xterm.js, so raw PTY bytes cannot
  reliably separate asynchronous job output from prompt repaint or typed echo;
  this remains an emulator-bound gap rather than a guessed block boundary.
- A GUI editor for custom subshell argv patterns remains. Current Warp does not
  include `sudo -s`, tmux, or screen in its built-in
  subshell matches, and its prior tmux SSH wrapper is deprecated in favor of
  the remote-server extension, so those are not automatic-parity targets.
  Plain interactive SSH, strict Docker/Podman/kubectl container shells, and
  Poetry/Pipenv/aws-vault/flox environment shells are automatic; explicit
  no-rc flags, extra container shell arguments, remote commands, tunnels, and
  custom ControlMaster invocations intentionally remain uninstrumented.
- Async prompt repaint is isolated from semantic lifecycle state once an
  authenticated OpenUI epoch is active: bare OSC prompt markers cannot close a
  command or erase tracked typeahead, while current-epoch recovery remains.
  OpenUI still delegates the visual rendering/reflow of framework-specific
  prompt bytes to xterm.js rather than maintaining Warp's separate prompt grid.
- Broader cloud-provider resource generators and broader command-signature
  data. Local and instrumented-SSH Docker/Compose images, containers,
  contexts, volumes, networks, and services plus kubectl contexts, namespaces,
  resource types/names, pods, and containers are covered through built-in
  fixed-argv resolvers. Live alias/function/abbreviation/keyword/builtin and
  variable-name discovery, safe package-script and Git-ref generators, typed
  local paths, and a nested registry for common developer commands are also
  covered; instrumented SSH also resolves bounded remote paths, CDPATH,
  package scripts, and Git refs. Arbitrary third-party JS/shell generators remain
  intentionally disabled until they have an explicit trust and permission
  model.

### Terminal emulation

- Alternate-screen, mouse reporting/encoding, focus reporting, application
  cursor keys, alternate scroll, synchronized output, and bracketed paste now
  have bounded chunk-safe lifecycle state while xterm.js owns their rendering
  and device input. Kitty keyboard negotiation and the key families implemented
  by current Warp are now covered; F1-F12, navigation, and other keys retain
  their established xterm legacy encodings when Warp likewise falls back.
- Wide characters, emoji grapheme clusters, combining marks, bidi text, and
  double-width cursor placement.
- Very large output, rapid resize, reflow, scrollback search, and memory limits.
- Broader unsafe escape filtering. OSC 8 hyperlink activation and
  embedded-browser navigation are HTTP(S)-only at the Electron authority
  boundary; OSC 52 clipboard policy and history isolation are implemented.
  Image protocols are now implemented (see the capability matrix).

### Product behavior

- Command-block keyboard navigation and sticky command headers.
- Failed-command styling without relying on color alone.
- Password-prompt attention notifications while the app is unfocused.
- Copy output with ANSI/plain-text modes and explicit truncation notices.
- Re-input versus execute must be distinct; execute is disabled while busy.
- A shared prompt/terminal submission editor, shell-mode gating, inline command
  editing, drag reordering, and conversation-scoped cloud-agent routing. Focus
  Mode now exposes the strict FIFO queue with add, button-based reorder, delete,
  clear, in-flight, and pending states.
- Search ranking across exact command, prefix, cwd, note, workflow, and output.
- Direct xterm-row highlighting and next/previous viewport focus for terminal
  find. The Focus Mode rail now exposes live scanning/counts, bounded excerpts,
  regex/case controls, and command reinsertion over the worker/API semantics.
- Retention/export/redaction APIs are implemented; UI affordances and scheduled
  age/size policies remain.
- Launch-layout validation: missing cwd, missing shell, partial pane failure,
  command quoting, active/focused pane, and platform-specific paths.
- Runtime tabs/split rendering, drag targets, resize handles, zoom/focus
  shortcuts, and canvas affordances remain UI work; the persistent tree and
  mutation APIs are implemented.

## Verification gates

- `npm run build`
- `npm run test:features`
- Shell syntax checks for every adapter available on the test platform.
- Manual matrix: normal command, empty command, failure, signal, full-screen TUI,
  multiline paste, resize during output, shell restart, restored session, and
  injected duplicate/missing lifecycle events.
- Windows, Linux, Intel macOS, and Apple Silicon packaging checks before parity
  is considered complete.

Current packaging evidence:

- Runtime tabs and panes: deterministic model cases prove mixed-axis nesting,
  same-axis flattening, move-time branch collapse, directional focus across
  ancestors, normalized resize weights, bounded directional resize, strict
  numeric validation, deterministic tab moves, idempotent zoom state,
  adjacent-focus close recovery, exact undo, stale-revision rejection, tab
  close/restore, owner-only persistence, corrupt-generation fallback, missing-
  session reconciliation, and best-effort launch pruning. Live HTTP cases move
  a shell to a new cwd, split a fresh session at that latest directory, resize
  and zoom it, retain its canvas session across pane close, prevent read
  reconciliation from resurrecting the detached view, undo the close, reject a
  stale revision and relative cwd, remove the pane on hard session deletion,
  and preserve exact tab identity through soft-delete/undo. Crash restoration
  retains the workspace tab across server restart. Launch tests prove native
  and imported Warp layouts become live split trees, atomic rollback leaves no
  pane, and best-effort failure collapses to the surviving pane.

- Terminal find: deterministic service cases prove hidden output lines are
  excluded before exact counting and detail retention, live full replacements
  synchronously clear stale results, stale worker replies cannot repopulate
  them, newly visible rows return after rescan, and string/coerced line indexes
  are rejected. The live HTTP suite repeats exclusion and restoration against
  a real semantic block, checks the exact per-row count delta, verifies no
  hidden-line detail survives, and exercises the versioned visibility endpoint.
  Extracted-package evidence is recorded for both platforms below.

- Agent file context and patches: local cases cover ranged text, missing files,
  traversal, realpath symlink escape, binary opt-in and base64, UTF-8-safe
  truncation, aggregate-budget exhaustion, invalid ranges, validate-only,
  successful edits, creation/deletion, and stale-patch conflicts. The SSH
  fixture proves bounded stdin, native ranged/binary batch reads, remote
  symlink escape and missing-file failures, remote patch application, and
  fail-closed reads during reconnect. The HTTP suite repeats confined reads,
  validation, application, and conflict status through live session routes.
  These behaviors derive from Warp's `specs/APP-3790/TECH-remote-read-files.md`
  and `specs/APP-3790/TECH-remote-apply-diff.md`; extracted-package evidence is
  recorded after each platform build below.
- Session Git: local fixtures cover NUL-safe rename and tab-bearing filename
  status, branch/main/upstream state, bounded diff, exact untracked and hunk
  discard, empty-commit conflict, invalid-branch injection, commit-and-push to
  a real bare origin, fixed-argv PR creation/view, in-progress-operation denial,
  and concurrent mutation serialization. The SSH fixture repeats remote status,
  commit-and-push, PR creation, post-operation delta, and reconnect fail-closed
  behavior through the persistent channel. The live HTTP suite proves status,
  diff, commit, conflict, discard, traversal denial, and branch-injection denial
  through an isolated session/repository.
- Secure local control: isolated-process cases prove mode-0700 discovery and
  mode-0600 record/socket permissions, absence of credential-shaped discovery
  data, confined stale-record cleanup, hostile Host/origin and WebSocket-origin
  denial, trusted development-origin access, protocol-version/size/allowlist/
  parameter/stale-target failures, typed action metadata, active-target lookup,
  plain-shell-only creation, serialized concurrent creates, bounded pagination,
  tab discovery/move/rename/reset, pane discovery/split/focus/navigation/resize/
  maximize/rename/close/exact-reopen, command-smuggling rejection, every
  implemented CLI route and typed CLI structural mutations,
  deterministic explicit selection across two live instances, exit cleanup,
  and a disabled process publishing no control state. Package evidence below
  also executes the bundled wrapper rather than only the source CLI.

- PTY writes: unit coverage proves UTF-8-safe chunking, FIFO transaction
  boundaries, byte-ceiling rejection, stale-generation cancellation, and
  recovery after a write failure. The live suite sends a 51 KiB multiline
  payload and immediate EOF over WebSocket, then compares the PTY-written file
  byte-for-byte. This deliberately uses bounded lines because a terminal in
  canonical mode has an operating-system per-line limit independent of the
  application write queue. The same complete suite passes from the extracted
  Apple Silicon and Linux ARM64 packaged `app.asar` artifacts.
- Terminal modes: deterministic cases cover split batched ESC CSI, C1 CSI,
  mutually exclusive mouse tracking/encoding, all tracked DEC private modes,
  batched reset, command-completion cleanup, restart cleanup, and false-control
  payloads inside OSC and DCS. Real zsh and macOS Bash 3.2 sessions emit a
  batched mode set, remain executing while every mode is visible in the
  lifecycle snapshot, then reset cleanly; the prompt may freshly re-enable
  bracketed paste without retaining any TUI-owned mode. The complete suite also
  passes from a mode-preserving extraction of the rebuilt Apple Silicon package
  using its packaged Electron runtime and native PTY payload.
- Kitty keyboard: deterministic cases cover split ESC and C1 CSI, queries,
  replace/union/difference apply modes, flag truncation, push/pop/base restore,
  the 4,096-entry denial-of-service bound, primary/alternate isolation, Windows
  inert negotiation, oversized recovery, and embedded false controls in OSC and
  DCS. Encoding cases cover disambiguate/report-all, macOS Option, IME,
  Shift+Enter precedence, printable/control/F13, alternate keys, associated
  text, repeats/releases, and standalone modifiers. Transport cases accept only
  history-neutral `CSI ? 0..31 u` replies and reject arbitrary, out-of-range,
  and multi-parameter responses. The production client TypeScript check and
  full feature suite pass. A live browser renderer was unavailable in this
  environment, so package verification does not claim that additional surface.
- Queued commands: model cases prove exact-text preservation, immutable copies,
  FIFO claiming, single in-flight ownership, exact-block and idempotent
  completion, edit/reorder/delete, unstarted rollback, clear-with-running-item,
  monotonic versions, invalid-input rejection, and count/byte ceilings. The
  real API starts a two-second command, adds four pending commands, edits and
  reorders one, deletes another, rejects mutation of the running row, and proves
  no later command runs during the hold. It then records the exact final file
  order across an exit-1 command and proves the following command still runs;
  session deletion removes the queue. The same test passes from both extracted
  packages.
- Interactive Git PATH: deterministic capture cases prove noisy startup output
  cannot escape nonce sentinels, nonzero shells may still return a valid PATH,
  concurrent callers share one capture, zsh/Bash/Fish/PowerShell receive their
  correct argument contract, and empty/control-bearing/oversized values plus
  startup failure fall back safely. A real macOS `/bin/zsh` login capture also
  succeeds with stdin detached. A Git pre-commit hook calls a helper available
  only on the captured PATH while the inherited app PATH cannot see it, proving
  hook propagation; a branch containing `;touch ...` is rejected by ref
  validation and creates no marker. Existing diff/checkpoint/worktree cases then
  exercise the shared fixed-argv Git runtime in source and extracted packages.
- Bracketed paste and stale automation: unit coverage proves chunk-split
  `?2004h`/`?2004l` tracking, exact wrapper bytes, restart reset, and Enter
  placement. Live sessions execute a two-line injected command as one semantic
  block under both zsh and Bash; Bash prompt-time history cannot collapse it to
  the final physical line, and a literal `\\n` remains literal. The suite also
  restarts a session while an old startup prompt is pending, proving that the
  replacement PTY receives no stale bytes. The share/search tests place SGR
  controls inside a known secret and prove normalization cannot reassemble it
  after redaction.
- Typed multiline commands: lifecycle cases prove exact CRLF-to-LF
  canonicalization, physical empty and whitespace-only continuation lines,
  current-epoch authorization, stale-marker denial, stdin/password exclusion,
  the 64 KiB fail-closed boundary, and secret redaction with live-only replay.
  Real macOS sessions execute zsh and Bash 3.2 heredocs as exactly one semantic
  block without phantom commands. Fish 4.8 preserves an exact multiline
  grammar command through `fish_preexec`, and native PowerShell 7.6.3 preserves
  an exact here-string while PSReadLine's invisible continuation marker creates
  no extra block. The same complete suite passes from a mode-preserving
  extraction of the rebuilt Apple Silicon package with its packaged Electron
  runtime and native `node-pty` payload.
- Filtered shell history: live Bash runs set `HISTCONTROL=ignorespace`, execute
  a leading-space command, and prove its block is not renamed to the preceding
  history entry; an empty Enter creates no block. The Linux PowerShell fixture
  installs a selective PSReadLine history handler and applies the same stale-ID
  assertion before restoring normal history behavior.
- Shell-hook coexistence: live zsh and Bash sessions install user hooks before
  OpenUI, execute a command that exits 23, and prove both OpenUI's block and the
  user's precmd/PROMPT_COMMAND observe 23. Zsh preexec/precmd entries remain in
  their native arrays; Bash keeps its DEBUG trap active while preserving an
  array PROMPT_COMMAND behind one status-restoring dispatcher. Separate exit
  cases prove prior zsh and Bash handlers plus OpenUI's epoch marker all receive
  exit 37. Fish 4.8 executes the posterror event path directly and proves one
  exact command-start/failure lifecycle plus a pre-existing user handler; the
  live Fish path runs the same assertion wherever an interactive Fish runtime
  is available.
- Async prompt repaint: deterministic lifecycle cases first reproduce a bare
  OSC 133/633 prompt collision during an executing current-epoch command and a
  repaint arriving over partially typed Bash input. Both retain exact state;
  current-epoch prompt recovery still closes a missing completion as `unknown`,
  and legacy no-epoch integrations retain their compatibility path. Real zsh
  and macOS Bash 3.2 commands emit a bare prompt-start control mid-execution and
  complete as exactly one successful semantic block with their later output.
- Shell availability: deterministic resolver cases cover executable absolute
  and PATH preferences, missing preferences, ordered fallbacks, portable sh
  login flags, and total failure. A native Linux ARM64 suite deliberately omits
  `/bin/zsh` while installing PowerShell; the application selects Bash and
  completes command, multiline-paste, and crash-restoration cases. A second
  ARM64 run installs zsh, Bash, fish, and PowerShell together and passes every
  nested/cross-shell case.
- Container shells: deterministic planners cover Docker and Podman `exec`/`run`
  global and subcommand options plus scoped `kubectl exec --` targets. Missing
  stdin/tty flags, extra shell arguments, unknown options, unsupported shells,
  missing separators, and ambiguous targets bypass without changing argv. A
  real wrapper process proves exact target preservation, private-control
  environment stripping, child exit-code propagation, and that a target
  containing shell syntax cannot execute. A fake Docker CLI then executes the
  transformed command locally through a real PTY: the bash child establishes a
  depth-1 epoch, records a semantic command, emits exit evidence, and restores
  the exact parent launcher block and epoch.
- Environment subshells: deterministic cases cover Poetry/Pipenv `shell`,
  `aws-vault exec`, and single-token-option `flox activate`, plus exact-argv
  fallback for every unrelated or ambiguous form. A real wrapper process proves
  that shell syntax in argv remains inert, private wrapper state is stripped,
  unsupported calls retain the original `$SHELL`, and child exit status is
  preserved. A fake Poetry CLI then launches the selected owner-only Bash shim
  through a real PTY, establishes a depth-1 epoch, records a semantic child
  command and exit block, and restores the exact parent launcher and root epoch.
  Custom-policy cases cover exact and prefix length, a one-token wildcard,
  deny-over-built-in and deny-over-custom precedence, invalid embedded
  wildcards, reserved executable names, mode-0600 compiled policies, owner-only
  custom shims, exact-argv fallback, private-state stripping, and a custom tool
  resolved from the original PATH. The complete source suite repeats the live
  parent/child epoch lifecycle with custom configuration present.
- Completions: deterministic provider cases prove PATH precedence, duplicate
  suppression, executable filtering, scan ceilings, cache invalidation,
  Windows PATHEXT/case normalization, selected-shell builtins, braced and plain
  variable replacement, value privacy, and exclusive path/`$` routing. The live
  API returns the installed `node` command and `$PATH` without serializing the
  variable's value. Chunk-split context tests prove per-kind bounds,
  validation, deduplication, stale-epoch rejection, child isolation, parent
  restoration, restart/exit clearing, identical-marker idempotence, and empty
  category deletion. Live zsh, Bash, fish, and PowerShell PTYs add and remove an
  alias or abbreviation, function, and exported variable after integration;
  suggestions refresh at the next prompt without exposing bodies or values,
  and a subsequent unchanged prompt emits no completion marker. Signature
  tests cover unfinished and trailing-whitespace tokens,
  deepest nested lookup, flags before subcommands, required flag arguments,
  repeatable and used flags, inline `--flag=value`, terminal variadic
  positionals and option values, self-contained inline variadics, switch
  clusters, valued final switches, exact multi-character-option precedence,
  `--` termination, enum arguments, custom root aliases, invalid registry
  input, and the live API's `git remote add` path.
  Clean Linux ARM64 additionally exercises Fish 3.6 and PowerShell 7.6.3 name
  emission in both source and extracted-package runs; Fish-private helper names
  are excluded before they consume the bounded context payload.
  Dynamic argument cases prove nearest-manifest discovery, package-manager
  selection, safe script ordering, command-body privacy, cache invalidation,
  malformed/oversized/symlink rejection, a 512-script ceiling, linked-worktree
  `commondir`, loose and packed local/remote/tag refs, unsafe-ref and ref-symlink
  rejection, typed file/folder filtering, hidden-file behavior, and quoting
  metadata. The live API returns `npm run build` and a newly created Git branch
  by name without invoking a completion subprocess.
  Live-resource cases prove exact fixed argv for Docker images/containers,
  Compose services, and kubectl contexts/namespaces/resource types/resource
  names/pod containers; root and subcommand scope flags survive as literal
  arguments while the active editing fragment does not. Deterministic runners
  prove failure-to-empty behavior, control-character rejection, a 1,024-result
  ceiling, timeout enforcement, bounded metadata, in-flight deduplication,
  injection-environment stripping, relative-PATH rejection, and cache isolation
  across different credential environments. The real HTTP API uses inert fake
  `docker` and `kubectl` executables to return each source type, records the
  received argv, and proves that a quoted context containing shell punctuation
  remains one argument and cannot create its marker file.
  Live PATH cases add and remove a private executable after integration in
  zsh, Bash, fish, and PowerShell, then prove suggestions follow at the next
  prompt while unchanged prompts emit no environment marker. Parser/lifecycle
  cases cover embedded semicolons, a 12,000-character ceiling, idempotence,
  stale epochs, child isolation, parent restoration, restart, and exit. Scanner
  cases cover empty/duplicate/relative entries and explicit empty `PATH` versus
  mixed-case `Path`. The real suggestion API follows an interactive shell's
  PATH and excludes `runtime-shell-shims` from returned executable metadata;
  the deletion case waits across the intentional command-finished then
  prompt-metadata ordering instead of assuming one PTY chunk.
  CDPATH cases preserve entry order, first-token deduplication, empty-entry pwd
  placement, relative, parent-relative, and home-relative roots, directory-only
  filtering, whitespace quoting metadata, explicit `./` bypass, and the
  64-entry traversal ceiling. Live Bash and zsh add and remove CDPATH after
  integration and the real suggestion API follows at the next prompt; nested
  shells restore the exact parent value. Fish exercises ordinary cwd-relative
  `cd` completion without receiving an invented CDPATH protocol.
  Autocd cases reject malformed and stale capability markers, suppress
  idempotent repeats, isolate child epochs, restore parents, and clear on
  restart/exit. Deterministic provider cases prove command-first ordering,
  directory-only and hidden-entry filtering, directory-symlink classification,
  whitespace quoting metadata, and disabled-state suppression. Live Bash and
  zsh enable and disable the option after integration, Fish remains always on,
  PowerShell remains off, and the real API follows each prompt transition.
  Parser cases cover single, double, unfinished, concatenated, and empty quoted
  tokens; POSIX backslash and PowerShell backtick escapes; quoted and escaped
  spaces; quoted separators; pipes/logical operators/semicolon/newline outside
  quotes; leading environment assignments; closed and open `$()` commands;
  POSIX backticks; inline equals; exact original replacement spans; and the
  64,000-character ceiling. Dynamic path replacements preserve an existing
  quote or escape style and no longer require a second quoting pass. The real
  API repeats chained, nested, quoted-enum, spaced/repeated path, `--`-terminated
  path, and short-cluster cases, then enters a
  native PowerShell child and proves the parser changes escape families with
  the active shell epoch before restoring the parent.
- Exit semantics: lifecycle cases cover POSIX Ctrl-C (130), benign SIGPIPE
  (141), Windows `STATUS_CONTROL_C_EXIT`, command-not-found (127/9009),
  not-executable (126), and ordinary exit errors. Live PTY tests send Ctrl-C to
  `sleep 30`, invoke a nonexistent command, and execute a present but
  non-executable file, proving that status, raw code, and structured failure
  reason agree. Persistence recovery and local share formatting retain the
  reason without classifying interrupted/successful blocks as failures.
- Transport/redraw: the suite rejects wrong WebSocket paths, malformed JSON,
  binary messages, and oversized frames with protocol-specific close codes,
  proves the server remains alive afterward, sends a 500-event resize burst and
  observes the final 111x37 dimensions, isolates a mocked slow client at the
  queue ceiling, and verifies chunk-split CLI-agent `CSI 2 J` replacement does
  not leak into a later ordinary `clear` block.
- Restoration: the feature suite now writes two atomic generations, corrupts
  the current state/buffer/block files, and proves prior-generation recovery,
  then saves and corrupts them again to prove a damaged current file cannot
  replace the last validated backup. It also proves private modes, displaced
  generation cleanup, output bounds, control stripping, ID deduplication, and
  completed-only snapshots. Its live test changes cwd, resizes to 111x37,
  emits OSC 52 plus ordinary output, stops the server with SIGTERM, restarts it,
  verifies safe scrollback and semantic-history replay over WebSocket, exercises
  missing-cwd fallback, and confirms deletion removes restoration artifacts.
- Persistence version skew: deterministic state, scrollback, and block cases
  migrate unversioned and v1 current files to v2, including the original legacy
  text scrollback format. Current v2 round trips unchanged. Explicit future and
  non-numeric versions are rejected, compatible backups restore without
  rewriting the unsupported current file, and simulated periodic saves cannot
  overwrite either future state or its last compatible backup. Explicit current
  file removal releases the state write guard. Extracted Apple Silicon and
  Linux ARM64 packages repeat legacy migration, future fallback, and downgrade-
  write denial from their real `app.asar`; their compiled persistence module is
  byte-identical to the source-tested build.
- OSC 52 policy: deterministic cases cover all three access modes, default and
  unknown-value denial, ESC/BEL, ESC/ST, and C1 OSC/ST forms, every relevant
  chunk boundary, unrelated OSC streaming, malformed selectors, 64 KiB
  overflow, incomplete flush, and parser reset across PTY generations. A real
  WebSocket/PTY command emits a valid base64 clipboard write assembled so typed
  command echo cannot create a false positive; the marker remains visible while
  the complete OSC payload is absent from both the renderer stream and semantic
  block. Transport cases reject arbitrary and invalid-base64 history-neutral
  replies. Extracted macOS and Linux ARM64 packages passed the complete suite,
  and real packaged servers exposed default deny plus an explicit `write_only`
  configuration through `/api/config`.
- Safe hyperlinks and browser navigation: deterministic policy cases preserve
  ordinary HTTPS plus localhost/IPv4/IPv6 development locations and reject
  custom schemes, credentials, controls, backslash ambiguity, malformed ports,
  relative/protocol-relative URLs, non-string IPC values, and both raw and
  canonical size overflow. The full source feature suite passed. Extracted
  Apple Silicon and Linux ARM64 `app.asar` artifacts then executed the packaged
  policy cases; inspection proved both compiled main-window and browser-view
  handlers validate before navigation or `shell.openExternal`, and the packaged
  policy module is byte-identical to the verified source build.
- Secret-safe terminal history: deterministic cases cover quoted multi-word
  shell and JSON assignments, semantic long flags, curl/docker/Podman/Redis/
  sshpass/MySQL/OpenSSL credential forms, Authorization headers, URI userinfo,
  provider-token families, JWTs, multiline private keys, oversized values,
  known-secret propagation, benign source selectors, and password input while a
  command is active. Persistence cases split a provider token with SGR controls
  and prove the normalize-then-rescan pass removes it; a PTY restart similarly
  sanitizes a control- and chunk-split generic credential before erasing raw
  replay state. A real shell session uses a quoted non-provider secret and
  proves blocks, output, history export, terminal find, and confirmed shares
  contain no raw value. Both extracted ARM64 packages execute the same policy,
  replay, and navigation cases, and their redaction/persistence/lifecycle
  modules are byte-identical to the verified source build.

- Apple Silicon: unpacked Electron bundle built and launched with an isolated
  home/cwd. The current package automatically launched an instrumented child
  zsh with no manual adapter source or PATH repair, even when the test `.zshrc`
  moved `/bin` ahead of the private shim. It captured a depth-1 command,
  restored the root epoch on exit, and completed the parent launcher block.
  The rebuilt package also ran the worker-backed terminal find API against a
  real semantic command/output block, excluded a live-hidden output row from
  exact counts and details, restored it after visibility changed, and cleared
  the search on close. The latest package also ran the complete feature suite
  from its `app.asar` plus executable `app.asar.unpacked` native payload,
  including authenticated SSH wrapper bypass/setup,
  persistent remote command execution, remote PATH/files/manifests, forced
  helper death and reconnect, live shell-context, CDPATH/autocd navigation,
  live-resource completion, bounded local/remote file reads, local/remote
  validate/apply/conflict patch paths, out-of-bounds empty range compatibility,
  local/remote session Git status/diff/commit/push/PR paths, and
  crash-restoration tests. The extracted package also passed the persistent
  runtime tab/split-tree suite, including detach/reconcile, exact close undo,
  latest-cwd splits, launch-layout materialization, and crash restoration. Its
  bundled `Contents/Resources/bin/openui-control`
  also discovered an isolated packaged server, inspected typed `pane.resize`
  metadata, created a named runtime tab, listed its exact pane identity, and
  cleaned its discovery state on exit. The container-shell build additionally
  created owner-only Docker and kubectl shims from the real packaged server;
  both point at the external packaged container wrapper, the packaged Electron
  runtime, and the exact original tool executable. The environment-subshell
  build passed the complete suite from a mode-preserving extraction using the
  packaged Electron Node runtime. Its real packaged server then created
  owner-only Poetry, Pipenv, aws-vault, and flox shims pointing at the external
  packaged wrapper and each exact original executable. The OSC 52 build repeated
  the complete suite from a mode-preserving extraction and launched a real
  packaged server with explicit write-only clipboard access. The custom-
  subshell rebuild has a source-identical external wrapper, a compiled
  session-policy module byte-identical to the source-tested build, and passes
  packaged custom-match and deny-over-built-in cases. The hook-coexistence
  rebuild has source-identical external adapters in both packages and executes
  packaged Bash array/status/DEBUG, zsh exit-hook, and Fish posterror cases.
  The multiline rebuild additionally passes the complete extracted-package
  suite with zsh/Bash heredocs, Fish 4.8 multiline event evidence, and a native
  PowerShell 7.6.3 here-string. The async-prompt rebuild passes the complete
  extracted-package suite and real zsh/Bash commands containing a colliding
  bare prompt marker. The terminal-mode rebuild passes the complete extracted-
  package suite, including real batched mode cycles. The terminal-workbench
  rebuild additionally passed the complete source suite and extracted-package
  suite, including live find/history/queue API behavior and packaged renderer
  presence checks. Visual QA covered one pane, two panes, live find, history,
  an in-flight FIFO queue, and a 900 px window without renderer console errors.
  The command-search rebuild passed the complete source suite and complete
  extracted-package suite with the package's executable native payload. An
  isolated live server additionally proved normalized signature replacement
  spans, parameterized workflow rendering, and semantic queue drain. The
  semantic-block rebuild adds bounded plain-output block rendering and
  queue-aware replay, and passes both source and extracted-package suites. The
  current 10,873,619-byte artifact has SHA-256
  `b8640f13099d19935728f6f5f400b63e6bc9ccee5c398a85933e80dd3f0c97bb`.
- Linux ARM64: clean container build produced an unpacked Electron bundle with
  the external adapters and native ARM64 `node-pty`; the packaged app launched
  under Xvfb and completed a real zsh semantic block with cwd and exit code.
  The latest clean feature run also passed automatic nested zsh, Bash, fish,
  native PowerShell, and zsh-to-PowerShell lifecycle tests. The current
  PTY-write build passed the complete suite, shell parsers, and zero-vulnerability
  production audits in Node 22. The current secure-control build repeated
  those gates from a fresh lockfile install, passed the complete suite from the
  extracted package overlaid with its real `app.asar.unpacked` ARM64 native
  payload, including filtered terminal-find visibility,
  file-read/patch, local/remote Git coverage, and the persistent runtime
  tab/split-tree suite. It then launched the packaged binary in its Node runtime
  mode and executed
  the packaged `openui-control` wrapper through the stable `openui` executable
  to inspect typed `pane.resize` metadata, create a named tab, and list its
  exact pane identity. The container-shell build repeated the complete source
  and extracted-package feature suites, then used the packaged Electron Node
  runtime and an isolated PATH to prove that its real server creates mode-0700
  Docker and kubectl shims targeting the external wrapper and exact original
  executables. The environment-subshell build again used a clean Node 22
  install, passed both production audits, the complete source suite, and the
  complete extracted-package suite with native ARM64 payload. Its real packaged
  server created mode-0700 Poetry, Pipenv, aws-vault, and flox shims targeting
  the external wrapper and exact original executables. The OSC 52 build used a
  fresh Node 22 install with zsh, Bash, Fish 3.6, and PowerShell 7.6.3; both
  production audits and the complete source suite passed. Its native ARM64
  Electron and `node-pty` payload then passed the complete mode-preserving
  extracted-package suite, and a real packaged server honored explicit
  write-only clipboard access. The custom-subshell rebuild has a source-
  identical external wrapper, a compiled session-policy module byte-identical
  to the source-tested build, and passes packaged custom-match and deny-over-
  built-in cases. The hook-coexistence rebuild has source-identical external
  adapters in both packages and executes packaged Bash array/status/DEBUG, zsh
  exit-hook, and Fish posterror cases. The multiline rebuild's four external
  adapters are source-identical to the tested build, its compiled lifecycle
  module is byte-identical to that build, and its `app.asar` is byte-identical
  to the fully exercised macOS archive. The async-prompt rebuild retains those
  byte-identity checks. The terminal-mode rebuild's lifecycle and API modules
  are byte-identical to the source-tested build, and both packages again share
  one identical archive. The terminal-workbench rebuild again produced one
  byte-identical macOS/Linux ARM64 archive after the complete extracted-package
  suite. The current 10,830,262-byte ARM64 `app.asar` has SHA-256
  `b29ad6959deb42b271fb2c14dfd31e80cd6c8e2382320f64baf85ecfcde1db33`.
  The content-addressed remote server also starts cleanly under the declared
  minimum Python 3.8 runtime.
- Windows shell behavior: the PowerShell adapter was executed under native
  PowerShell 7.6.3 Linux ARM64 and emitted init/cwd/completion evidence. A native
  Windows Electron package still needs CI evidence.
- The release workflow now gates tagging on the feature suite across macOS,
  Linux, and Windows, validates all shell adapters, audits production
  dependencies, and emits a verified `SHA256SUMS` file. Those hosted matrix
  runs are not considered proven until GitHub Actions executes them.

## Primary public references

- Blocks: <https://docs.warp.dev/terminal/blocks>
- Zsh, Bash, and Fish hook coexistence: <https://github.com/warpdotdev/warp/blob/9e10550046f74cb379efcaa1a40af0cc189d01bd/app/assets/bundled/bootstrap/zsh_body.sh>, <https://github.com/warpdotdev/warp/blob/9e10550046f74cb379efcaa1a40af0cc189d01bd/app/assets/bundled/bootstrap/bash_body.sh>, and <https://github.com/warpdotdev/warp/blob/9e10550046f74cb379efcaa1a40af0cc189d01bd/app/assets/bundled/bootstrap/fish.sh>
- Async prompt and transient-prompt handling: <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/assets/bundled/bootstrap/zsh_body.sh>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/assets/bundled/bootstrap/pwsh.ps1>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/blocks.rs>, and <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/header_grid.rs>
- Repeated and prompt-only lifecycle evidence: <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/specs/REMOTE-1973/TECH.md>
- DEC private mode parsing and cleanup: <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/crates/warp_terminal/src/model/ansi/control_sequence_parameters.rs>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/grid/ansi_handler.rs>, and <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/terminal_model_tests.rs>
- Kitty keyboard negotiation, stack, and encoding: <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/ansi/mod.rs>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/app/src/terminal/model/grid/grid_handler.rs>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/crates/warp_terminal/src/model/mode.rs>, <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/crates/warp_terminal/src/model/escape_sequences/kitty_keyboard_protocol.rs>, and <https://github.com/warpdotdev/warp/blob/a01df387ae5697f05d08ac180a081e9e60b7200c/crates/warp_terminal/src/model/escape_sequences_tests.rs>
- HTTP(S)-only browser URL policy: <https://github.com/warpdotdev/warp/blob/3e3711ce96bfcca740b5fd6f0f3140e8e2302c6a/app/src/uri/browser_url_handler.rs>
- Terminal secret-detection behavior: <https://github.com/warpdotdev/warp/blob/3e3711ce96bfcca740b5fd6f0f3140e8e2302c6a/app/src/terminal/model/secrets.rs>
- Persistence migration model: <https://github.com/warpdotdev/warp/blob/3e3711ce96bfcca740b5fd6f0f3140e8e2302c6a/app/src/persistence/README.md>
- Custom and denylisted subshell patterns: <https://github.com/warpdotdev/warp/blob/3e3711ce96bfcca740b5fd6f0f3140e8e2302c6a/app/src/terminal/warpify/settings.rs>
- Remote batch file reads: <https://github.com/warpdotdev/warp/blob/d45970299fb02c8c9295ca766d4cd86530066458/specs/APP-3790/TECH-remote-read-files.md>
- Remote diff application: <https://github.com/warpdotdev/warp/blob/d45970299fb02c8c9295ca766d4cd86530066458/specs/APP-3790/TECH-remote-apply-diff.md>
- Out-of-bounds ranged reads: <https://github.com/warpdotdev/warp/blob/a2c17600939a00ed06a7dffc894b1eeaa450dc8a/specs/read-files-out-of-bounds-fix/TECH.md>
- Remote Git status: <https://github.com/warpdotdev/warp/blob/a2c17600939a00ed06a7dffc894b1eeaa450dc8a/specs/remote-git-repo-status/TECH.md>
- Remote Git operations: <https://github.com/warpdotdev/warp/blob/a2c17600939a00ed06a7dffc894b1eeaa450dc8a/specs/remote-git-operations/TECH.md>
- Warp Control product, transport, and security model: <https://github.com/warpdotdev/warp/tree/a5c11c70bfcfcd97483182b5bb73a61c56edf26b/specs/warp-control-cli>
- Coordinated and proxy-safe PTY writes: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/app/src/terminal/writeable_pty/pty_controller.rs>
- Command-byte, multiline, and bracketed-paste cases: <https://github.com/warpdotdev/warp/blob/9e10550046f74cb379efcaa1a40af0cc189d01bd/app/src/terminal/writeable_pty/pty_controller_command_bytes_tests.rs>
- Bash ignored-history and multiline preexec handling: <https://github.com/warpdotdev/warp/blob/9e10550046f74cb379efcaa1a40af0cc189d01bd/app/assets/bundled/bootstrap/bash_body.sh>
- Executable-aware default-shell fallback: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/app/src/terminal/local_tty/shell.rs>
- Top-level command completion routing: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/crates/warp_completer/src/completer/engine/command.rs>
- Environment-variable completion: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/crates/warp_completer/src/completer/engine/variable.rs>
- Shell-defined completion context: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/assets/bundled/bootstrap/bash_body.sh>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/assets/bundled/bootstrap/zsh_body.sh>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/assets/bundled/bootstrap/fish.sh>, and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/assets/bundled/bootstrap/pwsh.ps1>
- CDPATH directory resolution: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/path.rs> and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/path_tests.rs>
- Top-level autocd routing and shell capability model: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/command.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_terminal/src/shell/mod.rs>, and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/suggest/test.rs>
- Quote-aware completion parsing: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/parsers/simple/lexer.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/parsers/simple/parser.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/parsers/simple/mod.rs>, and their adjacent lexer/parser tests
- Completed-token and deepest-subcommand signature lookup: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/signatures/v2/lookup.rs>
- Signature argument arity and variadic positionals/options: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/signatures/v2/mod.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/argument/v2.rs>, and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/suggest/test.rs>
- Async signature argument generators and terminal context: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/argument/v2.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/context/mod.rs>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/src/completer/mod.rs>, and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/src/terminal/dynamic_enum_suggestions.rs>
- Strict FIFO queued terminal commands: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/gh-11912/PRODUCT.md> and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/gh-11912/TECH.md>
- Interactive login-shell PATH for Git and hooks: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-4188/PRODUCT.md>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-4188/TECH.md>, <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/src/terminal/local_shell/mod.rs>, and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/app/src/util/git.rs>
- Persistent SSH remote server setup and initialization: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/alokedesai/APP-3797/PRODUCT.md> and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/alokedesai/APP-3797/TECH.md>
- Remote command execution for SSH completions: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-3791/TECH.md>
- Remote-server reconnect lifecycle: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-4283/TECH.md>
- Unsupported-host silent SSH fallback: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-4281/PRODUCT.md> and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/specs/APP-4281/TECH.md>
- Short-option clusters and inline option values: <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/completer/engine/flag/v2.rs> and <https://github.com/warpdotdev/warp/blob/5e9dc1c24abcf1b97be63a9bc4eb75d60c2f4ab6/crates/warp_completer/src/parsers/v2.rs>
- Signature registry and executable-generator boundary: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/crates/warp_completer/src/signatures/v2/registry.rs> and <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/crates/warp_completer/src/signatures/v2/js.rs>
- Non-error and command-not-found exit codes: <https://github.com/warpdotdev/warp/blob/eedb5ac5d14260cf04de559a13823df2dfe54bd0/crates/warp_core/src/command.rs>
- Async terminal find behavior: <https://github.com/warpdotdev/warp/tree/eedb5ac5d14260cf04de559a13823df2dfe54bd0/specs/async-find>
- Async find filtered-row behavior: <https://github.com/warpdotdev/warp/commit/6c5356ba585b4620c2d3017ba5cd9829ad5485fd>
- Split-pane tree ordering, collapse, and movement: <https://github.com/warpdotdev/warp/blob/d164d99300fce66f0525d4387871977a9becd6b9/app/src/pane_group/tree.rs> and <https://github.com/warpdotdev/warp/blob/d164d99300fce66f0525d4387871977a9becd6b9/app/src/pane_group/tree_tests.rs>
- Fork/new-pane latest working directory: <https://github.com/warpdotdev/warp/commit/5ff4f8900e05891ada43a093791752a3ea07b918>
- Session snapshot restoration: <https://github.com/warpdotdev/warp/tree/eedb5ac5d14260cf04de559a13823df2dfe54bd0/specs/APP-4457>
- Native restored cwd: <https://github.com/warpdotdev/warp/tree/eedb5ac5d14260cf04de559a13823df2dfe54bd0/specs/andy/ad-hoc/session-restore-wsl-msys2-pwd>
- CLI-agent frame redraw semantics: <https://github.com/warpdotdev/warp/tree/eedb5ac5d14260cf04de559a13823df2dfe54bd0/specs/tui-output-redraw>
- Block basics: <https://docs.warp.dev/terminal/blocks/block-basics>
- Command Palette: <https://docs.warp.dev/terminal/command-palette>
- Launch Configurations: <https://docs.warp.dev/terminal/sessions/launch-configurations>
- Tab Configs: <https://docs.warp.dev/terminal/windows/tab-configs/>
- Workflows: <https://docs.warp.dev/knowledge-and-collaboration/warp-drive/workflows>
- YAML workflows: <https://docs.warp.dev/terminal/entry/yaml-workflows>
- Integrations: <https://docs.warp.dev/terminal/integrations-and-plugins>
- PowerShell engine events: <https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/register-engineevent?view=powershell-7.6>
