# OpenUI Desktop

**Your AI Agent Command Center — as a native desktop app, now with a built-in diff viewer.**


A standalone Electron application that packages the full [OpenUI](https://github.com/mahitoburrito/openui) experience into a native desktop app. Manage multiple AI coding agents on an infinite canvas without needing a browser or Bun runtime.

## Install

### One-liner (browser, no install)

```bash
npx @mahitoburrito/openui-desktop
```

This starts a local server and opens the UI at `http://localhost:6968`. Requires Node.js 18+.

### Desktop App

#### Mac (Homebrew)

```bash
brew tap mahitoburrito/tap
brew install --cask openui-desktop
```

To update later: `brew upgrade --cask openui-desktop`

#### Mac (manual)

1. Go to the **[latest release](https://github.com/mahitoburrito/openui-desktop/releases/latest)**
2. Download **`OpenUI-x.x.x-arm64.dmg`** (Apple Silicon) or **`OpenUI-x.x.x.dmg`** (Intel)
3. Open the `.dmg` file
4. Drag **OpenUI** into the **Applications** folder
5. Close the DMG window
6. Open **Applications → OpenUI**
7. First launch only: macOS will warn the app is unsigned — right-click → **Open** → click **Open**
8. If you see **"OpenUI is damaged"**, run this in Terminal and try again:
   ```bash
   xattr -cr /Applications/OpenUI.app
   ```

After that, OpenUI launches like any normal app (Spotlight, Dock, etc).

#### Windows

1. Download **`OpenUI.Setup.x.x.x.exe`** from the **[latest release](https://github.com/mahitoburrito/openui-desktop/releases/latest)**
2. Run the installer
3. Launch **OpenUI** from the Start menu

#### Linux

1. Download **`OpenUI-x.x.x.AppImage`** or **`openui-desktop_x.x.x_amd64.deb`** from the **[latest release](https://github.com/mahitoburrito/openui-desktop/releases/latest)**
2. For AppImage: `chmod +x OpenUI-*.AppImage && ./OpenUI-*.AppImage`
3. For deb: `sudo dpkg -i openui-desktop_*.deb` then launch from your app menu

### From Source

```bash
git clone https://github.com/mahitoburrito/openui-desktop.git
cd openui-desktop
npm install

# Run as desktop app (Electron)
npm run dev

# Or run as browser app
npm start
```

## Requirements

- **Desktop app:** Just download and run — everything is bundled
- **npx / source:** Node.js 18+, plus one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), OpenCode, or Ralph Loop installed globally

## Updating

### Desktop App (manual install)

If you downloaded the app directly from GitHub Releases, it checks for updates automatically on launch. When a new version is available, it downloads in the background and prompts you to restart.

### Desktop App (Homebrew)

Homebrew-installed apps don't auto-update. Run this to get the latest version:

```bash
brew upgrade --cask openui-desktop
```

### npx

Always runs the latest version automatically:

```bash
npx @mahitoburrito/openui-desktop@latest
```

### From Source

```bash
git pull
npm install
npm run dev
```

## Features

- **Infinite canvas** with drag-and-drop agent nodes
- **Selection mode** — marquee or click to multi-select sessions, move them as a group, bulk-delete with undo
- **Real-time status** — Running, Idle, Needs Input, Tool Calling
- **Built-in terminal** with resizable sidebar, GPU rendering, and inline images (SIXEL, iTerm2)
- **Auto-naming** — sessions named from your first prompt
- **Agent support** — Claude Code, OpenCode, Ralph Loop
- **Linear integration** — start sessions from tickets
- **GitHub integration** — browse and start from issues
- **Git worktrees** — isolated branches per agent
- **Categories** — group agents by team or project
- **Persistent layout** — everything saved across restarts
- **Session recovery** — automatically resume local Claude conversations after a restart
- **Claude Code plugin** — precise status via hooks (auto-injected)

### Session recovery

When OpenUI reopens, local Claude sessions resume the same conversation in the
same node and working folder. Sessions you explicitly exit or close stay closed;
you can resume an exited session manually to enable recovery again. Recovery is
on by default and can be disabled in **Settings → Sessions → On launch**.

Recovery requires a saved Claude session ID and its local transcript. Older nodes
without an ID, or conversations whose transcripts were removed, stay offline.
SSH/devbox conversations do not yet support resuming their remote history.

### Session teardown

Deleting a session terminates the whole process tree it started, not just its
shell: the agent CLI, its plugins, and anything they left running in the
background. Agent CLIs commonly detach helpers that used to survive the delete
and accumulate in the background for days.

If you want something to outlive its session (a long-running dev server, say),
start it outside OpenUI. Quitting the app tears down every session the same way.

## Development

```bash
npm install
npm run dev
```

In dev mode:
- React client runs on `http://localhost:5173` via Vite
- Embedded server runs on port `6968`
- Vite proxies `/api` and `/ws` to the server
- Electron loads from the Vite dev server with DevTools open

Use `PORT=7968 npm run dev` to run on a different port (useful if the browser version is already running).

## Build & Package

```bash
# Build client + electron
npm run build

# Package as directory (for testing)
npm run pack

# Build distributable (DMG/AppImage/NSIS)
npm run dist
```

Output goes to `release/`.

## Releasing a New Version

Every push to `main` automatically:
1. Bumps the patch version
2. Creates a git tag
3. Builds Mac (arm64 + x64), Windows, and Linux binaries
4. Publishes them to a GitHub Release

Just push your code — that's it.

## Architecture

```
openui-desktop/
├── bin/                  # CLI entry point for npx
├── electron/
│   ├── main.ts           # Electron main process
│   └── preload.ts        # Context bridge for renderer
├── server/               # Embedded Node.js server
│   ├── index.ts          # HTTP + WebSocket (Hono + ws + node-pty)
│   ├── routes/api.ts     # REST API
│   └── services/         # Session, persistence, Linear, GitHub
├── client/               # React frontend (ReactFlow canvas)
├── claude-code-plugin/   # Status reporter plugin for Claude Code
└── package.json
```

### Web vs Desktop

| Aspect | Web (openui) | Desktop (openui-desktop) |
|--------|-------------|------------------------|
| Runtime | Bun | Node.js (via Electron) |
| PTY | bun-pty | node-pty |
| WebSocket | Bun native WS | ws library |
| HTTP | Bun.serve + Hono | @hono/node-server |
| Entry | CLI (`openui`) | Electron app or `npx` |
| Window | Browser tab | Native BrowserWindow |
| Data dir | `.openui/` | `.openui-desktop/` |

## License

MIT
