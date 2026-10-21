import { isResumableSessionId } from "./agentResume";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { PersistedState, Session, TerminalCommandBlock } from "../types";
import { classifyTerminalFailureKind } from "./terminalExit";

// Use local .openui-desktop folder where user ran from
// Resolved lazily so LAUNCH_CWD env var is available after Electron app.whenReady()
import { homedir } from "os";
import { redactTerminalText } from "./terminalRedaction";
import { terminalOutputToPlainText } from "./terminalSharing";

const PERSISTENCE_VERSION = 2 as const;
const MAX_PERSISTED_SESSIONS = 100;
const MAX_PERSISTED_CATEGORIES = 100;
const MAX_REPLAY_CHARS = 2_000_000;
const MAX_BLOCKS_PER_SESSION = 250;
const MAX_BLOCK_OUTPUT_CHARS = 200_000;
const MAX_COMMAND_CHARS = 4_096;
const MAX_CWD_CHARS = 4_096;
const MAX_NOTE_CHARS = 2_000;
const REPLAY_TRUNCATION_MARKER = "\n… [OpenUI restored scrollback truncated] …\n";
const MAX_STATE_FILE_BYTES = 5_000_000;
const MAX_BUFFER_FILE_BYTES = 12_000_000;
const MAX_BLOCKS_FILE_BYTES = 64_000_000;
const incompatibleVersionFiles = new Set<string>();
const warnedIncompatibleVersionFiles = new Set<string>();

// What the last successful periodic write actually put on disk, per session.
// saveState runs every 10s over every session; without this it re-serialises
// and rewrites multi-MB scrollback for sessions that have been idle for hours.
// Cleared on delete so a recycled session id can never inherit a stale entry.
const persistedBufferRevisions = new Map<string, string>();
const persistedBlockSignatures = new Map<string, string>();

function bufferRevisionKey(session: Session): string {
  // outputBufferRev counts mutations of the scrollback and is the exact signal.
  // The rest disambiguates a session restored from disk, whose rev restarts at
  // 0 while its buffer already holds content.
  return [
    session.outputBufferRev || 0,
    session.outputBuffer.length,
    session.outputBufferChars || 0,
    session.outputBufferTruncated === true ? 1 : 0,
  ].join(":");
}

function blockSignature(blocks: TerminalCommandBlock[]): string {
  // Must fold over EVERY block, not just the tail. Bookmarks and notes are
  // applied in place to whichever block the user picked, which is usually not
  // the last one, and a tail-only signature would skip persisting them.
  //
  // Cheap by construction: lengths and flags rather than content, plus a hash
  // of the note (bounded at 2000 chars and absent on almost every block) so a
  // same-length edit still moves the signature.
  let hash = 5381;
  for (const block of blocks) {
    hash = foldString(hash, block.id);
    hash = foldNumber(hash, block.sequence);
    hash = foldString(hash, block.status);
    hash = foldNumber(hash, block.completedAt || 0);
    hash = foldNumber(hash, block.exitCode ?? -1);
    hash = foldNumber(hash, block.output.length);
    hash = foldNumber(hash, block.outputTruncated === true ? 1 : 0);
    hash = foldNumber(hash, block.bookmarked === true ? 1 : 0);
    if (block.note) hash = foldString(hash, block.note);
  }
  return `${blocks.length}:${hash >>> 0}`;
}

// djb2. Only ever compared against itself, never persisted or used as an id.
function foldString(hash: number, value: string): number {
  let next = hash;
  for (let i = 0; i < value.length; i++) next = (next * 33) ^ value.charCodeAt(i);
  return next | 0;
}

function foldNumber(hash: number, value: number): number {
  return ((hash * 33) ^ value) | 0;
}

/** Forget dirty-tracking state for a session. Safe to call for unknown ids. */
export function forgetPersistedSignatures(sessionId: string) {
  persistedBufferRevisions.delete(sessionId);
  persistedBlockSignatures.delete(sessionId);
}

export interface LoadedTerminalBuffer {
  chunks: string[];
  truncated: boolean;
}

const validatedFileSignatures = new Map<string, { size: number; mtimeMs: number }>();

function recordValidatedFile(path: string) {
  try {
    const stat = statSync(path);
    validatedFileSignatures.set(path, { size: stat.size, mtimeMs: stat.mtimeMs });
  } catch {
    validatedFileSignatures.delete(path);
  }
}

function validatedFileIsUnchanged(path: string): boolean {
  const expected = validatedFileSignatures.get(path);
  if (!expected) return false;
  try {
    const actual = statSync(path);
    return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return undefined;
  return value.slice(0, max);
}

function boundedIdentifier(value: unknown, max = 512): string | undefined {
  const candidate = boundedString(value, max);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate) ? candidate : undefined;
}

function assertSessionId(sessionId: string) {
  if (boundedIdentifier(sessionId) !== sessionId) throw new Error("Invalid persisted session ID");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type SupportedPersistenceVersion = 0 | 1 | typeof PERSISTENCE_VERSION;

/** Missing versions are the original OpenUI JSON shape. */
function persistenceEnvelopeVersion(value: unknown): SupportedPersistenceVersion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "version") || (value as any).version === undefined) return 0;
  const version = (value as any).version;
  return version === 1 || version === PERSISTENCE_VERSION ? version : null;
}

function hasUnsupportedExplicitVersion(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "version") &&
    (value as any).version !== undefined &&
    persistenceEnvelopeVersion(value) === null,
  );
}

function noteCurrentEnvelopeVersion(path: string, value: unknown, supported: boolean) {
  if (supported) {
    incompatibleVersionFiles.delete(path);
    warnedIncompatibleVersionFiles.delete(path);
  }
  else if (hasUnsupportedExplicitVersion(value)) incompatibleVersionFiles.add(path);
}

class UnsupportedPersistenceVersionError extends Error {
  constructor(readonly path: string) {
    super(`Refusing to overwrite persistence created by an unsupported schema version: ${path}`);
  }
}

function reportPersistenceSaveError(label: string, error: unknown) {
  if (error instanceof UnsupportedPersistenceVersionError) {
    if (!warnedIncompatibleVersionFiles.has(error.path)) {
      warnedIncompatibleVersionFiles.add(error.path);
      console.warn(`[persistence] ${error.message}`);
    }
    return;
  }
  console.error(label, error);
}

function assertVersionWritable(path: string) {
  if (!incompatibleVersionFiles.has(path)) return;
  if (!existsSync(path)) {
    incompatibleVersionFiles.delete(path);
    warnedIncompatibleVersionFiles.delete(path);
    return;
  }
  throw new UnsupportedPersistenceVersionError(path);
}

function migrateCurrentEnvelope(path: string, value: unknown, label: string) {
  try {
    // The parsed current file has passed full semantic validation, so it is a
    // valid generation to retain as the pre-migration backup.
    recordValidatedFile(path);
    atomicWriteFile(path, JSON.stringify(value, null, 2));
    incompatibleVersionFiles.delete(path);
    warnedIncompatibleVersionFiles.delete(path);
    console.log(`[persistence] Migrated ${label} to version ${PERSISTENCE_VERSION}`);
  } catch (error) {
    // Returning the in-memory migrated value is safe; a later periodic save can
    // retry without making startup depend on a writable filesystem.
    console.error(`[persistence] Failed to migrate ${label}:`, error);
  }
}

function atomicWriteFile(path: string, content: string) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const displaced = `${path}.old-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const backup = `${path}.bak`;
  const rotateValidatedCurrent = validatedFileIsUnchanged(path);
  let descriptor: number | undefined;
  let currentWasDisplaced = false;
  let committed = false;
  let preserveDisplaced = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, content, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    if (existsSync(path)) {
      renameSync(path, displaced);
      currentWasDisplaced = true;
    }
    renameSync(temporary, path);
    committed = true;
    recordValidatedFile(path);

    if (currentWasDisplaced) {
      if (rotateValidatedCurrent) {
        try {
          rmSync(backup, { force: true });
          renameSync(displaced, backup);
        } catch (error) {
          // The newly committed current generation is valid. Leave the
          // displaced generation available for recovery if backup rotation
          // itself is interrupted or unsupported.
          preserveDisplaced = true;
          console.warn(`[persistence] Could not rotate backup for ${path}:`, error);
        }
      } else {
        try { rmSync(displaced, { force: true }); } catch {}
      }
    }
    try {
      const directoryDescriptor = openSync(dirname(path), "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Directory fsync is unavailable on some Windows filesystems.
    }
    cleanupAtomicDebris(path, preserveDisplaced ? displaced : undefined);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
    if (!committed && currentWasDisplaced && !existsSync(path) && existsSync(displaced)) {
      try { renameSync(displaced, path); } catch {}
    }
    throw error;
  }
}

function cleanupAtomicDebris(path: string, preserve?: string) {
  try {
    const prefix = basename(path);
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(`${prefix}.old-`) && !name.startsWith(`${prefix}.tmp-`)) continue;
      const candidate = join(dirname(path), name);
      if (candidate !== preserve) rmSync(candidate, { force: true });
    }
  } catch {}
}

function readJsonCandidates(path: string, maxBytes: number): Array<{ path: string; value: unknown }> {
  const values: Array<{ path: string; value: unknown }> = [];
  let recoveryCandidates: string[] = [];
  try {
    const prefix = basename(path);
    recoveryCandidates = readdirSync(dirname(path))
      .filter((name) => name.startsWith(`${prefix}.old-`) || name.startsWith(`${prefix}.tmp-`))
      .map((name) => join(dirname(path), name))
      .sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
      });
  } catch {}
  for (const candidate of [path, `${path}.bak`, ...recoveryCandidates]) {
    try {
      if (!existsSync(candidate)) continue;
      if (statSync(candidate).size > maxBytes) {
        if (candidate === path) validatedFileSignatures.delete(path);
        continue;
      }
      values.push({ path: candidate, value: JSON.parse(readFileSync(candidate, "utf8")) });
    } catch {
      if (candidate === path) validatedFileSignatures.delete(path);
      // Try the previous atomic generation.
    }
  }
  return values;
}

function redactPlainTerminalText(
  value: string,
  knownSecrets: readonly string[] = [],
  options: { frameRedrawsInPlace?: boolean } = {},
): { text: string; sensitive: boolean; secrets: string[] } {
  const initial = redactTerminalText(value, knownSecrets);
  const plain = terminalOutputToPlainText(initial.text, options);
  // Controls can bisect a token. Always rescan after normalization so removing
  // SGR/OSC bytes cannot create a new, unexamined secret in persisted text.
  const normalized = redactTerminalText(plain, [...knownSecrets, ...initial.secrets]);
  return {
    text: normalized.text,
    sensitive: initial.sensitive || normalized.sensitive,
    secrets: [...new Set([...initial.secrets, ...normalized.secrets])].slice(0, 50),
  };
}

function boundedReplay(value: string, alreadyTruncated = false): { data: string; truncated: boolean } {
  const plain = redactPlainTerminalText(value).text;
  if (plain.length <= MAX_REPLAY_CHARS && !alreadyTruncated) return { data: plain, truncated: false };
  const keep = Math.max(0, MAX_REPLAY_CHARS - REPLAY_TRUNCATION_MARKER.length);
  const source = plain.startsWith(REPLAY_TRUNCATION_MARKER)
    ? plain.slice(REPLAY_TRUNCATION_MARKER.length)
    : plain;
  return {
    data: `${REPLAY_TRUNCATION_MARKER}${source.slice(source.length - keep)}`,
    truncated: true,
  };
}

export function terminalReplayText(buffer: string[], alreadyTruncated = false): { data: string; truncated: boolean } {
  return boundedReplay(buffer.join(""), alreadyTruncated);
}

export function getDataDir(): string {
  const explicitDataDir = process.env.OPENUI_DATA_DIR?.trim();
  if (explicitDataDir) {
    return isAbsolute(explicitDataDir) ? explicitDataDir : resolve(explicitDataDir);
  }
  const launchCwd = process.env.LAUNCH_CWD || homedir();
  return join(launchCwd, ".openui-desktop");
}

function getStateFile(): string {
  return join(getDataDir(), "state.json");
}

function getBuffersDir(): string {
  return join(getDataDir(), "buffers");
}

function getTerminalBlocksDir(): string {
  return join(getDataDir(), "terminal-blocks");
}

function ensureDirs() {
  const dataDir = getDataDir();
  const buffersDir = getBuffersDir();
  const terminalBlocksDir = getTerminalBlocksDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(buffersDir)) mkdirSync(buffersDir, { recursive: true, mode: 0o700 });
  if (!existsSync(terminalBlocksDir)) mkdirSync(terminalBlocksDir, { recursive: true, mode: 0o700 });
  for (const directory of [dataDir, buffersDir, terminalBlocksDir]) {
    try { chmodSync(directory, 0o700); } catch {}
  }
}

function validateShellLaunch(value: unknown): { shell: string; args: string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const shell = boundedString((value as any).shell, 4_096);
  const rawArgs = (value as any).args;
  if (!shell || !Array.isArray(rawArgs) || rawArgs.length > 32) return undefined;
  const args = rawArgs.flatMap((arg) => {
    const parsed = boundedString(arg, 1_024);
    return parsed === undefined ? [] : [parsed];
  });
  if (args.length !== rawArgs.length) return undefined;
  return { shell, args };
}

function validateCheckpoint(value: unknown): PersistedState["nodes"][number]["launchCheckpoint"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const id = boundedIdentifier(raw.id);
  const repoRoot = boundedString(raw.repoRoot, MAX_CWD_CHARS);
  const name = boundedString(raw.name, 1_024);
  const createdAt = finiteNumber(raw.createdAt);
  if (!id || !repoRoot || name === undefined || createdAt === undefined || !Array.isArray(raw.files)) return undefined;
  const files = raw.files.slice(0, 10_000).flatMap((file: any) => {
    const path = boundedString(file?.path, MAX_CWD_CHARS);
    return path === undefined || typeof file?.exists !== "boolean" ? [] : [{ path, exists: file.exists }];
  });
  return {
    id,
    repoRoot,
    name,
    createdAt,
    files,
    source: raw.source === "manual" || raw.source === "session-launch" ? raw.source : undefined,
    sessionId: boundedIdentifier(raw.sessionId),
    nodeId: boundedIdentifier(raw.nodeId),
  };
}

function validatePermissionEvents(value: unknown): PersistedState["nodes"][number]["agentPermissionEvents"] {
  if (!Array.isArray(value)) return undefined;
  return value.slice(-200).flatMap((raw: any) => {
    const id = boundedIdentifier(raw?.id);
    const createdAt = finiteNumber(raw?.createdAt);
    const toolName = boundedString(raw?.toolName, 256);
    const reason = boundedString(raw?.reason, 2_000);
    const profileId = boundedIdentifier(raw?.profileId, 256);
    const profileVersion = raw?.profileVersion;
    if (
      !id || createdAt === undefined || toolName === undefined || reason === undefined || !profileId ||
      !Number.isSafeInteger(profileVersion) || profileVersion < 1 ||
      (raw.decision !== "deny" && raw.decision !== "provider-flow")
    ) return [];
    return [{ id, createdAt, toolName, decision: raw.decision, reason, profileId, profileVersion }];
  });
}

function validatePersistedNode(value: unknown): PersistedState["nodes"][number] | null {
  if (!value || typeof value !== "object") return null;
  const node = value as any;
  const nodeId = boundedIdentifier(node.nodeId);
  const sessionId = boundedIdentifier(node.sessionId);
  const agentId = boundedIdentifier(node.agentId, 256);
  const agentName = boundedString(node.agentName, 512);
  const command = boundedString(node.command, 16_384);
  const cwd = boundedString(node.cwd, MAX_CWD_CHARS);
  const createdAt = boundedString(node.createdAt, 128);
  const x = finiteNumber(node.position?.x);
  const y = finiteNumber(node.position?.y);
  if (!nodeId || !sessionId || !agentId || agentName === undefined || command === undefined || !cwd || !createdAt) return null;
  if (!Number.isFinite(Date.parse(createdAt)) || x === undefined || y === undefined) return null;
  const terminalCols = finiteNumber(node.terminalCols);
  const terminalRows = finiteNumber(node.terminalRows);
  return {
    nodeId,
    sessionId,
    agentId,
    agentName,
    command,
    cwd,
    originalCwd: boundedString(node.originalCwd, MAX_CWD_CHARS),
    createdAt,
    customName: boundedString(node.customName, 1_024),
    generatedTitle: boundedString(node.generatedTitle, 1_024),
    titlePromptHistory: Array.isArray(node.titlePromptHistory)
      ? node.titlePromptHistory.slice(-8).flatMap((item: unknown) => {
          const parsed = boundedString(item, 12_000);
          return parsed === undefined ? [] : [parsed];
        })
      : undefined,
    customColor: boundedString(node.customColor, 128),
    notes: boundedString(node.notes, 20_000),
    icon: boundedString(node.icon, 512),
    position: { x, y },
    worktreePaths: node.worktreePaths && typeof node.worktreePaths === "object"
      ? Object.fromEntries(Object.entries(node.worktreePaths).slice(0, 32).flatMap(([name, path]) => {
          const safeName = boundedString(name, 256);
          const safePath = boundedString(path, MAX_CWD_CHARS);
          return safeName && safePath ? [[safeName, safePath]] : [];
        }))
      : undefined,
    launchCheckpoint: validateCheckpoint(node.launchCheckpoint),
    agentProfileId: boundedIdentifier(node.agentProfileId, 256),
    agentProfileVersion: Number.isSafeInteger(node.agentProfileVersion) && node.agentProfileVersion > 0
      ? node.agentProfileVersion
      : undefined,
    agentPermissionPolicy: ["ask", "allow-edits", "read-only"].includes(node.agentPermissionPolicy)
      ? node.agentPermissionPolicy
      : undefined,
    agentAllowedTools: Array.isArray(node.agentAllowedTools)
      ? node.agentAllowedTools.slice(0, 128).flatMap((item: unknown) => {
          const parsed = boundedString(item, 256);
          return parsed === undefined ? [] : [parsed];
        })
      : undefined,
    agentRuntimeManifestPath: boundedString(node.agentRuntimeManifestPath, MAX_CWD_CHARS),
    agentModel: boundedString(node.agentModel, 256),
    resumeSessionId: isResumableSessionId(node.resumeSessionId) ? node.resumeSessionId : undefined,
    agentPermissionEvents: validatePermissionEvents(node.agentPermissionEvents),
    shellLaunch: validateShellLaunch(node.shellLaunch),
    terminalCols: terminalCols === undefined ? undefined : Math.max(2, Math.min(1_000, Math.floor(terminalCols))),
    terminalRows: terminalRows === undefined ? undefined : Math.max(2, Math.min(1_000, Math.floor(terminalRows))),
    terminalFrameRedrawsInPlace: node.terminalFrameRedrawsInPlace === true || undefined,
  };
}

function validatePersistedState(value: unknown): PersistedState | null {
  if (
    persistenceEnvelopeVersion(value) === null ||
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as any).nodes)
  ) return null;
  const seenSessions = new Set<string>();
  const seenNodes = new Set<string>();
  const seenCategories = new Set<string>();
  const nodes = (value as any).nodes.slice(0, MAX_PERSISTED_SESSIONS).flatMap((raw: unknown) => {
    const node = validatePersistedNode(raw);
    if (!node || seenSessions.has(node.sessionId) || seenNodes.has(node.nodeId)) return [];
    seenSessions.add(node.sessionId);
    seenNodes.add(node.nodeId);
    return [node];
  });
  const categories = Array.isArray((value as any).categories)
    ? (value as any).categories.slice(0, MAX_PERSISTED_CATEGORIES).flatMap((raw: any) => {
        const id = boundedIdentifier(raw?.id);
        const label = boundedString(raw?.label, 1_024);
        const color = boundedString(raw?.color, 128);
        const x = finiteNumber(raw?.position?.x);
        const y = finiteNumber(raw?.position?.y);
        const width = finiteNumber(raw?.width);
        const height = finiteNumber(raw?.height);
        if (!id || seenCategories.has(id) || label === undefined || !color || x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return [];
        seenCategories.add(id);
        return [{ id, label, color, position: { x, y }, width, height }];
      })
    : [];
  return {
    version: PERSISTENCE_VERSION,
    savedAt: finiteNumber((value as any).savedAt) ?? Date.now(),
    nodes,
    categories,
  };
}

export function loadState(): PersistedState {
  ensureDirs();
  const stateFile = getStateFile();
  for (const candidate of readJsonCandidates(stateFile, MAX_STATE_FILE_BYTES)) {
    const sourceVersion = persistenceEnvelopeVersion(candidate.value);
    if (candidate.path === stateFile) {
      noteCurrentEnvelopeVersion(stateFile, candidate.value, sourceVersion !== null);
    }
    const state = validatePersistedState(candidate.value);
    if (sourceVersion === null || !state) {
      if (candidate.path === stateFile) validatedFileSignatures.delete(stateFile);
      continue;
    }
    if (candidate.path === stateFile) {
      if (sourceVersion < PERSISTENCE_VERSION) migrateCurrentEnvelope(stateFile, state, "application state");
      else recordValidatedFile(stateFile);
    }
    console.log(`[persistence] Loaded state from ${candidate.path}`);
    return state;
  }
  return { version: PERSISTENCE_VERSION, savedAt: Date.now(), nodes: [], categories: [] };
}

export function savePersistedState(input: PersistedState) {
  ensureDirs();
  assertVersionWritable(getStateFile());
  const state = validatePersistedState({ ...input, version: PERSISTENCE_VERSION, savedAt: Date.now() });
  if (!state) throw new Error("Refusing to persist invalid state");
  state.savedAt = Date.now();
  atomicWriteFile(getStateFile(), JSON.stringify(state, null, 2));
}

export function saveState(sessions: Map<string, Session>) {
  ensureDirs();
  const savedState = loadState();

  const state: PersistedState = {
    version: PERSISTENCE_VERSION,
    savedAt: Date.now(),
    nodes: [],
    categories: savedState.categories || [],
  };

  for (const [sessionId, session] of sessions) {
    const existingNode = savedState.nodes.find(n => n.sessionId === sessionId);

    state.nodes.push({
      nodeId: session.nodeId,
      sessionId,
      agentId: session.agentId,
      agentName: session.agentName,
      command: session.command,
      cwd: session.cwd,
      shellLaunch: session.shellLaunch,
      terminalCols: session.terminalCols,
      terminalRows: session.terminalRows,
      terminalFrameRedrawsInPlace: session.terminalFrameRedrawsInPlace,
      originalCwd: session.originalCwd,
      devboxId: session.devboxId,
      remotePath: session.remotePath,
      createdAt: session.createdAt,
      customName: session.customName,
      generatedTitle: session.generatedTitle,
      titlePromptHistory: session.titlePromptHistory,
      customColor: session.customColor,
      notes: session.notes,
      icon: session.icon,
      position: session.position || existingNode?.position || { x: 0, y: 0 },
      worktreePaths: session.worktreePaths,
      launchCheckpoint: session.launchCheckpoint,
      agentProfileId: session.agentProfileId,
      agentProfileVersion: session.agentProfileVersion,
      agentPermissionPolicy: session.agentPermissionPolicy,
      agentAllowedTools: session.agentAllowedTools,
      agentRuntimeManifestPath: session.agentRuntimeManifestPath,
      agentModel: session.agentModel,
      resumeSessionId: session.resumeSessionId,
      agentPermissionEvents: session.agentPermissionEvents?.slice(-200),
    });

    // Skip sessions that produced nothing since the last write. A failed write
    // leaves no signature, so the next pass retries instead of treating the
    // failure as persisted.
    if (persistedBufferRevisions.get(sessionId) !== bufferRevisionKey(session)) {
      saveBuffer(sessionId, session.outputBuffer, Boolean(session.outputBufferTruncated), session);
    }
    if (persistedBlockSignatures.get(sessionId) !== blockSignature(session.terminalBlocks)) {
      saveTerminalBlocks(sessionId, session.terminalBlocks);
    }
  }

  try {
    savePersistedState(state);
    cleanupOrphanedSessionFiles(new Set(state.nodes.map((node) => node.sessionId)));
  } catch (e) {
    reportPersistenceSaveError("Failed to save state:", e);
  }
}

export function savePositions(positions: Record<string, { x: number; y: number }>) {
  ensureDirs();
  const state = loadState();

  let updated = 0;
  for (const [nodeId, pos] of Object.entries(positions)) {
    const node = state.nodes.find(n => n.nodeId === nodeId);
    if (node) {
      node.position = pos;
      updated++;
    }
  }

  if (updated > 0) {
    try {
      savePersistedState(state);
    } catch (e) {
      reportPersistenceSaveError("Failed to save positions:", e);
    }
  }
}

function bufferJsonPath(sessionId: string): string {
  assertSessionId(sessionId);
  return join(getBuffersDir(), `${sessionId}.json`);
}

function legacyBufferPath(sessionId: string): string {
  assertSessionId(sessionId);
  return join(getBuffersDir(), `${sessionId}.txt`);
}

/**
 * Returns true when the scrollback actually reached disk.
 *
 * Pass `session` to record what was written, so the periodic save can skip it
 * next tick. Omitting it just means the next tick rewrites once.
 */
export function saveBuffer(
  sessionId: string,
  buffer: string[],
  alreadyTruncated = false,
  session?: Session,
): boolean {
  ensureDirs();
  const bufferFile = bufferJsonPath(sessionId);
  persistedBufferRevisions.delete(sessionId);
  try {
    assertVersionWritable(bufferFile);
    const replay = terminalReplayText(buffer, alreadyTruncated);
    atomicWriteFile(bufferFile, JSON.stringify({
      version: PERSISTENCE_VERSION,
      savedAt: Date.now(),
      truncated: replay.truncated,
      data: replay.data,
    }));
    rmSync(legacyBufferPath(sessionId), { force: true });
    if (session) persistedBufferRevisions.set(sessionId, bufferRevisionKey(session));
    return true;
  } catch (e) {
    reportPersistenceSaveError("Failed to save buffer:", e);
    return false;
  }
}

export function loadBuffer(sessionId: string): LoadedTerminalBuffer {
  ensureDirs();
  const bufferFile = bufferJsonPath(sessionId);
  for (const candidate of readJsonCandidates(bufferFile, MAX_BUFFER_FILE_BYTES)) {
    const sourceVersion = persistenceEnvelopeVersion(candidate.value);
    if (candidate.path === bufferFile) {
      noteCurrentEnvelopeVersion(bufferFile, candidate.value, sourceVersion !== null);
    }
    if (
      sourceVersion === null ||
      !candidate.value ||
      typeof candidate.value !== "object" ||
      typeof (candidate.value as any).data !== "string"
    ) {
      if (candidate.path === bufferFile) validatedFileSignatures.delete(bufferFile);
      continue;
    }
    const replay = boundedReplay((candidate.value as any).data, (candidate.value as any).truncated === true);
    if (candidate.path === bufferFile) {
      if (sourceVersion < PERSISTENCE_VERSION) {
        migrateCurrentEnvelope(bufferFile, {
          version: PERSISTENCE_VERSION,
          savedAt: Date.now(),
          truncated: replay.truncated,
          data: replay.data,
        }, `scrollback for ${sessionId}`);
      } else {
        recordValidatedFile(bufferFile);
      }
    }
    return { chunks: replay.data ? [replay.data] : [], truncated: replay.truncated };
  }
  try {
    const legacy = legacyBufferPath(sessionId);
    if (existsSync(legacy)) {
      const replay = boundedReplay(readFileSync(legacy, "utf8"));
      saveBuffer(sessionId, replay.data ? [replay.data] : [], replay.truncated);
      return { chunks: replay.data ? [replay.data] : [], truncated: replay.truncated };
    }
  } catch (e) {
    console.error("Failed to load buffer:", e);
  }
  return { chunks: [], truncated: false };
}

function normalizedBlock(raw: unknown, restoring: boolean): TerminalCommandBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const block = raw as any;
  const id = boundedIdentifier(block.id);
  const sequence = finiteNumber(block.sequence);
  const commandValue = typeof block.command === "string" ? block.command : "";
  const cwdValue = typeof block.cwd === "string" ? block.cwd : "";
  const outputValue = typeof block.output === "string" ? block.output : "";
  const commandRedaction = redactPlainTerminalText(commandValue);
  const command = commandRedaction.text.slice(0, MAX_COMMAND_CHARS);
  const cwd = redactPlainTerminalText(cwdValue).text.replace(/[\r\n]/g, "").slice(0, MAX_CWD_CHARS);
  const frameRedrawsInPlace = block.frameRedrawsInPlace === true;
  const outputRedaction = redactPlainTerminalText(
    outputValue,
    commandRedaction.secrets,
    { frameRedrawsInPlace },
  );
  const plainOutput = outputRedaction.text;
  const outputWasTruncated = plainOutput.length > MAX_BLOCK_OUTPUT_CHARS;
  const output = outputWasTruncated
    ? plainOutput.slice(plainOutput.length - MAX_BLOCK_OUTPUT_CHARS)
    : plainOutput;
  const startedAt = finiteNumber(block.startedAt);
  if (!id || !Number.isSafeInteger(sequence) || sequence! < 1 || !command || !cwd || startedAt === undefined || startedAt < 0) return null;
  const statuses = new Set(["running", "succeeded", "failed", "interrupted", "unknown"]);
  const sources = new Set(["shell-integration", "inferred", "recovered"]);
  let status = statuses.has(block.status) ? block.status : "unknown";
  let completedAt = finiteNumber(block.completedAt);
  if (restoring && status === "running") {
    status = "interrupted";
    completedAt = Date.now();
  }
  const exitCode = Number.isSafeInteger(block.exitCode) ? block.exitCode : undefined;
  const failureKind = classifyTerminalFailureKind(exitCode, status);
  const noteValue = typeof block.note === "string"
    ? redactPlainTerminalText(block.note).text.slice(0, MAX_NOTE_CHARS)
    : undefined;
  const shellDepth = Number.isSafeInteger(block.shellDepth)
    ? Math.max(0, Math.min(16, block.shellDepth))
    : undefined;
  return {
    id,
    sequence: sequence!,
    command,
    cwd,
    startedAt,
    completedAt: completedAt !== undefined && completedAt >= startedAt ? completedAt : undefined,
    exitCode,
    status,
    failureKind,
    source: sources.has(block.source) ? block.source : "recovered",
    output,
    outputTruncated: Boolean(block.outputTruncated || outputWasTruncated),
    bookmarked: block.bookmarked === true || undefined,
    note: noteValue || undefined,
    sensitive: Boolean(block.sensitive || outputRedaction.sensitive) || undefined,
    shellIntegration: boundedString(block.shellIntegration, 64),
    shellEpochId: boundedString(block.shellEpochId, 128),
    shellDepth,
    frameRedrawsInPlace: frameRedrawsInPlace || undefined,
  } as TerminalCommandBlock;
}

function normalizedBlocks(rawBlocks: unknown[], restoring: boolean): TerminalCommandBlock[] {
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  const blocks = rawBlocks.flatMap((raw) => {
    const block = normalizedBlock(raw, restoring);
    if (!block || seenIds.has(block.id) || seenSequences.has(block.sequence)) return [];
    seenIds.add(block.id);
    seenSequences.add(block.sequence);
    return [block];
  }).sort((a, b) => a.sequence - b.sequence);
  return blocks.slice(-MAX_BLOCKS_PER_SESSION);
}

/** Returns true when the blocks actually reached disk. */
export function saveTerminalBlocks(sessionId: string, blocks: TerminalCommandBlock[]): boolean {
  ensureDirs();
  assertSessionId(sessionId);
  const blocksFile = join(getTerminalBlocksDir(), `${sessionId}.json`);
  persistedBlockSignatures.delete(sessionId);
  try {
    assertVersionWritable(blocksFile);
    const safeBlocks = normalizedBlocks(blocks, false);
    atomicWriteFile(blocksFile, JSON.stringify({
      version: PERSISTENCE_VERSION,
      savedAt: Date.now(),
      blocks: safeBlocks,
    }));
    persistedBlockSignatures.set(sessionId, blockSignature(blocks));
    return true;
  } catch (e) {
    reportPersistenceSaveError("Failed to save terminal blocks:", e);
    return false;
  }
}

export function loadTerminalBlocks(sessionId: string): TerminalCommandBlock[] {
  ensureDirs();
  assertSessionId(sessionId);
  const blocksFile = join(getTerminalBlocksDir(), `${sessionId}.json`);
  for (const candidate of readJsonCandidates(blocksFile, MAX_BLOCKS_FILE_BYTES)) {
    const sourceVersion: SupportedPersistenceVersion | null = Array.isArray(candidate.value)
      ? 0
      : persistenceEnvelopeVersion(candidate.value);
    if (candidate.path === blocksFile) {
      noteCurrentEnvelopeVersion(blocksFile, candidate.value, sourceVersion !== null);
    }
    const rawBlocks = sourceVersion !== null && Array.isArray(candidate.value)
      ? candidate.value
      : sourceVersion !== null && candidate.value && typeof candidate.value === "object" &&
          Array.isArray((candidate.value as any).blocks)
        ? (candidate.value as any).blocks
        : null;
    if (sourceVersion === null || !rawBlocks) {
      if (candidate.path === blocksFile) validatedFileSignatures.delete(blocksFile);
      continue;
    }
    const blocks = normalizedBlocks(rawBlocks, true);
    if (candidate.path === blocksFile) {
      if (sourceVersion < PERSISTENCE_VERSION) {
        migrateCurrentEnvelope(blocksFile, {
          version: PERSISTENCE_VERSION,
          savedAt: Date.now(),
          blocks,
        }, `terminal blocks for ${sessionId}`);
      } else {
        recordValidatedFile(blocksFile);
      }
    }
    return blocks;
  }
  return [];
}

export function deletePersistedSession(sessionId: string) {
  ensureDirs();
  assertSessionId(sessionId);
  forgetPersistedSignatures(sessionId);
  for (const path of [
    bufferJsonPath(sessionId),
    legacyBufferPath(sessionId),
    join(getTerminalBlocksDir(), `${sessionId}.json`),
  ]) {
    deleteAtomicFamily(path);
  }
}

function deleteAtomicFamily(path: string) {
  incompatibleVersionFiles.delete(path);
  warnedIncompatibleVersionFiles.delete(path);
  rmSync(path, { force: true });
  rmSync(`${path}.bak`, { force: true });
  try {
    const prefix = basename(path);
    for (const name of readdirSync(dirname(path))) {
      if (name.startsWith(`${prefix}.old-`) || name.startsWith(`${prefix}.tmp-`)) {
        rmSync(join(dirname(path), name), { force: true });
      }
    }
  } catch {}
}

function cleanupOrphanedSessionFiles(activeSessionIds: Set<string>) {
  // Sessions can leave the map without routing through deletePersistedSession
  // (restore replacing the set, a failed spawn rolling back). Prune here so the
  // dirty-tracking maps stay the same size as the session map.
  for (const map of [persistedBufferRevisions, persistedBlockSignatures]) {
    for (const sessionId of map.keys()) {
      if (!activeSessionIds.has(sessionId)) map.delete(sessionId);
    }
  }

  for (const [directory, suffixes] of [
    [getBuffersDir(), [".json", ".json.bak", ".txt", ".txt.bak"]],
    [getTerminalBlocksDir(), [".json", ".json.bak"]],
  ] as const) {
    for (const name of readdirSync(directory)) {
      const suffix = suffixes.find((candidate) => name.endsWith(candidate));
      if (!suffix) {
        const recovery = name.match(/^(.+)\.(?:json|txt)\.(?:old|tmp)-/);
        if (recovery && !activeSessionIds.has(recovery[1])) rmSync(join(directory, name), { force: true });
        continue;
      }
      const sessionId = name.slice(0, -suffix.length);
      if (!activeSessionIds.has(sessionId)) rmSync(join(directory, name), { force: true });
    }
  }
}
