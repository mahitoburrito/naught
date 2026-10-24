import { BrowserWindow, WebContentsView, ipcMain, session, shell } from "electron";
import {
  chromeUserAgentFor,
  decideWindowOpen,
  normalizeWebNavigationInput,
  safeWebNavigationUrl,
} from "./externalNavigation";

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// See chromeUserAgentFor: presenting as plain Chrome is what makes Google
// sign-in render at all inside the embedded pane.
const BROWSER_USER_AGENT = chromeUserAgentFor(process.platform, process.versions.chrome);

// Own cookie jar, persisted across restarts like a real browser profile.
const BROWSER_PARTITION = "persist:openui-browser";

// OAuth needs one popup, occasionally a nested account chooser. Anything past
// a few concurrent children is a popup bomb.
const MAX_CHILD_WINDOWS = 3;

let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let lastBounds: BrowserBounds | null = null;
let currentUrl = "";
const childWindows = new Set<BrowserWindow>();

const CHANNELS = [
  "browser:open",
  "browser:setBounds",
  "browser:navigate",
  "browser:reload",
  "browser:back",
  "browser:forward",
  "browser:hide",
  "browser:close",
];

function ensureBrowserSession(): Electron.Session {
  const ses = session.fromPartition(BROWSER_PARTITION);
  // Session-level UA covers every webContents in the partition, service
  // workers included. Child windows re-pin it in registerChildWindow to cover
  // the Electron versions where popups fall back to the default UA.
  if (ses.getUserAgent() !== BROWSER_USER_AGENT) ses.setUserAgent(BROWSER_USER_AGENT);
  // Electron's no-handler default is allow-everything; a pane that looks like
  // Chrome must not silently grant camera/mic/location.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "fullscreen" || permission === "clipboard-sanitized-write");
  });
  return ses;
}

function popupWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 560,
    height: 700,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: BROWSER_PARTITION,
    },
  };
}

// The initial about:blank document of a scripted popup must be allowed to
// exist; every real destination in the pane and its popups goes through the
// same URL boundary.
const preventUnsafeNavigation = (event: { preventDefault(): void }, url: string) => {
  if (url === "about:blank") return;
  if (!safeWebNavigationUrl(url)) event.preventDefault();
};

function attachNavigationGuards(wc: Electron.WebContents) {
  wc.on("will-navigate", preventUnsafeNavigation);
  wc.on("will-redirect", preventUnsafeNavigation);
}

function setHostTitle(child: BrowserWindow, url: string) {
  try {
    child.setTitle(new URL(url).host || "about:blank");
  } catch {
    // Keep the last title on unparseable URLs.
  }
}

function registerChildWindow(child: BrowserWindow, initialUrl: string) {
  childWindows.add(child);
  child.on("closed", () => {
    childWindows.delete(child);
  });
  child.webContents.setUserAgent(BROWSER_USER_AGENT);
  attachNavigationGuards(child.webContents);
  // With no URL bar, the titlebar is the popup's only origin cue — stamp the
  // navigated host and refuse page-controlled overwrites so a page can't
  // relabel itself "Sign in – Google".
  child.on("page-title-updated", (event) => event.preventDefault());
  setHostTitle(child, initialUrl);
  child.webContents.on("did-navigate", (_event, navUrl) => setHostTitle(child, navUrl));
  child.webContents.setWindowOpenHandler(({ url: childUrl, disposition: childDisposition }) => {
    const decision = decideWindowOpen(childUrl, childDisposition);
    if (decision.action === "popup" && childWindows.size < MAX_CHILD_WINDOWS) {
      return { action: "allow", overrideBrowserWindowOptions: popupWindowOptions() };
    }
    if (decision.action === "navigate") {
      // A plain link inside an auth popup must not navigate the handshake
      // away — hand it to the system browser instead.
      void shell.openExternal(decision.url).catch(() => undefined);
    }
    return { action: "deny" };
  });
  child.webContents.on("did-create-window", (grandchild, details) => {
    registerChildWindow(grandchild, details.url);
  });
}

function emitState() {
  if (!host || host.isDestroyed() || !view) return;
  const wc = view.webContents;
  host.webContents.send("browser:state", {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

function ensureView(): WebContentsView {
  if (view) return view;

  ensureBrowserSession();
  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: BROWSER_PARTITION,
    },
  });

  if (host) host.contentView.addChildView(view);
  const wc = view.webContents;
  wc.on("did-navigate", (_event, url) => {
    currentUrl = safeWebNavigationUrl(url) || "";
    emitState();
  });
  wc.on("did-navigate-in-page", emitState);
  wc.on("did-start-loading", emitState);
  wc.on("did-stop-loading", emitState);
  wc.on("page-title-updated", emitState);
  attachNavigationGuards(wc);
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const decision = decideWindowOpen(url, disposition);
    if (decision.action === "popup" && childWindows.size < MAX_CHILD_WINDOWS) {
      // OAuth popups must become REAL windows or the window.opener handshake
      // sign-in flows depend on is severed.
      return { action: "allow", overrideBrowserWindowOptions: popupWindowOptions() };
    }
    if (decision.action === "navigate") {
      // Plain target=_blank links stay in the single-pane browser.
      currentUrl = decision.url;
      void wc.loadURL(decision.url).catch(() => shell.openExternal(decision.url).catch(() => undefined));
    }
    return { action: "deny" };
  });
  wc.on("did-create-window", (child, details) => {
    registerChildWindow(child, details.url);
  });

  return view;
}

function applyBounds() {
  if (!view || !lastBounds) return;
  // The renderer measures in CSS pixels, but setBounds takes DIPs. These
  // diverge whenever the window is zoomed (Cmd +/- via the default View
  // menu), leaving the native view offset and clipped at the window edge.
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  view.setBounds({
    x: Math.max(0, Math.round(lastBounds.x * zoom)),
    y: Math.max(0, Math.round(lastBounds.y * zoom)),
    width: Math.max(1, Math.round(lastBounds.width * zoom)),
    height: Math.max(1, Math.round(lastBounds.height * zoom)),
  });
}

function removeExistingHandlers() {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

export function registerBrowserViewIpc(window: BrowserWindow) {
  host = window;
  removeExistingHandlers();

  ipcMain.handle("browser:open", async (_event, url: unknown) => {
    const target = normalizeWebNavigationInput(url);
    if (!target) return { ok: false };
    const browserView = ensureView();
    browserView.setVisible(true);
    applyBounds();
    if (target !== currentUrl || browserView.webContents.getURL() !== target) {
      currentUrl = target;
      await browserView.webContents.loadURL(target).catch(() => undefined);
    }
    emitState();
    return { ok: true };
  });

  ipcMain.handle("browser:setBounds", (_event, bounds: BrowserBounds) => {
    lastBounds = bounds;
    applyBounds();
    return { ok: true };
  });

  ipcMain.handle("browser:navigate", async (_event, url: unknown) => {
    const target = normalizeWebNavigationInput(url);
    if (!target) return { ok: false };
    const browserView = ensureView();
    browserView.setVisible(true);
    currentUrl = target;
    await browserView.webContents.loadURL(target).catch(() => undefined);
    emitState();
    return { ok: true };
  });

  ipcMain.handle("browser:reload", () => {
    view?.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle("browser:back", () => {
    if (view?.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle("browser:forward", () => {
    if (view?.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle("browser:hide", () => {
    view?.setVisible(false);
    return { ok: true };
  });

  ipcMain.handle("browser:close", () => {
    destroyBrowserView();
    return { ok: true };
  });
}

export function destroyBrowserView() {
  // An orphaned OAuth popup whose opener is gone can never finish its
  // handshake — and on Windows/Linux a surviving child keeps the app alive
  // after the last real window closes.
  for (const child of childWindows) {
    try {
      child.close();
    } catch {
      // Already closed.
    }
  }
  childWindows.clear();
  if (view && host && !host.isDestroyed()) {
    try {
      host.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      // Window is already tearing down.
    }
  }
  view = null;
  lastBounds = null;
  currentUrl = "";
}
