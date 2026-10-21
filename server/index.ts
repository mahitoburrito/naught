import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { apiRoutes } from "./routes/api";
import { coordinatorAgentRoutes } from "./routes/coordinatorAgent";
import { coordinatorRoutes } from "./routes/coordinator";
import { devboxRoutes } from "./routes/devboxes";
import {
  resumeRestoredSessions,
  sessions,
  restoreSessions,
  scheduleSessionTitleGeneration,
  setServerPort,
  getTerminalSnapshot,
  noteTerminalInput,
  notePreferredTerminalSize,
  writeTerminalData,
} from "./services/sessionManager";
import { loadConfig } from "./services/linear";
import { saveState, terminalReplayText } from "./services/persistence";
import { killProcessTreesSync } from "./services/processTree";
import {
  parseTerminalClientMessage,
  sendTerminalMessage,
  TerminalClientMessageError,
  TerminalInputRateLimiter,
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
} from "./services/terminalTransport";
import { startTerminalControl } from "./services/terminalControl";
import { sendAgentStatus } from "./services/agentStatus";
import { startCoordinatorRuntime } from "./services/coordinatorRuntime";

const PREFERRED_PORT = Number(process.env.PORT) || 6968;
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
let boundPort = PREFERRED_PORT;

function loopbackHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  return value === `localhost:${port}` || value === `127.0.0.1:${port}`;
}

function trustedBrowserOrigin(value: string | undefined, port: number): boolean {
  if (!value) return true;
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
    if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") return false;
    const originPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
    const vitePort = Number(process.env.VITE_PORT || 5173);
    return originPort === port || originPort === vitePort;
  } catch {
    return false;
  }
}

// Hono app for HTTP routes
const app = new Hono();
app.use("*", async (c, next) => {
  if (!loopbackHost(c.req.header("host"), boundPort)) {
    return c.json({ error: "Invalid local Host header" }, 403);
  }
  if (!trustedBrowserOrigin(c.req.header("origin"), boundPort)) {
    return c.json({ error: "Untrusted browser origin" }, 403);
  }
  await next();
});
app.route("/api", apiRoutes);
app.route("/api/coordinator-agent", coordinatorAgentRoutes);
app.route("/api/coordinator", coordinatorRoutes);
app.route("/api/devboxes", devboxRoutes);

// Serve static files from client/dist in standalone (non-Electron) mode
const CLIENT_DIST = join(__dirname, "..", "..", "..", "client", "dist");
if (existsSync(CLIENT_DIST)) {
  app.get("/*", (c) => {
    const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = join(CLIENT_DIST, reqPath);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath);
      const ext = filePath.split(".").pop() || "";
      const mimeTypes: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        ico: "image/x-icon",
        json: "application/json",
      };
      return new Response(content, {
        headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
      });
    }
    // SPA fallback — serve index.html for client-side routes
    const indexPath = join(CLIENT_DIST, "index.html");
    if (existsSync(indexPath)) {
      return new Response(readFileSync(indexPath), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return c.notFound();
  });
}

// Try to listen on a port, resolve with the port number or reject
function tryListen(app: Hono, port: number): Promise<{ server: any; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      port,
      hostname: "127.0.0.1",
    }, (info) => {
      resolve({ server, port: info.port });
    });

    const httpServer = (server as any).server || server;
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        httpServer.close();
        reject(err);
      } else {
        reject(err);
      }
    });
  });
}

// Start server, auto-resolving port conflicts
export async function startServer(): Promise<number> {
  await restoreSessions();
  startCoordinatorRuntime();

  const MAX_ATTEMPTS = 10;
  let server: any;
  let actualPort: number = PREFERRED_PORT;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = PREFERRED_PORT + i;
    try {
      const result = await tryListen(app, port);
      server = result.server;
      actualPort = result.port;
      if (i > 0) {
        log(`[server] Port ${PREFERRED_PORT} was in use, using ${actualPort} instead`);
      }
      break;
    } catch (err: any) {
      if (err.code === "EADDRINUSE" && i < MAX_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }

  setServerPort(actualPort);
  boundPort = actualPort;
  try {
    const control = await startTerminalControl();
    if (control) log(`[control] Listening on ${control.record.socketPath}`);
  } catch (error) {
    if (!QUIET) console.warn("[control] Local control unavailable:", error);
  }
  log(`[server] Running on http://localhost:${actualPort}`);
  // Agents need the real port for their status hooks, so relaunch only once listening.
  if (loadConfig().resumeSessionsOnLaunch) resumeRestoredSessions();
  log(`[server] Launch directory: ${process.env.LAUNCH_CWD || process.cwd()}`);

  return new Promise((resolve) => {
    // Attach WebSocket server to the same HTTP server
    const httpServer = (server as any).server || server;
    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    const responsiveClients = new WeakSet<WebSocket>();
    const heartbeat = setInterval(() => {
      for (const client of wss.clients) {
        if (!responsiveClients.has(client)) {
          client.terminate();
          continue;
        }
        responsiveClients.delete(client);
        try { client.ping(); } catch { client.terminate(); }
      }
    }, 30_000);
    heartbeat.unref();
    wss.once("close", () => clearInterval(heartbeat));

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const sessionId = typeof parsedUrl.query.sessionId === "string" ? parsedUrl.query.sessionId : "";

      if (!loopbackHost(req.headers.host, actualPort) || !trustedBrowserOrigin(req.headers.origin, actualPort)) {
        ws.close(1008, "Untrusted local terminal client");
        return;
      }

      if (parsedUrl.pathname !== "/ws") {
        ws.close(1008, "Invalid terminal path");
        return;
      }
      if (!sessionId || sessionId.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
        ws.close(1008, "Session ID required");
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        ws.close(1008, "Session not found");
        return;
      }

      log(`[ws] Connected to ${sessionId}`);
      session.clients.add(ws);
      responsiveClients.add(ws);
      ws.on("pong", () => responsiveClients.add(ws));
      const inputRateLimiter = new TerminalInputRateLimiter();
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const appendTitleInput = (value: string) => {
        session.firstInputBuffer = `${session.firstInputBuffer || ""}${value}`.slice(-12_000);
      };

      // A live PTY whose renderer attaches for the first time has not displayed
      // any of its controls yet. Give that first renderer the original bounded
      // stream so full-screen TUIs can construct their screen. Every reconnect
      // (and every restored session) gets inert text instead, preventing old
      // clipboard/title escapes from being executed a second time.
      const firstLiveTerminalClient = Boolean(
        session.pty && !session.isRestored && !session.terminalClientConnected,
      );
      session.terminalClientConnected = true;
      if (session.outputBuffer.length > 0) {
        const replayData = firstLiveTerminalClient
          ? session.outputBuffer.join("")
          : terminalReplayText(session.outputBuffer, Boolean(session.outputBufferTruncated)).data;
        if (replayData) sendTerminalMessage(ws, { type: "output", data: replayData });
      }
      if (session.isRestored || !session.pty) {
        sendTerminalMessage(ws, {
          type: "output",
          data: "\r\n\x1b[38;5;245mSaved scrollback restored. The process is disconnected.\r\nClick \"Spawn Fresh\" to start it again.\x1b[0m\r\n"
        });
      }

      sendAgentStatus(ws, session);

      const terminalSnapshot = getTerminalSnapshot(sessionId, false);
      if (terminalSnapshot) {
        sendTerminalMessage(ws, { type: "terminalState", ...terminalSnapshot });
      }

      ws.on("message", (message, isBinary) => {
        try {
          const msg = parseTerminalClientMessage(message, isBinary);
          switch (msg.type) {
            case "input":
              if (!inputRateLimiter.consume(msg.bytes)) {
                ws.close(1008, "Terminal input rate exceeded");
                break;
              }
              if (session.pty) {
                if (!writeTerminalData(sessionId, msg.data, {
                  kind: "user",
                  proxySafe: true,
                  beforeWrite: () => {
                    noteTerminalInput(sessionId, msg.data);
                    session.lastInputTime = Date.now();
                  },
                })) {
                  ws.close(1013, "Terminal input queue is full");
                  break;
                }

                // Keep auto-generated titles fresh from submitted terminal prompts.
                // Claude's UserPromptSubmit hook is better structured; this is the
                // fallback for agents or shells without that hook.
                if (session.firstInputBuffer === undefined) {
                  session.firstInputBuffer = "";
                }
                if (msg.data.includes("\r") || msg.data.includes("\n")) {
                  const remaining = msg.data.split(/[\r\n]/)[0];
                  appendTitleInput(remaining);
                  const query = session.firstInputBuffer.trim();
                  if (query.length > 0) {
                    scheduleSessionTitleGeneration(sessionId, query);
                  }
                  session.firstInputBuffer = "";
                } else {
                  if (msg.data === "\x7f" || msg.data === "\b") {
                    session.firstInputBuffer = session.firstInputBuffer.slice(0, -1);
                  } else if (msg.data.length === 1 && msg.data.charCodeAt(0) >= 32) {
                    appendTitleInput(msg.data);
                  } else if (msg.data.length > 1 && !msg.data.startsWith("\x1b")) {
                    appendTitleInput(msg.data);
                  }
                }
              }
              break;
            case "terminalResponse":
              if (!inputRateLimiter.consume(msg.bytes)) {
                ws.close(1008, "Terminal input rate exceeded");
                break;
              }
              if (session.pty && !writeTerminalData(sessionId, msg.data, {
                kind: "terminal-response",
                proxySafe: true,
              })) {
                ws.close(1013, "Terminal input queue is full");
              }
              break;
            case "resize":
              session.terminalCols = msg.cols;
              session.terminalRows = msg.rows;
              notePreferredTerminalSize(msg.cols, msg.rows);
              if (resizeTimer) clearTimeout(resizeTimer);
              resizeTimer = setTimeout(() => {
                resizeTimer = undefined;
                if (session.pty) session.pty.resize(session.terminalCols, session.terminalRows);
              }, 16);
              break;
          }
        } catch (e) {
          if (e instanceof TerminalClientMessageError) {
            ws.close(e.closeCode, e.message);
          } else {
            if (!QUIET) console.error("Error processing message:", e);
            ws.close(1011, "Terminal transport failed");
          }
        }
      });

      ws.on("error", (error) => {
        if (!QUIET) console.warn(`[ws] Terminal connection error for ${sessionId}:`, error.message);
      });

      ws.on("close", () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        session.clients.delete(ws);
        log(`[ws] Disconnected from ${sessionId}`);
      });
    });

    // Periodic state save — every 10s for crash resilience
    setInterval(() => {
      saveState(sessions);
    }, 10000);

    // Cleanup helper
    const emergencySave = () => {
      try {
        saveState(sessions);
      } catch (e) {
        console.error("[server] Emergency save failed:", e);
      }
    };

    // Cleanup on exit
    process.on("SIGINT", () => {
      log("[server] Saving state before exit...");
      emergencySave();
      // Synchronous, and batched into a single pass: Electron tears the process
      // down as soon as this handler returns, so anything deferred to the event
      // loop never runs and every descendant of every session leaks on quit.
      // One scan and one grace period for all sessions, not one per session.
      const roots: Array<{ pid: number | undefined; label?: string; sessionMarker?: string }> = [];
      for (const [sessionId, session] of sessions) {
        if (session.pty) roots.push({ pid: session.pty.pid, label: sessionId, sessionMarker: sessionId });
        if (session.stateTrackerPty) {
          roots.push({ pid: session.stateTrackerPty.pid, label: `${sessionId}:state-tracker` });
        }
      }
      killProcessTreesSync(roots, { killRoot: false });
      for (const [, session] of sessions) {
        if (session.pty) session.pty.kill();
        if (session.stateTrackerPty) session.stateTrackerPty.kill();
      }
      // Only call process.exit when running standalone (not embedded in Electron).
      // When embedded, Electron manages the process lifecycle — calling process.exit()
      // here kills the process before electron-updater can install and relaunch.
      if (require.main === module) {
        process.exit(0);
      }
    });

    // Crash-resilient: save on SIGTERM, uncaughtException, unhandledRejection
    process.on("SIGTERM", () => {
      log("[server] SIGTERM received, saving state...");
      emergencySave();
      process.exit(0);
    });

    process.on("SIGHUP", () => {
      log("[server] SIGHUP received, saving state...");
      emergencySave();
    });

    process.on("uncaughtException", (err) => {
      console.error("[server] Uncaught exception, saving state:", err);
      emergencySave();
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      console.error("[server] Unhandled rejection, saving state:", reason);
      emergencySave();
    });

    resolve(actualPort);
  });
}

// If run directly (not imported by Electron main)
if (require.main === module) {
  startServer();
}
