import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createHash, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type {
  TerminalResourceCommandRequest,
  TerminalResourceCommandResult,
  TerminalResourceCommandRunner,
} from "./terminalResourceResolvers";
import type { TerminalPathCommand } from "./terminalSuggestions";
import type {
  TerminalArgumentTemplate,
  TerminalResolvedArgumentValue,
} from "./terminalArgumentResolvers";
import {
  TERMINAL_FILE_MAX_FILES,
  TERMINAL_FILE_MAX_RANGES,
  TERMINAL_PATCH_MAX_BYTES,
  boundedFileReadLimits,
  validTerminalFileLineRanges,
  type TerminalFileReadBatchResult,
  type TerminalFileReadFailureCode,
  type TerminalFileReadRequest,
  type TerminalFileReadSuccess,
} from "./terminalFileTypes";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_RECONNECT_ATTEMPTS = 2;
const RECONNECT_DELAY_MS = 2_000;
const INITIALIZE_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONTROL_PAYLOAD_BYTES = 8 * 1024;
const ASSET_NAMES = [
  "openui_remote_server.py",
  "openui_remote_shell.py",
  "openui.zsh",
  "openui.bash",
  "openui.fish",
] as const;

export type TerminalRemoteState =
  | "idle"
  | "connecting"
  | "initializing"
  | "connected"
  | "reconnecting"
  | "fallback"
  | "disconnected";

export interface TerminalRemoteSnapshot {
  state: TerminalRemoteState;
  target?: string;
  hostId?: string;
  platform?: string;
  reconnectAttempt?: number;
  fallbackReason?: string;
}

export interface TerminalRemoteRunRequest {
  executable: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
}

export interface TerminalRemoteRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

interface RuntimeRegistration {
  token: string;
  controlDirectory: string;
  sshExecutable: string;
  assetVersion: string;
}

interface ActiveRemote {
  target: string;
  controlPath: string;
  assetVersion: string;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RemoteConnection {
  child: ChildProcessWithoutNullStreams;
  generation: number;
  buffer: Buffer;
  pending: Map<number, PendingRequest>;
  handledDisconnect: boolean;
  stderr: string;
}

interface RemoteSession {
  runtime: RuntimeRegistration;
  active?: ActiveRemote;
  connection?: RemoteConnection;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  state: TerminalRemoteState;
  generation: number;
  nextRequestId: number;
  reconnectAttempt: number;
  explicitClose: boolean;
  hostId?: string;
  platform?: string;
  fallbackReason?: string;
  /** Port on the remote host that forwards back to this server (status hooks). */
  hookPort?: number;
  pathCache: Map<string, { expiresAt: number; commands: TerminalPathCommand[] }>;
}

type RemoteControlAction =
  | { action: "connecting"; target: string; controlPath: string }
  | { action: "ready"; target: string; controlPath: string; assetVersion: string }
  | { action: "tunnel"; controlPath: string; port: number }
  | { action: "fallback"; reason: string }
  | { action: "closed"; reason: string };

type RemoteControlEnvelope = RemoteControlAction & {
  version: number;
  token: string;
};

export class TerminalRemoteUnavailableError extends Error {
  constructor(message = "Remote command transport is unavailable") {
    super(message);
    this.name = "TerminalRemoteUnavailableError";
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeTarget(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\x00-\x20\x7f]/.test(value);
}

function safeReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/.test(value);
}

function parseControlPayload(payload: string): RemoteControlEnvelope | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(payload)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(payload, "base64url");
  } catch {
    return null;
  }
  if (!decoded.length || decoded.length > MAX_CONTROL_PAYLOAD_BYTES) return null;
  let value: any;
  try {
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || value.version !== PROTOCOL_VERSION || !/^[a-f0-9]{64}$/.test(value.token)) {
    return null;
  }
  if (value.action === "connecting" && safeTarget(value.target) && typeof value.controlPath === "string") {
    return value as RemoteControlEnvelope;
  }
  if (
    value.action === "ready" && safeTarget(value.target) && typeof value.controlPath === "string" &&
    /^[a-f0-9]{32}$/.test(value.assetVersion)
  ) {
    return value as RemoteControlEnvelope;
  }
  if ((value.action === "fallback" || value.action === "closed") && safeReason(value.reason)) {
    return value as RemoteControlEnvelope;
  }
  if (
    value.action === "tunnel" && typeof value.controlPath === "string" &&
    Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
  ) {
    return value as RemoteControlEnvelope;
  }
  return null;
}

function assetPath(root: string, name: typeof ASSET_NAMES[number]): string {
  return name.startsWith("openui.")
    ? join(root, "shell-integration", name)
    : join(root, "remote-terminal", name);
}

export function terminalRemoteAssetVersion(root: string): string | null {
  const hash = createHash("sha256");
  try {
    for (const name of ASSET_NAMES) {
      hash.update(name).update("\0").update(readFileSync(assetPath(root, name))).update("\0");
    }
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 32);
}

function boundedEnvironment(
  source: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source || {}).slice(0, 512)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value === undefined) continue;
    if (value.length > 32_768 || /\0/.test(value)) continue;
    environment[key] = value;
  }
  return environment;
}

const REMOTE_PATH_SCAN = String.raw`
import json, os, stat, sys
path_value, cwd = sys.argv[1], sys.argv[2]
seen_names, seen_dirs, result = set(), set(), []
for path_index, raw in enumerate(path_value.split(os.pathsep)[:64]):
    directory = os.path.abspath(raw if os.path.isabs(raw) else os.path.join(cwd, raw or "."))
    if directory in seen_dirs:
        continue
    seen_dirs.add(directory)
    try:
        names = sorted(os.listdir(directory))[:5000]
    except OSError:
        continue
    for name in names:
        if name in seen_names or not name or len(name) > 255:
            continue
        candidate = os.path.join(directory, name)
        try:
            mode = os.stat(candidate).st_mode
            if not stat.S_ISREG(mode) or not os.access(candidate, os.X_OK):
                continue
        except OSError:
            continue
        seen_names.add(name)
        result.append({"name": name, "path": candidate, "directory": directory, "pathIndex": path_index})
        if len(result) >= 10000:
            break
    if len(result) >= 10000:
        break
print(json.dumps(result, separators=(",", ":")))
`;

const REMOTE_ARGUMENT_SCAN = String.raw`
import json, os, subprocess, sys
templates = set(json.loads(sys.argv[1]))
cwd, fragment = sys.argv[2], sys.argv[3]
environment = json.loads(sys.argv[4])
maximum = 500
values = []
seen = set()

def append(value, title, description, source="filesystem"):
    if not value or value in seen or len(values) >= 1024:
        return
    if any(ord(char) < 32 or ord(char) == 127 for char in value + title + description):
        return
    seen.add(value)
    values.append({"value": value, "title": title, "description": description, "source": source,
                   "needsShellQuoting": any(char.isspace() for char in value)})

def entries(directory):
    try:
        return sorted(os.listdir(directory))[:maximum]
    except OSError:
        return []

def expanded_path(base, token):
    if token == "~":
        return os.path.expanduser("~")
    if token.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), token[2:])
    return token if os.path.isabs(token) else os.path.abspath(os.path.join(base, token or "."))

def path_values(base, token, want_files, want_folders, navigation=False, source="filesystem"):
    trailing = token.endswith("/")
    expanded = expanded_path(base, token)
    directory = expanded if trailing or token == "" else os.path.dirname(expanded)
    name_fragment = "" if trailing or token == "" else os.path.basename(expanded).lower()
    prefix_index = token.rfind("/")
    token_prefix = token if trailing else (token[:prefix_index + 1] if prefix_index >= 0 else "")
    for name in entries(directory):
        if name.startswith(".") and not name_fragment.startswith("."):
            continue
        if name_fragment and name_fragment not in name.lower():
            continue
        absolute = os.path.join(directory, name)
        try:
            is_directory = os.path.isdir(absolute)
        except OSError:
            continue
        if is_directory and not want_folders or not is_directory and not want_files:
            continue
        if navigation:
            display = token_prefix + name + ("/" if is_directory else "")
        else:
            display = os.path.relpath(absolute, cwd)
            if not display.startswith("..") and not os.path.isabs(display):
                display = "./" + display
            if is_directory:
                display += "/"
        append(display, name + ("/" if is_directory else ""), absolute, source)

if "files" in templates:
    path_values(cwd, fragment, True, False)
if "folders" in templates:
    path_values(cwd, fragment, False, True)
if "files-and-folders" in templates:
    path_values(cwd, fragment, True, True)
if "cd-folders" in templates:
    normalized = fragment.replace("\\", "/")
    explicit = normalized.startswith(("/", "~", "./", "../")) or normalized in (".", "..")
    cdpath = environment.get("CDPATH")
    if explicit or cdpath is None:
        path_values(cwd, fragment, False, True, True)
    else:
        searched_cwd = False
        for raw in cdpath.split(":")[:64]:
            if raw in ("", "."):
                if searched_cwd:
                    continue
                base, source = cwd, "filesystem"
                searched_cwd = True
            else:
                base = expanded_path(cwd, raw)
                source = "cdpath"
            path_values(base, fragment, False, True, True, source)
        if not searched_cwd:
            path_values(cwd, fragment, False, True, True)

if "package-scripts" in templates:
    current = os.path.abspath(cwd)
    for _ in range(17):
        manifest = os.path.join(current, "package.json")
        try:
            if os.path.getsize(manifest) <= 1024 * 1024:
                with open(manifest, "r", encoding="utf-8") as handle:
                    scripts = json.load(handle).get("scripts", {})
                if isinstance(scripts, dict):
                    for name in sorted(scripts)[:1024]:
                        if isinstance(name, str) and name:
                            append(name, name, "Package script", "package-manifest")
                break
        except (OSError, ValueError, AttributeError):
            pass
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

if "git-branches" in templates or "git-refs" in templates:
    try:
        completed = subprocess.run(["git", "-C", cwd, "for-each-ref", "--format=%(refname)"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, timeout=2, check=False)
        if completed.returncode == 0 and len(completed.stdout) <= 4 * 1024 * 1024:
            for line in completed.stdout.decode("utf-8", "replace").splitlines()[:2048]:
                if line.startswith("refs/heads/"):
                    append(line[11:], line[11:], "Local branch", "git-ref")
                elif line.startswith("refs/remotes/") and not line.endswith("/HEAD"):
                    append(line[13:], line[13:], "Remote branch", "git-ref")
                elif "git-refs" in templates and line.startswith("refs/tags/"):
                    append(line[10:], line[10:], "Git tag", "git-ref")
    except (OSError, subprocess.SubprocessError):
        pass

print(json.dumps(values, separators=(",", ":")))
`;

class TerminalRemoteManager {
  private readonly sessions = new Map<string, RemoteSession>();

  registerRuntime(sessionId: string, runtime: RuntimeRegistration) {
    this.deregister(sessionId);
    this.sessions.set(sessionId, {
      runtime,
      state: "idle",
      generation: 0,
      nextRequestId: 1,
      reconnectAttempt: 0,
      explicitClose: false,
      pathCache: new Map(),
    });
  }

  handleControlPayload(sessionId: string, payload: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const envelope = parseControlPayload(payload);
    if (!envelope || !safeEqual(envelope.token, session.runtime.token)) return false;

    if (envelope.action === "tunnel") {
      if (!this.validControlPath(session, envelope.controlPath)) return false;
      session.hookPort = envelope.port;
      return true;
    }
    if (envelope.action === "connecting") {
      if (!this.validControlPath(session, envelope.controlPath)) return false;
      this.stopConnection(session, new TerminalRemoteUnavailableError("Remote SSH connection was replaced"));
      session.active = undefined;
      session.hookPort = undefined;
      session.state = "connecting";
      session.explicitClose = false;
      session.fallbackReason = undefined;
      session.pathCache.clear();
      return true;
    }
    if (envelope.action === "ready") {
      if (
        !this.validControlPath(session, envelope.controlPath) ||
        envelope.assetVersion !== session.runtime.assetVersion
      ) return false;
      session.active = {
        target: envelope.target,
        controlPath: resolve(envelope.controlPath),
        assetVersion: envelope.assetVersion,
      };
      session.explicitClose = false;
      session.reconnectAttempt = 0;
      session.fallbackReason = undefined;
      this.connect(sessionId, session);
      return true;
    }
    if (envelope.action === "fallback") {
      session.explicitClose = true;
      session.fallbackReason = envelope.reason;
      session.state = "fallback";
      session.active = undefined;
      this.stopConnection(session, new TerminalRemoteUnavailableError("SSH session entered legacy fallback"));
      return true;
    }
    session.explicitClose = true;
    session.state = "idle";
    session.active = undefined;
    this.stopConnection(session, new TerminalRemoteUnavailableError("Remote SSH session closed"));
    return true;
  }

  snapshot(sessionId: string): TerminalRemoteSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      state: session.state,
      target: session.active?.target,
      hostId: session.hostId,
      platform: session.platform,
      reconnectAttempt: session.state === "reconnecting" ? session.reconnectAttempt : undefined,
      fallbackReason: session.fallbackReason,
    };
  }

  isConnected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.state === "connected";
  }

  hasRuntime(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hookPort(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.hookPort;
  }

  async run(sessionId: string, request: TerminalRemoteRunRequest): Promise<TerminalRemoteRunResult> {
    const session = this.sessions.get(sessionId);
    const connection = session?.connection;
    if (!session || session.state !== "connected" || !connection) {
      throw new TerminalRemoteUnavailableError();
    }
    if (
      !request.executable || request.executable.length > 4_096 || /\0/.test(request.executable) ||
      request.args.length > 128 || request.args.some((arg) => arg.length > 32_768 || /\0/.test(arg)) ||
      !request.cwd || request.cwd.length > 16_384 || /\0/.test(request.cwd) ||
      (request.stdin !== undefined && (
        typeof request.stdin !== "string" || Buffer.byteLength(request.stdin, "utf8") > TERMINAL_PATCH_MAX_BYTES
      ))
    ) {
      throw new Error("Invalid remote command request");
    }
    const timeoutMs = Math.max(50, Math.min(MAX_REQUEST_TIMEOUT_MS, request.timeoutMs || 2_000));
    const response = await this.sendRequest(session, connection, {
      type: "run",
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      environment: boundedEnvironment(request.environment),
      timeoutMs,
      maxOutputBytes: Math.max(1_024, Math.min(256 * 1024, request.maxOutputBytes || 256 * 1024)),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    }, timeoutMs + 1_000, true);
    if (response.type === "error") throw new Error(String(response.error || "Remote command failed"));
    if (response.type !== "run_result") throw new Error("Unexpected remote command response");
    return {
      exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
      timedOut: response.timedOut === true,
      truncated: response.truncated === true,
    };
  }

  async readFiles(
    sessionId: string,
    request: TerminalFileReadRequest,
  ): Promise<TerminalFileReadBatchResult> {
    const session = this.sessions.get(sessionId);
    const connection = session?.connection;
    if (!session || session.state !== "connected" || !connection) {
      throw new TerminalRemoteUnavailableError();
    }
    if (
      !request.root || request.root.length > 16_384 || /[\x00-\x1f\x7f]/.test(request.root) ||
      !Array.isArray(request.files) || !request.files.length || request.files.length > TERMINAL_FILE_MAX_FILES
    ) throw new Error("Invalid remote file-read request");
    const files = request.files.map((file) => {
      const ranges = validTerminalFileLineRanges(file?.lineRanges);
      if (
        !file || typeof file.path !== "string" || !file.path || file.path.length > 4_096 ||
        /[\x00-\x1f\x7f]/.test(file.path) || ranges === null
      ) throw new Error("Invalid remote file-read location");
      return { path: file.path, lineRanges: ranges };
    });
    const limits = boundedFileReadLimits(request);
    const response = await this.sendRequest(session, connection, {
      type: "read_files",
      root: request.root,
      files,
      maxFileBytes: limits.maxFileBytes,
      maxBatchBytes: limits.maxBatchBytes,
      includeBinary: request.includeBinary === true,
    }, 6_000, true);
    if (response.type === "error") throw new Error(String(response.error || "Remote file read failed"));
    if (
      response.type !== "read_files_result" || typeof response.root !== "string" ||
      !response.root || response.root.length > 16_384 || /[\x00-\x1f\x7f]/.test(response.root) ||
      !Array.isArray(response.files) || !Array.isArray(response.failedFiles) ||
      response.files.length + response.failedFiles.length > files.length ||
      typeof response.bytesReturned !== "number" || !Number.isSafeInteger(response.bytesReturned) || response.bytesReturned < 0 ||
      response.bytesReturned > limits.maxBatchBytes || typeof response.truncated !== "boolean"
    ) throw new Error("Invalid remote file-read response");
    const failureCodes = new Set<TerminalFileReadFailureCode>([
      "invalid_path", "outside_root", "not_found", "not_file", "binary_disallowed",
      "scan_limit", "budget_exhausted", "cancelled", "io_error",
    ]);
    const parsedFiles: TerminalFileReadSuccess[] = [];
    let parsedBytes = 0;
    for (const value of response.files as any[]) {
      if (
        !value || typeof value.path !== "string" || typeof value.relativePath !== "string" ||
        (value.kind !== "text" && value.kind !== "binary") ||
        !Number.isSafeInteger(value.size) || value.size < 0 ||
        typeof value.modified !== "number" || !Number.isFinite(value.modified) ||
        typeof value.truncated !== "boolean" || value.path.length > 16_384 ||
        !value.relativePath || value.relativePath.length > 4_096 ||
        value.relativePath.startsWith("/") || value.relativePath.split("/").some((part: string) => part === "..") ||
        /[\x00-\x1f\x7f]/.test(value.path + value.relativePath) ||
        (value.mime !== undefined && (
          typeof value.mime !== "string" || value.mime.length > 256 || /[\x00-\x1f\x7f]/.test(value.mime)
        ))
      ) continue;
      if (value.kind === "text") {
        if (!Array.isArray(value.segments) || value.segments.length > TERMINAL_FILE_MAX_RANGES) continue;
        const segments = [];
        let fileBytes = 0;
        let invalidSegment = false;
        for (const segment of value.segments) {
          if (!segment || typeof segment.content !== "string") {
            invalidSegment = true;
            break;
          }
          if (
            (segment.lineStart !== undefined && (
              !Number.isSafeInteger(segment.lineStart) || segment.lineStart < 1 || segment.lineStart > 1_000_000
            )) ||
            (segment.lineEnd !== undefined && (
              !Number.isSafeInteger(segment.lineEnd) || segment.lineEnd < 0 || segment.lineEnd > 1_000_000
            ))
          ) {
            invalidSegment = true;
            break;
          }
          fileBytes += Buffer.byteLength(segment.content, "utf8");
          if (fileBytes > limits.maxFileBytes || parsedBytes + fileBytes > limits.maxBatchBytes) {
            invalidSegment = true;
            break;
          }
          segments.push({
            content: segment.content,
            lineStart: segment.lineStart,
            lineEnd: segment.lineEnd,
          });
        }
        if (invalidSegment || segments.length !== value.segments.length) continue;
        if (value.lineCount !== undefined && (
          !Number.isSafeInteger(value.lineCount) || value.lineCount < 0 || value.lineCount > 1_000_000_000
        )) continue;
        parsedFiles.push({
          path: value.path,
          relativePath: value.relativePath,
          kind: "text" as const,
          size: value.size,
          modified: value.modified,
          mime: typeof value.mime === "string" ? value.mime.slice(0, 256) : undefined,
          segments,
          lineCount: Number.isInteger(value.lineCount) && value.lineCount >= 0 ? value.lineCount : undefined,
          truncated: value.truncated,
        });
        parsedBytes += fileBytes;
        continue;
      }
      if (
        typeof value.base64 !== "string" || value.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
      ) continue;
      const decoded = Buffer.from(value.base64, "base64");
      if (
        decoded.toString("base64") !== value.base64 || decoded.length > limits.maxFileBytes ||
        parsedBytes + decoded.length > limits.maxBatchBytes
      ) continue;
      parsedFiles.push({
        path: value.path,
        relativePath: value.relativePath,
        kind: "binary" as const,
        size: value.size,
        modified: value.modified,
        mime: typeof value.mime === "string" ? value.mime.slice(0, 256) : undefined,
        base64: value.base64,
        truncated: value.truncated,
      });
      parsedBytes += decoded.length;
    }
    if (parsedFiles.length !== response.files.length) throw new Error("Unsafe remote file-read response");
    const failedFiles = response.failedFiles.flatMap((value: any) => {
      if (
        !value || typeof value.path !== "string" || value.path.length > 4_096 ||
        typeof value.code !== "string" || !failureCodes.has(value.code) ||
        /[\x00-\x1f\x7f]/.test(value.path) ||
        typeof value.message !== "string" || value.message.length > 1_024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.message)
      ) return [];
      return [{ path: value.path, code: value.code as TerminalFileReadFailureCode, message: value.message }];
    });
    if (failedFiles.length !== response.failedFiles.length) throw new Error("Invalid remote file failure response");
    if (parsedBytes !== response.bytesReturned) throw new Error("Remote file byte accounting mismatch");
    return {
      root: response.root,
      files: parsedFiles,
      failedFiles,
      bytesReturned: Math.max(0, Math.min(limits.maxBatchBytes, response.bytesReturned)),
      truncated: response.truncated === true,
    };
  }

  resourceRunner(sessionId: string): TerminalResourceCommandRunner | undefined {
    if (!this.isConnected(sessionId)) return undefined;
    return async (request: TerminalResourceCommandRequest): Promise<TerminalResourceCommandResult> => {
      const result = await this.run(sessionId, {
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        environment: request.environment,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
      return { exitCode: result.exitCode, stdout: result.stdout };
    };
  }

  async pathCommands(
    sessionId: string,
    pathValue: string,
    cwd: string,
  ): Promise<TerminalPathCommand[] | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "connected") return undefined;
    const key = createHash("sha256").update(pathValue).update("\0").update(cwd).digest("hex");
    const cached = session.pathCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.commands.map((entry) => ({ ...entry }));
    const result = await this.run(sessionId, {
      executable: "python3",
      args: ["-c", REMOTE_PATH_SCAN, pathValue, cwd],
      cwd,
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1024,
    }).catch(() => null);
    if (!result || result.exitCode !== 0 || result.truncated) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (!Array.isArray(decoded)) return undefined;
    const commands = decoded.flatMap((value: any) => {
      if (
        !value || typeof value.name !== "string" || typeof value.path !== "string" ||
        typeof value.directory !== "string" || !Number.isInteger(value.pathIndex) ||
        !value.name || value.name.length > 255 || value.path.length > 16_384 ||
        value.directory.length > 16_384 || /[\x00-\x1f\x7f]/.test(value.name + value.path + value.directory)
      ) return [];
      return [{
        name: value.name,
        path: value.path,
        directory: value.directory,
        pathIndex: value.pathIndex,
      } satisfies TerminalPathCommand];
    }).slice(0, 10_000);
    session.pathCache.clear();
    session.pathCache.set(key, { expiresAt: Date.now() + 5_000, commands });
    return commands.map((entry) => ({ ...entry }));
  }

  async argumentValues(
    sessionId: string,
    input: {
      templates: TerminalArgumentTemplate[];
      cwd: string;
      fragment: string;
      environment?: Record<string, string | undefined>;
    },
  ): Promise<TerminalResolvedArgumentValue[]> {
    if (!this.isConnected(sessionId)) return [];
    const templates = [...new Set(input.templates)].filter((template) => [
      "files", "folders", "files-and-folders", "cd-folders",
      "package-scripts", "git-branches", "git-refs",
    ].includes(template));
    if (!templates.length) return [];
    const result = await this.run(sessionId, {
      executable: "python3",
      args: [
        "-c",
        REMOTE_ARGUMENT_SCAN,
        JSON.stringify(templates),
        input.cwd,
        input.fragment,
        JSON.stringify(boundedEnvironment(input.environment)),
      ],
      cwd: input.cwd,
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1024,
    }).catch(() => null);
    if (!result || result.exitCode !== 0 || result.truncated) return [];
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(decoded)) return [];
    const sources = new Set<TerminalResolvedArgumentValue["source"]>([
      "filesystem", "cdpath", "package-manifest", "git-ref",
    ]);
    const seen = new Set<string>();
    return decoded.flatMap((value: any) => {
      if (
        !value || typeof value.value !== "string" || !value.value || value.value.length > 16_384 ||
        typeof value.description !== "string" || value.description.length > 16_384 ||
        typeof value.source !== "string" || !sources.has(value.source) ||
        (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 16_384)) ||
        /[\x00-\x1f\x7f]/.test(value.value + value.description + (value.title || "")) ||
        seen.has(value.value)
      ) return [];
      seen.add(value.value);
      return [{
        value: value.value,
        title: value.title,
        description: value.description,
        source: value.source,
        needsShellQuoting: value.needsShellQuoting === true || undefined,
      } satisfies TerminalResolvedArgumentValue];
    }).slice(0, 1_024);
  }

  deregister(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.explicitClose = true;
    this.stopConnection(session, new TerminalRemoteUnavailableError("Terminal session ended"));
    this.sessions.delete(sessionId);
  }

  private validControlPath(session: RemoteSession, path: string): boolean {
    if (!path || path.length > 512 || /[\x00-\x1f\x7f]/.test(path)) return false;
    const absolute = resolve(path);
    return dirname(absolute) === resolve(session.runtime.controlDirectory) &&
      /^c-[a-f0-9]{16}$/.test(basename(absolute));
  }

  private connect(sessionId: string, session: RemoteSession) {
    const active = session.active;
    if (!active || session.explicitClose) return;
    this.stopConnection(session, new TerminalRemoteUnavailableError("Remote command transport reconnecting"));
    session.state = "initializing";
    const generation = ++session.generation;
    const remoteCommand = `exec python3 \"$HOME/.openui/remote/${active.assetVersion}/openui_remote_server.py\"`;
    const child = spawn(session.runtime.sshExecutable, [
      "-S", active.controlPath,
      "-o", "ControlMaster=no",
      "-o", "BatchMode=yes",
      "-o", "PermitLocalCommand=no",
      "-o", "RemoteCommand=none",
      "-o", "SessionType=default",
      active.target,
      remoteCommand,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    const connection: RemoteConnection = {
      child,
      generation,
      buffer: Buffer.alloc(0),
      pending: new Map(),
      handledDisconnect: false,
      stderr: "",
    };
    session.connection = connection;
    child.stdout.on("data", (chunk: Buffer) => this.onData(sessionId, session, connection, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      connection.stderr = (connection.stderr + chunk.toString("utf8")).slice(-4_096);
    });
    child.once("error", (error) => this.onDisconnect(sessionId, session, connection, error));
    child.once("close", (code, signal) => this.onDisconnect(
      sessionId,
      session,
      connection,
      new Error(`Remote command channel exited (code=${code}, signal=${signal || "none"})`),
    ));

    this.sendRequest(session, connection, {
      type: "initialize",
      version: PROTOCOL_VERSION,
      sessionId,
    }, INITIALIZE_TIMEOUT_MS).then((response) => {
      if (session.connection !== connection || connection.generation !== session.generation) return;
      if (response.type !== "initialize_result" || response.version !== PROTOCOL_VERSION) {
        throw new Error("Remote command protocol handshake failed");
      }
      session.hostId = typeof response.hostId === "string" ? response.hostId.slice(0, 512) : undefined;
      session.platform = typeof response.platform === "string" ? response.platform.slice(0, 128) : undefined;
      session.state = "connected";
      session.reconnectAttempt = 0;
    }).catch((error) => this.onDisconnect(sessionId, session, connection, error));
  }

  private sendRequest(
    session: RemoteSession,
    connection: RemoteConnection,
    message: Record<string, unknown>,
    timeoutMs: number,
    abortOnTimeout = false,
  ): Promise<Record<string, unknown>> {
    if (session.connection !== connection || connection.child.stdin.destroyed) {
      return Promise.reject(new TerminalRemoteUnavailableError());
    }
    const id = session.nextRequestId++;
    if (session.nextRequestId > Number.MAX_SAFE_INTEGER) session.nextRequestId = 1;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        connection.pending.delete(id);
        if (abortOnTimeout && session.connection === connection && !connection.child.stdin.destroyed) {
          this.writeFrame(connection, { id: session.nextRequestId++, type: "abort", requestId: id });
        }
        rejectPromise(new Error("Remote command request timed out"));
      }, timeoutMs);
      connection.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
      try {
        this.writeFrame(connection, { id, ...message });
      } catch (error) {
        clearTimeout(timeout);
        connection.pending.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeFrame(connection: RemoteConnection, message: Record<string, unknown>) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (!payload.length || payload.length > MAX_FRAME_BYTES) throw new Error("Remote command frame is too large");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    connection.child.stdin.write(Buffer.concat([header, payload]));
  }

  private onData(
    sessionId: string,
    session: RemoteSession,
    connection: RemoteConnection,
    chunk: Buffer,
  ) {
    if (session.connection !== connection || connection.generation !== session.generation) return;
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (connection.buffer.length >= 4) {
      const length = connection.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) {
        this.onDisconnect(sessionId, session, connection, new Error("Invalid remote command frame"));
        return;
      }
      if (connection.buffer.length < length + 4) return;
      const payload = connection.buffer.subarray(4, length + 4);
      connection.buffer = connection.buffer.subarray(length + 4);
      let message: any;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.onDisconnect(sessionId, session, connection, new Error("Invalid remote command response"));
        return;
      }
      if (!message || !Number.isInteger(message.id)) continue;
      const pending = connection.pending.get(message.id);
      if (!pending) continue;
      connection.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.resolve(message);
    }
  }

  private onDisconnect(
    sessionId: string,
    session: RemoteSession,
    connection: RemoteConnection,
    error: unknown,
  ) {
    if (connection.handledDisconnect || session.connection !== connection) return;
    connection.handledDisconnect = true;
    session.connection = undefined;
    const reason = error instanceof Error ? error : new Error(String(error));
    this.rejectPending(connection, reason);
    if (!connection.child.killed) connection.child.kill("SIGKILL");
    if (session.explicitClose || !session.active || !this.sessions.has(sessionId)) {
      session.state = session.explicitClose ? session.state : "disconnected";
      return;
    }
    if (session.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      session.state = "disconnected";
      return;
    }
    session.reconnectAttempt += 1;
    session.state = "reconnecting";
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = undefined;
      if (!session.explicitClose && session.active && this.sessions.get(sessionId) === session) {
        this.connect(sessionId, session);
      }
    }, RECONNECT_DELAY_MS);
  }

  private rejectPending(connection: RemoteConnection, error: Error) {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  private stopConnection(session: RemoteSession, error: Error) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
    }
    const connection = session.connection;
    session.connection = undefined;
    session.generation += 1;
    if (!connection) return;
    connection.handledDisconnect = true;
    this.rejectPending(connection, error);
    connection.child.stdin.destroy();
    connection.child.stdout.destroy();
    connection.child.stderr.destroy();
    if (!connection.child.killed) connection.child.kill("SIGKILL");
  }
}

export const terminalRemoteManager = new TerminalRemoteManager();
