import { app, BrowserWindow, shell, dialog } from "electron";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { startServer } from "../server/index";
import { getActiveSessionCount } from "../server/services/sessionManager";
import { autoUpdater } from "electron-updater";
import { destroyBrowserView, registerBrowserViewIpc } from "./browserView";
import { startMacAutoUpdater, installPendingUpdateOnQuit } from "./macUpdater";
import { safeWebNavigationUrl } from "./externalNavigation";
import { destroyClipboardIpc, registerClipboardIpc } from "./clipboard";
import { destroyNativeDialogIpc, registerNativeDialogIpc } from "./nativeDialog";


let mainWindow: BrowserWindow | null = null;
let serverPort = Number(process.env.PORT) || 6968;
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

// CI release builds carry resources/build-info.json with channel "release"
// (written by the release workflow); local `npm run pack` builds don't.
function isReleaseChannelBuild(): boolean {
  try {
    const infoPath = join(app.getAppPath(), "resources", "build-info.json");
    if (existsSync(infoPath)) {
      return JSON.parse(readFileSync(infoPath, "utf-8")).channel === "release";
    }
  } catch (e) {
    // Treat unreadable build info as a local build
  }
  return false;
}

// Auto-update is ON by default for CI release builds, OFF for local
// source builds (so a patched daily-driver build doesn't overwrite itself
// with the public upstream release). Overrides:
//   OPENUI_ENABLE_AUTO_UPDATE=true   force on (e.g. a local build that wants upstream)
//   OPENUI_DISABLE_AUTO_UPDATE=true  force off
const autoUpdateEnabled =
  !isDev &&
  process.env.OPENUI_DISABLE_AUTO_UPDATE !== "true" &&
  (isReleaseChannelBuild() || process.env.OPENUI_ENABLE_AUTO_UPDATE === "true");

function createWindow() {
  const appUrl = isDev
    ? `http://localhost:${process.env.VITE_PORT || 5173}`
    : `http://localhost:${serverPort}`;
  const appOrigin = new URL(appUrl).origin;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "OpenUI Desktop",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Renderer and terminal output are untrusted at this privileged boundary.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeWebNavigationUrl(url);
    if (target) {
      void shell.openExternal(target).catch((error) => {
        console.error("[electron] Failed to open external URL:", error);
      });
    }
    return { action: "deny" };
  });
  const preventUnsafeAppNavigation = (event: { preventDefault(): void }, url: string) => {
    const target = safeWebNavigationUrl(url);
    if (!target || new URL(target).origin !== appOrigin) {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on("will-navigate", preventUnsafeAppNavigation);
  mainWindow.webContents.on("will-redirect", preventUnsafeAppNavigation);
  registerBrowserViewIpc(mainWindow);
  registerClipboardIpc();
  registerNativeDialogIpc(() => mainWindow);

  if (isDev) {
    // In dev mode, load from Vite dev server
    mainWindow.loadURL(appUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // In production, load from the embedded server
    mainWindow.loadURL(appUrl);
  }

  mainWindow.on("close", (e) => {
    const activeCount = getActiveSessionCount();
    if (activeCount > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: "warning",
        title: "Quit OpenUI?",
        message: `You have ${activeCount} active session${activeCount === 1 ? "" : "s"} running.`,
        detail: "Quitting will stop all sessions and shut down the server.",
        buttons: ["Quit", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    destroyBrowserView();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set the launch CWD to the user's home directory by default
  process.env.LAUNCH_CWD = process.env.LAUNCH_CWD || app.getPath("home");

  // Start the embedded server
  try {
    serverPort = await startServer();
    console.log(`[electron] Server started on port ${serverPort}`);
  } catch (err) {
    // Probe Agent Error Log Trigger
    console.error("[PRBE_ERROR_5di1QF] [electron] Failed to start server:", err);
    dialog.showErrorBox(
      "Server Error",
      "Failed to start the embedded server. The application may not work correctly."
    );
  }

  createWindow();

  if (autoUpdateEnabled && process.platform === "darwin") {
    // electron-updater can't install into an unsigned mac app — use our
    // custom zip-swap updater instead (electron/macUpdater.ts).
    startMacAutoUpdater(() => mainWindow);
  } else if (autoUpdateEnabled) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      console.log(`[updater] Update available: v${info.version}`);
    });

    autoUpdater.on("update-downloaded", (info) => {
      const response = dialog.showMessageBoxSync(mainWindow!, {
        type: "info",
        title: "Update Ready",
        message: `OpenUI v${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
      });
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });

    autoUpdater.on("error", (err) => {
      // Probe Agent Error Log Trigger
      console.error("[PRBE_ERROR_2BweaS] [updater] Error:", err.message);
    });

    autoUpdater.checkForUpdates().catch((err) => {
      // Probe Agent Error Log Trigger
      console.error("[PRBE_ERROR_uzkINF] [updater] Check failed:", err.message);
    });
  }

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  destroyBrowserView();
  destroyClipboardIpc();
  destroyNativeDialogIpc();
  installPendingUpdateOnQuit();
  process.emit("SIGINT" as any);
});
