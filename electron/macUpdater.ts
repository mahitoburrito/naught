import { app, dialog, BrowserWindow } from "electron";
import { spawn, execFileSync } from "child_process";
import { createHash } from "crypto";
import { createWriteStream, existsSync } from "fs";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// Custom macOS updater. electron-updater's Squirrel.Mac path requires a
// Developer ID-signed app, which our CI builds are not — so instead we
// download the release zip from GitHub, verify it against latest-mac.yml,
// and swap the .app bundle ourselves (same move as scripts/swap-staged.command).

const REPO = "mahitoburrito/openui-desktop";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

interface LatestRelease {
  version: string;
  zipName: string;
  zipUrl: string;
  sha512: string; // base64, from latest-mac.yml; empty if manifest missing
}

let checking = false;
let pendingAppPath: string | null = null; // extracted OpenUI.app awaiting install
let pendingVersion: string | null = null;
let installOnQuit = false;

// Returns >0 if a is newer than b
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// .app bundle root of the running instance, or null when not a packaged .app
function runningBundlePath(): string | null {
  // app.getPath("exe") → /path/OpenUI.app/Contents/MacOS/OpenUI
  const bundle = resolve(app.getPath("exe"), "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openui-desktop-updater" },
  });
  if (!res.ok) return null;
  const release: any = await res.json();
  const version = String(release.tag_name || "").replace(/^v/, "");
  if (!version) return null;

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const zipName = `OpenUI-${version}-${arch}.zip`;
  const assets: any[] = release.assets || [];
  const zip = assets.find((a) => a.name === zipName);
  if (!zip) return null;

  // sha512 lives in the latest-mac.yml the publish job generates
  let sha512 = "";
  const manifest = assets.find((a) => a.name === "latest-mac.yml");
  if (manifest) {
    const ymlRes = await fetch(manifest.browser_download_url, {
      headers: { "user-agent": "openui-desktop-updater" },
    });
    if (ymlRes.ok) {
      const lines = (await ymlRes.text()).split("\n");
      const urlIdx = lines.findIndex((l) => l.includes(`url: ${zipName}`));
      const shaMatch = urlIdx >= 0 ? lines[urlIdx + 1]?.match(/sha512:\s*(\S+)/) : null;
      if (shaMatch) sha512 = shaMatch[1];
    }
  }

  return { version, zipName, zipUrl: zip.browser_download_url, sha512 };
}

async function downloadAndExtract(latest: LatestRelease): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openui-update-"));
  const zipPath = join(dir, latest.zipName);

  const res = await fetch(latest.zipUrl, {
    headers: { "user-agent": "openui-desktop-updater" },
  });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

  const hash = createHash("sha512");
  const source = Readable.fromWeb(res.body as any);
  source.on("data", (chunk) => hash.update(chunk));
  await pipeline(source, createWriteStream(zipPath));

  if (latest.sha512 && hash.digest("base64") !== latest.sha512) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("sha512 mismatch against latest-mac.yml");
  }

  // ditto preserves bundle structure, symlinks, and resource forks
  const extractDir = join(dir, "extract");
  execFileSync("ditto", ["-xk", zipPath, extractDir]);
  const newApp = join(extractDir, "OpenUI.app");
  if (!existsSync(newApp)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("zip did not contain OpenUI.app");
  }
  await rm(zipPath, { force: true });
  return newApp;
}

// Detached script that waits for this process to exit, swaps the bundle,
// and optionally relaunches. Survives app.quit() because it's disowned.
async function spawnSwapScript(relaunch: boolean): Promise<void> {
  const appPath = runningBundlePath();
  if (!appPath || !pendingAppPath) return;

  const script = `#!/bin/bash
for i in $(seq 1 150); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.2; done
BACKUP="${appPath}.update-backup"
rm -rf "$BACKUP"
mv "${appPath}" "$BACKUP" || exit 1
if mv "${pendingAppPath}" "${appPath}"; then
  rm -rf "$BACKUP"
  xattr -dr com.apple.quarantine "${appPath}" 2>/dev/null
else
  mv "$BACKUP" "${appPath}"
  exit 1
fi
${relaunch ? `open "${appPath}"` : ""}
`;
  const scriptPath = join(tmpdir(), `openui-swap-${process.pid}.sh`);
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" }).unref();
}

async function checkOnce(getWindow: () => BrowserWindow | null): Promise<void> {
  if (checking || pendingAppPath) return;
  checking = true;
  try {
    const latest = await fetchLatestRelease();
    if (!latest || compareVersions(latest.version, app.getVersion()) <= 0) return;

    console.log(`[updater] Update available: v${latest.version} (running v${app.getVersion()})`);
    pendingAppPath = await downloadAndExtract(latest);
    pendingVersion = latest.version;

    const win = getWindow();
    const response = dialog.showMessageBoxSync(win ?? (undefined as any), {
      type: "info",
      title: "Update Ready",
      message: `OpenUI v${latest.version} has been downloaded.`,
      detail: "Restart now to apply the update?",
      buttons: ["Restart", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      await spawnSwapScript(true);
      app.quit();
    } else {
      installOnQuit = true; // applied by installPendingUpdateOnQuit()
    }
  } catch (err: any) {
    console.error("[updater] Mac update failed:", err?.message || err);
  } finally {
    checking = false;
  }
}

export function startMacAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!runningBundlePath()) {
    console.log("[updater] Not running from an .app bundle; skipping mac auto-update");
    return;
  }
  void checkOnce(getWindow);
  setInterval(() => void checkOnce(getWindow), CHECK_INTERVAL_MS).unref();
}

// Called from will-quit: if the user chose "Later", apply the update on the
// way out (no relaunch) — mirrors electron-updater's autoInstallOnAppQuit.
export function installPendingUpdateOnQuit(): void {
  if (installOnQuit && pendingAppPath) {
    console.log(`[updater] Installing pending v${pendingVersion} on quit`);
    void spawnSwapScript(false);
  }
}
