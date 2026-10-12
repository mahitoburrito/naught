#!/usr/bin/env node
// Behaviour tests for the compute-node feature: secrets, policy, keys, mail,
// providers, the orchestrator and its routes. Imports the compiled server
// (`npm run build:electron` first); never touches the network.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron", "server");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function withLaunchCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), "naught-compute-"));
  const previous = process.env.LAUNCH_CWD;
  process.env.LAUNCH_CWD = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.LAUNCH_CWD;
    else process.env.LAUNCH_CWD = previous;
  }
}

// ─── secrets ────────────────────────────────────────────────────────────────

section("secrets");
{
  const secrets = await import(join(dist, "services", "secrets.js"));
  await withLaunchCwd(async (dir) => {
    check("missing env file reads as empty", secrets.readEnvFile().TNR_API_TOKEN, undefined);
    secrets.updateEnvValue("TNR_API_TOKEN", "abc");
    check("a written key reads back", secrets.readEnvFile().TNR_API_TOKEN, "abc");
    secrets.updateEnvValue("TNR_API_TOKEN", "def");
    const text = readFileSync(join(dir, ".openui-desktop", ".env"), "utf-8");
    check("rewriting replaces the line", text.split("\n").filter((l) => l.startsWith("TNR_API_TOKEN=")).length, 1);
    check("the file is owner-only", (statSync(join(dir, ".openui-desktop", ".env")).mode & 0o077), 0);
    secrets.updateEnvValue("RESEND_API_KEY", 're_x"y');
    check("quotes in values survive", secrets.readEnvFile().RESEND_API_KEY, 're_x"y');
    secrets.updateEnvValue("TNR_API_TOKEN", "");
    check("an empty value removes the key", secrets.readEnvFile().TNR_API_TOKEN, undefined);
    check("other keys stay", secrets.readEnvFile().RESEND_API_KEY, 're_x"y');
    let threw = false;
    try { secrets.updateEnvValue("bad key", "x"); } catch { threw = true; }
    check("an unsafe key name is refused", threw, true);
  });

  check(
    "resolveSecret prefers the value set in Naught",
    secrets.resolveSecret("K", { file: { K: "file" }, env: { K: "env" }, detector: () => "det" }),
    { value: "file", source: "naught" },
  );
  check(
    "then the process environment",
    secrets.resolveSecret("K", { file: {}, env: { K: "env" }, detector: () => "det" }),
    { value: "env", source: "env" },
  );
  check(
    "then a detector",
    secrets.resolveSecret("K", { file: {}, env: {}, detector: () => "det" }),
    { value: "det", source: "detected" },
  );
  check("nothing found is undefined", secrets.resolveSecret("K", { file: {}, env: {} }), undefined);
  check("blank values do not count", secrets.resolveSecret("K", { file: { K: "  " }, env: { K: "" } }), undefined);

  check(
    "parseModalToml picks the active profile",
    secrets.parseModalToml('[a]\ntoken_id = "ak-1"\ntoken_secret = "as-1"\n\n[b]\ntoken_id = "ak-2"\ntoken_secret = "as-2"\nactive = true\n'),
    { tokenId: "ak-2", tokenSecret: "as-2", profile: "b" },
  );
  check(
    "parseModalToml falls back to a lone profile",
    secrets.parseModalToml('[only]\ntoken_id = "ak"\ntoken_secret = "as"\n'),
    { tokenId: "ak", tokenSecret: "as", profile: "only" },
  );
  check("parseModalToml with two inactive profiles is undefined", secrets.parseModalToml('[a]\ntoken_id="1"\ntoken_secret="2"\n[b]\ntoken_id="3"\ntoken_secret="4"\n'), undefined);
  check("parseModalToml without a secret is undefined", secrets.parseModalToml('[a]\ntoken_id="1"\nactive=true\n'), undefined);
}


// ─── persisted move / devbox fields ─────────────────────────────────────────

section("persistence");
{
  const persistence = await import(join(dist, "services", "persistence.js"));
  const move = {
    direction: "out",
    state: "sync-files",
    nodeId: "node-1",
    startedAt: 1000,
    updatedAt: 1200,
    harness: { kind: "claude", sessionId: "c1", transcriptPath: "/h/.claude/projects/-w/c1.jsonl" },
    roots: ["/w"],
    manifest: { hash: "abc", files: 3, bytes: 10, roots: ["/w"] },
    includeIgnored: false,
    history: [{ direction: "out", nodeId: "node-1", at: 999, manifestHash: "abc" }],
  };
  check("a valid move state round-trips", persistence.validateMoveState(move), move);
  check("an unknown move step is dropped", persistence.validateMoveState({ ...move, state: "flying" }), undefined);
  check("a move without a node id is dropped", persistence.validateMoveState({ ...move, nodeId: "" }), undefined);
  check(
    "a malformed harness degrades to shell",
    persistence.validateMoveState({ ...move, harness: { kind: "codex" } }).harness,
    { kind: "shell" },
  );

  await withLaunchCwd(async () => {
    const sessions = new Map();
    sessions.set("s-1", {
      pty: null, agentId: "claude", agentName: "Claude Code", command: "claude", cwd: "/w",
      devboxId: "box-1", remotePath: "/w", move,
      createdAt: new Date(0).toISOString(), clients: new Set(), outputBuffer: [], outputBufferChars: 0,
      terminalCols: 80, terminalRows: 24, terminalFrameRedrawsInPlace: true, status: "idle",
      lastOutputTime: 0, lastInputTime: 0, recentOutputSize: 0, nodeId: "node-s-1", terminalBlocks: [],
      position: { x: 1, y: 2 },
    });
    persistence.saveState(sessions);
    const loaded = persistence.loadState();
    const node = loaded.nodes.find((n) => n.sessionId === "s-1");
    check("devboxId survives a save/load", node?.devboxId, "box-1");
    check("remotePath survives a save/load", node?.remotePath, "/w");
    check("move state survives a save/load", node?.move?.state, "sync-files");
  });
}

// ─── policy ─────────────────────────────────────────────────────────────────

section("policy");
{
  const { DEFAULT_COMPUTE_CONFIG, evaluatePolicy, normaliseComputeConfig } = await import(join(dist, "services", "compute", "policy.js"));
  check("policy defaults", DEFAULT_COMPUTE_CONFIG.policy, { maxConcurrentNodes: 2, allowedGpus: "any", maxLifetimeHours: 8, maxHourlyUsd: 5 });
  const policy = DEFAULT_COMPUTE_CONFIG.policy;
  const spec = { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, name: "n", maxLifetimeHours: 8, hourlyUsd: 3.95 };
  check("inside every cap is allowed", evaluatePolicy(policy, spec, { liveNodes: 0 }), { allowed: true, reasons: [] });
  check("too many live nodes", evaluatePolicy(policy, spec, { liveNodes: 2 }), { allowed: false, reasons: ["Already 2 of 2 nodes live"] });
  check(
    "gpu outside the allowed list",
    evaluatePolicy({ ...policy, allowedGpus: ["A10G", "T4"] }, spec, { liveNodes: 0 }).reasons,
    ["GPU H100 is not in the allowed list (A10G, T4)"],
  );
  check("gpu list match is case-insensitive", evaluatePolicy({ ...policy, allowedGpus: ["h100"] }, spec, { liveNodes: 0 }).allowed, true);
  check("cpu-only ignores the gpu list", evaluatePolicy({ ...policy, allowedGpus: [] }, { ...spec, gpu: undefined }, { liveNodes: 0 }).allowed, true);
  check("hourly cap", evaluatePolicy(policy, { ...spec, hourlyUsd: 7.9 }, { liveNodes: 0 }).reasons, ["Estimated $7.90/hr exceeds the $5.00/hr cap"]);
  check("lifetime cap", evaluatePolicy(policy, { ...spec, maxLifetimeHours: 10 }, { liveNodes: 0 }).reasons, ["Lifetime 10h exceeds the 8h cap"]);
  check(
    "every failing cap is listed",
    evaluatePolicy({ ...policy, allowedGpus: ["T4"] }, { ...spec, hourlyUsd: 9, maxLifetimeHours: 24 }, { liveNodes: 5 }).reasons.length,
    4,
  );
  const normalised = normaliseComputeConfig({ policy: { maxConcurrentNodes: "3", allowedGpus: ["H100", " H100 ", ""], maxHourlyUsd: -1 }, notifications: { to: " me@x.io ", reminderHours: 0 } });
  check("normalise clamps and dedupes", normalised.policy, { maxConcurrentNodes: 3, allowedGpus: ["H100"], maxLifetimeHours: 8, maxHourlyUsd: 0 });
  check("normalise trims the recipient and clamps the cadence", [normalised.notifications.to, normalised.notifications.reminderHours], ["me@x.io", 0.25]);
  check("normalise of garbage is the defaults", normaliseComputeConfig(null), DEFAULT_COMPUTE_CONFIG);
}


// ─── ssh keypair ────────────────────────────────────────────────────────────

section("ssh keypair");
{
  const keys = await import(join(dist, "services", "compute", "sshKeys.js"));
  await withLaunchCwd(async (dir) => {
    keys.resetNaughtKeypairCache();
    const first = await keys.ensureNaughtKeypair();
    const privateKeyPath = join(dir, ".openui-desktop", "keys", "naught_ed25519");
    check("private key lands under the launch dir", first.privateKeyPath, privateKeyPath);
    check("private key is owner-only", statSync(privateKeyPath).mode & 0o077, 0);
    check("public key is a single ed25519 line", first.publicKey.startsWith("ssh-ed25519 ") && !first.publicKey.includes("\n"), true);
    const mtime = statSync(privateKeyPath).mtimeMs;
    keys.resetNaughtKeypairCache();
    const second = await keys.ensureNaughtKeypair();
    check("a second call reuses the key", [second.publicKey === first.publicKey, statSync(privateKeyPath).mtimeMs === mtime], [true, true]);
  });
}

// ─── notifications ──────────────────────────────────────────────────────────

section("notifications");
{
  const notify = await import(join(dist, "services", "compute", "notify.js"));
  const now = 10 * 3_600_000;
  const node = {
    id: "node-abc", name: "gpu-1", source: "provisioned", inSshConfig: false, host: "h", user: "root", port: 22,
    provision: {
      provider: "modal", instanceId: "sb-1", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, status: "ready",
      requestedBy: { kind: "user" }, requestedAt: 0, startedAt: now - 2.5 * 3_600_000, hourlyUsd: 3.95,
      maxLifetimeHours: 8, lastActivityAt: now - 90 * 60_000, emails: { reminderCount: 0, idleAlertCount: 0 },
    },
  };
  const config = { to: "me@prbe.ai", from: "Naught <naught@prbe.ai>", reminderHours: 4, idleAlertMinutes: 60 };
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: "email-1" }), text: async () => "" };
  };
  check("idempotency keys", [
    notify.idempotencyKey("n", "started"), notify.idempotencyKey("n", "reminder", 3),
    notify.idempotencyKey("n", "idle", 1), notify.idempotencyKey("n", "terminated"),
  ], ["naught-n-started", "naught-n-reminder-3", "naught-n-idle-1", "naught-n-terminated"]);
  check("uptime formatting", [notify.formatUptime(5 * 60_000), notify.formatUptime(2 * 3_600_000), notify.formatUptime(2.5 * 3_600_000)], ["5 min", "2 h", "2 h 30 min"]);
  check("estimated cost", Number(notify.estimatedCost(node.provision, now).toFixed(3)), 9.875);

  const started = await notify.sendNodeEmail({ kind: "started", node, attachedSessions: ["sess A"], now, config, apiKey: "re_x" }, fetchStub);
  check("started mail is sent", started, { sent: true, id: "email-1" });
  const req = calls[0];
  const body = JSON.parse(req.init.body);
  check("posted to Resend with the bearer and the idempotency key", [req.url, req.init.headers.Authorization, req.init.headers["Idempotency-Key"]], [notify.RESEND_EMAILS_URL, "Bearer re_x", "naught-node-abc-started"]);
  check("from/to come from the settings", [body.from, body.to], ["Naught <naught@prbe.ai>", ["me@prbe.ai"]]);
  check("subject names the node, the spec and the estimate", body.subject, "[Naught] gpu-1 is live: H100 · 4 vCPU · 16 GB at $3.95/hr est.");
  check("body says how to stop it", body.text.includes("naught node terminate node-abc") && body.text.includes("Settings → Devboxes") && body.text.includes("sess A"), true);

  await notify.sendNodeEmail({ kind: "reminder", n: 2, node, attachedSessions: [], now, config, apiKey: "re_x" }, fetchStub);
  check("reminder key carries its ordinal", calls[1].init.headers["Idempotency-Key"], "naught-node-abc-reminder-2");
  check("reminder subject carries uptime and cost", JSON.parse(calls[1].init.body).subject, "[Naught] gpu-1 still live after 2 h 30 min ($9.88 est.)");
  await notify.sendNodeEmail({ kind: "idle", n: 1, node, attachedSessions: [], now, config, apiKey: "re_x" }, fetchStub);
  check("idle subject carries the idle time", JSON.parse(calls[2].init.body).subject, "[Naught] gpu-1 has been idle for 1 h 30 min ($9.88 est.)");
  await notify.sendNodeEmail({ kind: "terminated", node: { ...node, provision: { ...node.provision, terminatedAt: now, terminateReason: "max-lifetime" } }, attachedSessions: [], now, config, apiKey: "re_x" }, fetchStub);
  check("terminated key", calls[3].init.headers["Idempotency-Key"], "naught-node-abc-terminated");

  check("no recipient skips without calling Resend", await notify.sendNodeEmail({ kind: "started", node, attachedSessions: [], now, config: { ...config, to: undefined }, apiKey: "re_x" }, fetchStub), { sent: false, skipped: "no-recipient" });
  check("no api key skips", await notify.sendNodeEmail({ kind: "started", node, attachedSessions: [], now, config, apiKey: undefined }, fetchStub), { sent: false, skipped: "no-api-key" });
  check("still four calls", calls.length, 4);
  let message = "";
  try {
    await notify.sendNodeEmail({ kind: "started", node, attachedSessions: [], now, config, apiKey: "re_x" }, async () => ({ ok: false, status: 422, statusText: "Unprocessable", text: async () => "domain not verified", json: async () => ({}) }));
  } catch (error) { message = error.message; }
  check("a rejected send surfaces Resend's answer", message, "Resend 422: domain not verified");
}


// ─── Thunder provider ───────────────────────────────────────────────────────

section("thunder provider");
{
  const thunder = await import(join(dist, "services", "compute", "thunder.js"));
  const okJson = (body, status = 200) => ({ ok: status < 400, status, statusText: "x", text: async () => JSON.stringify(body) });
  const calls = [];
  let listResponses = [];
  const fetchStub = async (url, init = {}) => {
    const path = url.replace(thunder.THUNDER_BASE_URL, "");
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    if (path === "/instances/list") return okJson(listResponses.length > 1 ? listResponses.shift() : listResponses[0] ?? {});
    if (path === "/instances/create") return okJson({ uuid: "uuid-1", identifier: 41, key: "secret" }, 201);
    if (path === "/v2/specs") return okJson({ specs: { h100: { displayName: "H100", gpuCount: 1, vcpuOptions: [4, 8], ramPerVCPUGiB: 4, vramGB: 80, storageGB: { min: 100, max: 1000 } }, t4: { displayName: "T4", gpuCount: 1, vcpuOptions: [4], ramPerVCPUGiB: 4, vramGB: 16, storageGB: { min: 50, max: 500 } } } });
    if (path === "/v2/pricing") return okJson({ pricing: { h100: 1.47 } });
    if (path === "/thunder-templates") return okJson({ "ubuntu-22.04": { displayName: "Ubuntu" }, comfy: { displayName: "ComfyUI" } });
    if (path.startsWith("/instances/") && init.method === "DELETE") return okJson({ ok: true });
    return okJson({ error: "nope" }, 404);
  };
  const unconfigured = new thunder.ThunderProvider({ fetch: fetchStub, env: {}, file: {} });
  check("unconfigured without a token", (await unconfigured.configured()).ok, false);
  const provider = new thunder.ThunderProvider({ fetch: fetchStub, env: {}, file: { TNR_API_TOKEN: "tok" }, pollMs: 1, tcpProbe: async () => true });
  check("configured from Naught's file", await provider.configured(), { ok: true, source: "naught" });
  check("env source is reported", await new thunder.ThunderProvider({ fetch: fetchStub, env: { TNR_API_TOKEN: "e" }, file: {} }).configured(), { ok: true, source: "env" });

  listResponses = [{ "41": { uuid: "uuid-1", status: "running", ip: "1.2.3.4", port: 2222 } }];
  check("test lists instances with the bearer token", await provider.test(), { ok: true, message: "Connected · 1 instance" });
  check("bearer header", calls.at(-1).auth, "Bearer tok");

  const offers = await provider.offers();
  check("offers join specs, pricing and templates", offers.map((o) => [o.gpu, o.cpu, o.memoryGb, o.diskGb, o.hourlyUsd, o.image, o.label]), [
    ["h100", 4, 16, 100, 1.47, "ubuntu-22.04", "H100 · 4 vCPU · 16 GB"],
    ["h100", 8, 32, 100, 1.47, "ubuntu-22.04", "H100 · 8 vCPU · 32 GB"],
    ["t4", 4, 16, 50, 0, "ubuntu-22.04", "T4 · 4 vCPU · 16 GB · price unknown"],
  ]);
  check("offers are cached", (await provider.offers()) === offers, true);
  check("estimate from cached offers", provider.estimateHourlyUsd({ provider: "thunder", gpu: "H100", gpuCount: 2, cpu: 8, memoryGb: 32, name: "n", maxLifetimeHours: 8 }), 2.94);

  const created = await provider.provision({ provider: "thunder", gpu: "h100", gpuCount: 1, cpu: 4, memoryGb: 16, diskGb: 120, image: "ubuntu-22.04", name: "n", maxLifetimeHours: 8 }, "ssh-ed25519 AAAA naught");
  const createCall = calls.find((c) => c.path === "/instances/create");
  check("create posts the documented body", createCall.body, { num_gpus: 1, gpu_type: "h100", cpu_cores: 4, disk_size_gb: 120, template: "ubuntu-22.04", public_key: "ssh-ed25519 AAAA naught" });
  check("create returns the uuid", created, { instanceId: "uuid-1" });

  listResponses = [{ "41": { uuid: "uuid-1", status: "pending" } }, { "41": { uuid: "uuid-1", status: "running", ip: "1.2.3.4", port: 2222 } }];
  check("waitReady polls until running with an ip", await provider.waitReady("uuid-1", new AbortController().signal), { host: "1.2.3.4", port: 2222, user: "ubuntu" });
  listResponses = [{ "41": { uuid: "uuid-1", status: "running", ip: "1.2.3.4" } }];
  check("status maps running to ready", await provider.status("uuid-1"), "ready");
  listResponses = [{}];
  check("a missing instance is terminated", await provider.status("uuid-1"), "terminated");
  listResponses = [{ "41": { uuid: "uuid-1", status: "error" } }];
  check("error status", await provider.status("uuid-1"), "error");
  await provider.terminate("uuid-1");
  check("terminate deletes by identifier", calls.at(-1), { path: "/instances/41", method: "DELETE", body: undefined, auth: "Bearer tok" });

  listResponses = [{ "41": { uuid: "uuid-1", status: "failed" } }];
  let failure = "";
  try { await provider.waitReady("uuid-1", new AbortController().signal); } catch (e) { failure = e.message; }
  check("waitReady surfaces a failed instance", failure, "Thunder instance uuid-1 reported failed");
  const aborted = new AbortController();
  listResponses = [{ "41": { uuid: "uuid-1", status: "pending" } }];
  setTimeout(() => aborted.abort(), 5);
  failure = "";
  try { await provider.waitReady("uuid-1", aborted.signal); } catch (e) { failure = e.message; }
  check("waitReady honours abort", failure, "aborted");
  check("parseInstanceList handles an array form", thunder.parseInstanceList({ instances: [{ id: "7", status: "Running", ip: "9.9.9.9" }] }), [{ id: "7", uuid: undefined, status: "running", ip: "9.9.9.9", port: undefined }]);
}


// ─── Modal provider ─────────────────────────────────────────────────────────

section("modal provider");
{
  const modal = await import(join(dist, "services", "compute", "modal.js"));
  const gpuImage = modal.buildModalImageCommands({ gpu: "H100" }, "ssh-ed25519 AAAA naught");
  check("gpu specs build on the CUDA image", gpuImage.base, "nvidia/cuda:12.4.0-devel-ubuntu22.04");
  check("cpu specs build on plain ubuntu", modal.buildModalImageCommands({}, "k").base, "ubuntu:22.04");
  const joined = gpuImage.commands.join("\n");
  check("image installs sshd, git, rsync, python and node", joined.includes("openssh-server git rsync curl ca-certificates python3 nodejs npm"), true);
  check("image installs both agent CLIs", joined.includes("https://claude.ai/install.sh | bash") && joined.includes("npm install -g @openai/codex"), true);
  check("image bakes the public key", joined.includes("echo 'ssh-ed25519 AAAA naught' > /root/.ssh/authorized_keys"), true);
  check("image prepares sshd", joined.includes("mkdir -p /run/sshd") && joined.includes("PermitRootLogin prohibit-password"), true);
  const spec = { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, name: "gpu-1", maxLifetimeHours: 8 };
  check("sandbox params", modal.toSandboxParams(spec), { command: ["/usr/sbin/sshd", "-D", "-e"], unencryptedPorts: [22], gpu: "H100", cpu: 4, memoryMiB: 16384, timeoutMs: 28_800_000, name: "gpu-1" });
  check("multi-gpu uses the count suffix", modal.toSandboxParams({ ...spec, gpuCount: 2 }).gpu, "H100:2");
  check("cpu-only omits gpu", "gpu" in modal.toSandboxParams({ ...spec, gpu: undefined, gpuCount: 0 }), false);
  check("hourly estimate adds sandbox cpu and memory", modal.estimateModalHourlyUsd(spec), 4.9);
  check("cpu-only estimate", modal.estimateModalHourlyUsd({ gpu: undefined, gpuCount: 0, cpu: 2, memoryGb: 8 }), 0.48);
  const offers = modal.modalOffers();
  check("offers list presets and every gpu class", [offers.length, offers[0].label, offers.find((o) => o.gpu === "H100")?.hourlyUsd], [12, "CPU only · 2 vCPU · 8 GB", 4.9]);

  const events = [];
  let tunnelCalls = 0;
  const fakeSandbox = {
    sandboxId: "sb-123",
    async tunnels() { tunnelCalls++; if (tunnelCalls === 1) throw new Error("not yet"); return { 22: { host: "r1.modal.host", port: 34567, tcpSocket: ["r1.modal.host", 34567] } }; },
    async poll() { return events.includes("terminated") ? 0 : null; },
    async terminate() { events.push("terminated"); },
  };
  const fakeClient = {
    apps: { async fromName(name, params) { events.push(`app:${name}:${params?.createIfMissing}`); return { appId: "ap-1" }; } },
    images: { fromRegistry(tag) { events.push(`image:${tag}`); return { dockerfileCommands(commands) { events.push(`commands:${commands.length}`); return { tag }; } }; } },
    sandboxes: {
      async create(app, image, params) { events.push(["create", app.appId, image.tag, params]); return fakeSandbox; },
      async fromId(id) { events.push(`fromId:${id}`); return fakeSandbox; },
      async *list() { yield fakeSandbox; },
    },
  };
  const provider = new modal.ModalProvider({ env: {}, file: { MODAL_TOKEN_ID: "ak", MODAL_TOKEN_SECRET: "as" }, clientFactory: async (t) => { events.push(`client:${t.tokenId}`); return fakeClient; }, pollMs: 1, tcpProbe: async () => true });
  check("configured from Naught's file", await provider.configured(), { ok: true, source: "naught" });
  check("unconfigured without tokens", (await new modal.ModalProvider({ env: { MODAL_CONFIG_PATH: "/nonexistent/modal.toml" }, file: {} }).configured()).ok, false);
  await withLaunchCwd(async (dir) => {
    const toml = join(dir, "modal.toml");
    writeFileSync(toml, '[p]\ntoken_id = "det-id"\ntoken_secret = "det-secret"\nactive = true\n');
    check("detected from ~/.modal.toml", await new modal.ModalProvider({ env: { MODAL_CONFIG_PATH: toml }, file: {} }).configured(), { ok: true, source: "detected" });
  });
  check("test proves the token through the app lookup", await provider.test(), { ok: true, message: "Connected · 1 sandbox live" });
  const created = await provider.provision(spec, "ssh-ed25519 AAAA naught");
  check("provision returns the sandbox id", created, { instanceId: "sb-123" });
  const createEvent = events.find((e) => Array.isArray(e) && e[0] === "create");
  check("provision creates in the naught app from the built image with the params", [createEvent[1], createEvent[2], createEvent[3].unencryptedPorts, createEvent[3].gpu], ["ap-1", "nvidia/cuda:12.4.0-devel-ubuntu22.04", [22], "H100"]);
  check("waitReady retries tunnels and returns root@host:port", await provider.waitReady("sb-123", new AbortController().signal), { host: "r1.modal.host", port: 34567, user: "root" });
  check("status is ready while poll is null", await provider.status("sb-123"), "ready");
  await provider.terminate("sb-123");
  check("terminate calls the sandbox", events.includes("terminated"), true);
  check("status is terminated after exit", await provider.status("sb-123"), "terminated");
  check("the client is built once per token", events.filter((e) => e === "client:ak").length, 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
