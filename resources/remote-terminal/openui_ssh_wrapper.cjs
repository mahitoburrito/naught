#!/usr/bin/env node
"use strict";

// This process is launched only by OpenUI's private PATH shim. It deliberately
// instruments a narrow subset of ssh: a plain interactive connection with no
// user-supplied ControlMaster and no remote command. Every other invocation is
// passed to the real ssh executable byte-for-byte at the argv boundary.

const { createHash, randomBytes } = require("crypto");
const { existsSync, lstatSync, readFileSync } = require("fs");
const { basename, isAbsolute, join } = require("path");
const { spawnSync } = require("child_process");

const sshEnvironment = { ...process.env };
for (const name of [
  "OPENUI_REMOTE_CONTROL_TOKEN",
  "OPENUI_SSH_CONTROL_DIR",
  "OPENUI_SSH_REAL_EXECUTABLE",
  "OPENUI_SSH_WRAPPER",
  "OPENUI_REMOTE_ASSET_DIR",
  "OPENUI_NODE_RUNTIME",
  "OPENUI_REMOTE_HOOKS_PORT",
]) delete sshEnvironment[name];

// `ssh -R 0:...` reports the port sshd picked on stderr; that port is what the
// status hooks on the far side post to.
function parseAllocatedPort(text) {
  const match = /Allocated port (\d+) for remote forward/.exec(String(text || ""));
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function hooksPort() {
  const raw = process.env.OPENUI_REMOTE_HOOKS_PORT || "";
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port > 0 && port <= 65535 ? port : null;
}

const VALUE_OPTIONS = new Set("BbcDEeFIiJLlmOopQRSWw");
const UNSUPPORTED_FLAGS = new Set("fGMNnQqstTVWw");
const ASSET_NAMES = [
  "openui_remote_server.py",
  "openui_remote_shell.py",
  "openui.zsh",
  "openui.bash",
  "openui.fish",
];

function finish(result) {
  if (result && result.error) {
    process.stderr.write(`openui ssh: ${result.error.message || String(result.error)}\n`);
    return 255;
  }
  if (typeof result?.status === "number") return result.status;
  if (result?.signal) return 128;
  return 255;
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    stdio: "inherit",
    windowsHide: true,
    env: sshEnvironment,
    ...options,
  });
}

function bypass(realSsh, args) {
  process.exit(finish(run(realSsh, args)));
}

function optionValue(raw, index, args, offset) {
  const attached = raw.slice(offset + 1);
  if (attached) return { value: attached, nextIndex: index };
  if (index + 1 >= args.length) return null;
  return { value: args[index + 1], nextIndex: index + 1 };
}

function parseInteractiveInvocation(args) {
  let destinationIndex = -1;
  let endOfOptions = false;
  let hasControlOption = false;
  const masterOptions = [];

  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (endOfOptions || raw === "-" || !raw.startsWith("-") || raw === "") {
      destinationIndex = index;
      break;
    }
    if (raw === "--") {
      masterOptions.push(raw);
      endOfOptions = true;
      continue;
    }
    if (raw.startsWith("--")) return null;

    let consumesNext = false;
    let omitFromMaster = false;
    for (let offset = 1; offset < raw.length; offset++) {
      const flag = raw[offset];
      if (UNSUPPORTED_FLAGS.has(flag)) return null;
      if (flag === "t") {
        // The master itself has no tty. The interactive slave is forced to
        // allocate one after setup succeeds.
        omitFromMaster = true;
        continue;
      }
      if (!VALUE_OPTIONS.has(flag)) continue;
      const parsed = optionValue(raw, index, args, offset);
      if (!parsed) return null;
      consumesNext = parsed.nextIndex !== index;
      const value = parsed.value;
      if (flag === "S" || flag === "O") hasControlOption = true;
      if (flag === "o" && /^(?:controlmaster|controlpath|controlpersist)\s*=/i.test(value)) {
        hasControlOption = true;
      }
      if (flag === "o" && /^(?:remotecommand|requesttty|sessiontype)\s*=/i.test(value)) {
        return null;
      }
      if (flag === "W" || flag === "w") return null;
      break;
    }
    if (!omitFromMaster) {
      masterOptions.push(raw);
      if (consumesNext) masterOptions.push(args[index + 1]);
    }
    if (consumesNext) index += 1;
  }

  if (hasControlOption || destinationIndex < 0 || destinationIndex !== args.length - 1) return null;
  const destination = args[destinationIndex];
  if (!destination || destination.length > 512 || /[\x00-\x20\x7f]/.test(destination)) return null;
  return { destination, masterOptions };
}

function metadata(action, extra = {}) {
  const token = process.env.OPENUI_REMOTE_CONTROL_TOKEN || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  const payload = Buffer.from(JSON.stringify({ version: 1, token, action, ...extra }), "utf8")
    .toString("base64url");
  process.stdout.write(`\x1b]633;R;${payload}\x07`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function loadAssets(directory) {
  const files = {};
  for (const name of ASSET_NAMES) {
    const path = name.startsWith("openui.")
      ? join(directory, "shell-integration", name)
      : join(directory, "remote-terminal", name);
    files[name] = readFileSync(path, "utf8");
  }
  const hash = createHash("sha256");
  for (const name of ASSET_NAMES) hash.update(name).update("\0").update(files[name]).update("\0");
  return { version: hash.digest("hex").slice(0, 32), files };
}

const INSTALLER = String.raw`
import json, os, re, sys
if sys.version_info < (3, 8):
    raise SystemExit(78)
payload = json.load(sys.stdin)
version = payload.get("version", "")
files = payload.get("files", {})
allowed = {"openui_remote_server.py", "openui_remote_shell.py", "openui.zsh", "openui.bash", "openui.fish"}
if not re.fullmatch(r"[a-f0-9]{32}", version) or set(files) != allowed:
    raise SystemExit(65)
root = os.path.expanduser(os.path.join("~", ".openui", "remote", version))
os.makedirs(root, mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
for name, content in files.items():
    if not isinstance(content, str) or len(content) > 524288:
        raise SystemExit(65)
    compile(content, name, "exec") if name.endswith(".py") else None
    target = os.path.join(root, name)
    temporary = target + ".tmp-" + str(os.getpid())
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    os.chmod(temporary, 0o700 if name.endswith(".py") else 0o600)
    os.replace(temporary, target)
print(root)
`;

function slaveArgs(controlPath, destination, command, forceTty = false) {
  const args = [
    "-S", controlPath,
    "-o", "ControlMaster=no",
    "-o", "BatchMode=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RemoteCommand=none",
    "-o", "SessionType=default",
  ];
  if (forceTty) args.push("-tt");
  args.push(destination);
  if (command !== undefined) args.push(command);
  return args;
}

function closeMaster(realSsh, controlPath, destination) {
  run(realSsh, ["-S", controlPath, "-O", "exit", destination], { stdio: "ignore" });
}

function legacyThroughMaster(realSsh, controlPath, destination, reason) {
  metadata("fallback", { reason });
  const result = run(realSsh, slaveArgs(controlPath, destination));
  metadata("closed", { reason: "legacy_exit" });
  closeMaster(realSsh, controlPath, destination);
  return finish(result);
}

function main() {
  const args = process.argv.slice(2);
  const realSsh = process.env.OPENUI_SSH_REAL_EXECUTABLE || "";
  if (!isAbsolute(realSsh) || basename(realSsh) !== "ssh" || !existsSync(realSsh)) {
    process.stderr.write("openui ssh: real ssh executable is unavailable\n");
    return 255;
  }
  const parsed = parseInteractiveInvocation(args);
  if (!parsed) bypass(realSsh, args);

  const controlDirectory = process.env.OPENUI_SSH_CONTROL_DIR || "";
  const assetDirectory = process.env.OPENUI_REMOTE_ASSET_DIR || "";
  try {
    const stat = lstatSync(controlDirectory);
    if (!isAbsolute(controlDirectory) || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      bypass(realSsh, args);
    }
  } catch {
    bypass(realSsh, args);
  }

  const controlPath = join(controlDirectory, `c-${randomBytes(8).toString("hex")}`);
  metadata("connecting", { target: parsed.destination, controlPath });
  const forwardPort = hooksPort();
  const masterArgs = [
    "-M", "-N", "-f",
    "-S", controlPath,
    "-o", "ControlPersist=600",
    "-o", "ExitOnForwardFailure=yes",
    ...(forwardPort ? ["-R", `0:127.0.0.1:${forwardPort}`] : []),
    ...parsed.masterOptions,
    parsed.destination,
  ];
  // stderr is captured only to read the allocated port; everything is echoed
  // back so host-key and auth messages still reach the terminal.
  const master = run(realSsh, masterArgs, forwardPort ? { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" } : {});
  if (forwardPort && master && master.stderr) process.stderr.write(master.stderr);
  if (finish(master) !== 0) {
    metadata("fallback", { reason: "master_failed" });
    return finish(run(realSsh, args));
  }
  if (forwardPort) {
    const allocated = parseAllocatedPort(master.stderr);
    if (allocated) metadata("tunnel", { controlPath, port: allocated });
  }

  let assets;
  try {
    assets = loadAssets(assetDirectory);
  } catch {
    return legacyThroughMaster(realSsh, controlPath, parsed.destination, "local_assets_unavailable");
  }
  const installCommand = `python3 -c ${shellQuote(INSTALLER)}`;
  const install = run(
    realSsh,
    slaveArgs(controlPath, parsed.destination, installCommand),
    {
      input: JSON.stringify(assets),
      stdio: ["pipe", "ignore", "inherit"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  if (finish(install) !== 0) {
    return legacyThroughMaster(realSsh, controlPath, parsed.destination, "remote_install_unsupported");
  }

  const remoteShellPath = `$HOME/.openui/remote/${assets.version}/openui_remote_shell.py`;
  const shellCheck = run(
    realSsh,
    slaveArgs(controlPath, parsed.destination, `python3 \"${remoteShellPath}\" --check`),
    { stdio: "ignore", timeout: 5_000, killSignal: "SIGKILL" },
  );
  if (finish(shellCheck) !== 0) {
    return legacyThroughMaster(realSsh, controlPath, parsed.destination, "remote_shell_unsupported");
  }

  metadata("ready", {
    target: parsed.destination,
    controlPath,
    assetVersion: assets.version,
  });
  const remoteShell = `exec python3 \"${remoteShellPath}\"`;
  const result = run(realSsh, slaveArgs(controlPath, parsed.destination, remoteShell, true));
  metadata("closed", { reason: "interactive_exit" });
  closeMaster(realSsh, controlPath, parsed.destination);
  return finish(result);
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { parseAllocatedPort, parseInteractiveInvocation };
}
