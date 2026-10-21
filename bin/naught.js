#!/usr/bin/env node

// naught — the agent-facing CLI for the Naught session you are running in.
//
// Talks HTTP to the Naught server at http://${OPENUI_HOST}:${OPENUI_PORT}
// (on a node the reverse tunnel makes that address reach the IDE) and sends
// OPENUI_SESSION_ID as the requester. JSON on stdout, human text on stderr.
// Exit codes: 0 ok, 1 error or denied, 2 usage error or parked for approval.
//
// Zero dependencies, CommonJS, Node >= 18 (global fetch). `run` takes injected
// fetch/env/sleep/now/out/err so tests never touch the network or the clock.

"use strict";

const PROVIDERS = ["modal", "thunder"];
const POLL_INTERVAL_MS = 3000;
const DEFAULTS = Object.freeze({ cpu: 4, memoryGb: 16, wait: 600, timeout: 600 });

class UsageError extends Error {
  constructor(message, topic) {
    super(message);
    this.topic = topic;
  }
}

// ---------------------------------------------------------------- usage

function usage(topic) {
  const lines = [];
  if (!topic || topic === "node") {
    lines.push(
      "naught node offers [--provider modal|thunder]",
      "naught node create --provider modal|thunder [--gpu <id>] [--count N] [--cpu N] [--memory GB]",
      "                   [--disk GB] [--image <id>] [--name <s>] [--wait SECONDS] [--no-wait]",
      "naught node list",
      "naught node status <id>",
      "naught node wait <id> [--timeout SECONDS]",
      "naught node terminate <id>",
    );
  }
  if (!topic || topic === "session") {
    lines.push(
      "naught session move --to <node-id> [--session <id>]",
      "naught session move --to new:<provider>:<gpu>[:count] [--session <id>]",
      "naught session move --home [--session <id>]",
    );
  }
  const notes = [
    "",
    `Defaults: --count 1 with --gpu (0 without), --cpu ${DEFAULTS.cpu}, --memory ${DEFAULTS.memoryGb},`
      + ` --wait ${DEFAULTS.wait}, --timeout ${DEFAULTS.timeout}; --no-wait is --wait 0.`,
    "Output: JSON on stdout, human text on stderr.",
    "Exit codes: 0 ok, 1 error or denied, 2 usage error or parked for approval.",
    "Environment: OPENUI_PORT (required, set inside a Naught session), OPENUI_HOST (default 127.0.0.1),",
    "             OPENUI_SESSION_ID (the requester, and the session `session move` acts on).",
  ];
  return `Usage:\n${lines.map((line) => `  ${line}`).join("\n")}\n${notes.join("\n")}\n`;
}

// ---------------------------------------------------------------- parsing

function wantsHelp(argv) {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

// Splits argv into positionals and `--flag value` / `--flag=value` pairs.
// `booleans` lists flags that take no value.
function splitFlags(argv, known, booleans, topic) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (!known.includes(name)) throw new UsageError(`Unknown flag: ${arg}`, topic);
    if (name in flags) throw new UsageError(`Flag given twice: --${name}`, topic);
    if (booleans.includes(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`, topic);
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`, topic);
      value = argv[i + 1];
      i += 1;
    }
    if (value === "") throw new UsageError(`--${name} needs a value`, topic);
    flags[name] = value;
  }
  return { positionals, flags };
}

function integerFlag(flags, name, { min, fallback }, topic) {
  if (!(name in flags)) return fallback;
  const raw = flags[name];
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number, got "${raw}"`, topic);
  const value = Number(raw);
  if (value < min) throw new UsageError(`--${name} must be at least ${min}`, topic);
  return value;
}

function providerFlag(value, topic) {
  if (!PROVIDERS.includes(value)) {
    throw new UsageError(`Unknown provider "${value}" (expected ${PROVIDERS.join(" or ")})`, topic);
  }
  return value;
}

function onePositional(positionals, label, topic) {
  if (positionals.length === 0) throw new UsageError(`Missing ${label}`, topic);
  if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`, topic);
  return positionals[0];
}

function noPositionals(positionals, topic) {
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`, topic);
}

function parseNodeCreate(argv) {
  const topic = "node";
  const { positionals, flags } = splitFlags(
    argv,
    ["provider", "gpu", "count", "cpu", "memory", "disk", "image", "name", "wait", "no-wait"],
    ["no-wait"],
    topic,
  );
  noPositionals(positionals, topic);
  if (!flags.provider) throw new UsageError("node create needs --provider", topic);
  const result = { cmd: "node.create", provider: providerFlag(flags.provider, topic) };
  if (flags.gpu) result.gpu = flags.gpu;
  result.gpuCount = integerFlag(flags, "count", { min: 0, fallback: flags.gpu ? 1 : 0 }, topic);
  if (result.gpuCount > 0 && !flags.gpu) throw new UsageError("--count needs --gpu", topic);
  if (result.gpuCount === 0 && flags.gpu) throw new UsageError("--gpu needs a --count of at least 1", topic);
  result.cpu = integerFlag(flags, "cpu", { min: 1, fallback: DEFAULTS.cpu }, topic);
  result.memoryGb = integerFlag(flags, "memory", { min: 1, fallback: DEFAULTS.memoryGb }, topic);
  if ("disk" in flags) result.diskGb = integerFlag(flags, "disk", { min: 1 }, topic);
  if (flags.image) result.image = flags.image;
  if (flags.name) result.name = flags.name;
  if (flags["no-wait"] && "wait" in flags) throw new UsageError("--no-wait and --wait cannot be combined", topic);
  result.wait = flags["no-wait"] ? 0 : integerFlag(flags, "wait", { min: 0, fallback: DEFAULTS.wait }, topic);
  return result;
}

function parseNode(argv) {
  const topic = "node";
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "offers": {
      const { positionals, flags } = splitFlags(rest, ["provider"], [], topic);
      noPositionals(positionals, topic);
      const result = { cmd: "node.offers" };
      if (flags.provider) result.provider = providerFlag(flags.provider, topic);
      return result;
    }
    case "create":
      return parseNodeCreate(rest);
    case "list": {
      const { positionals } = splitFlags(rest, [], [], topic);
      noPositionals(positionals, topic);
      return { cmd: "node.list" };
    }
    case "status":
    case "terminate": {
      const { positionals } = splitFlags(rest, [], [], topic);
      return { cmd: `node.${sub}`, id: onePositional(positionals, "node id", topic) };
    }
    case "wait": {
      const { positionals, flags } = splitFlags(rest, ["timeout"], [], topic);
      return {
        cmd: "node.wait",
        id: onePositional(positionals, "node id", topic),
        timeout: integerFlag(flags, "timeout", { min: 0, fallback: DEFAULTS.timeout }, topic),
      };
    }
    case undefined:
      throw new UsageError("node needs a subcommand", topic);
    default:
      throw new UsageError(`Unknown command: node ${sub}`, topic);
  }
}

// `new:<provider>:<gpu>[:count]` → the newNode spec the move route accepts.
function parseNewNodeTarget(spec, topic) {
  const parts = spec.split(":");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => part === "")) {
    throw new UsageError(`--to new:<provider>:<gpu>[:count] is malformed: "${spec}"`, topic);
  }
  const [, provider, gpu, count] = parts;
  let gpuCount = 1;
  if (count !== undefined) {
    if (!/^\d+$/.test(count) || Number(count) < 1) {
      throw new UsageError(`--to count must be a whole number of at least 1, got "${count}"`, topic);
    }
    gpuCount = Number(count);
  }
  return { provider: providerFlag(provider, topic), gpu, gpuCount, cpu: DEFAULTS.cpu, memoryGb: DEFAULTS.memoryGb };
}

function parseSession(argv) {
  const topic = "session";
  const sub = argv[0];
  if (sub === undefined) throw new UsageError("session needs a subcommand", topic);
  if (sub !== "move") throw new UsageError(`Unknown command: session ${sub}`, topic);
  const { positionals, flags } = splitFlags(argv.slice(1), ["to", "home", "session"], ["home"], topic);
  noPositionals(positionals, topic);
  if (flags.to && flags.home) throw new UsageError("session move takes either --to or --home, not both", topic);
  if (!flags.to && !flags.home) throw new UsageError("session move needs --to <node-id|new:...> or --home", topic);
  const result = { cmd: "session.move" };
  if (flags.home) {
    result.home = true;
  } else if (flags.to.startsWith("new:")) {
    result.newNode = parseNewNodeTarget(flags.to, topic);
  } else {
    result.nodeId = flags.to;
  }
  if (flags.session) result.session = flags.session;
  return result;
}

function parseArgs(argv) {
  const args = Array.from(argv || []);
  const group = args[0];
  if (wantsHelp(args) || group === "help") {
    const topic = group === "node" || group === "session" ? group : undefined;
    return { cmd: "help", topic };
  }
  switch (group) {
    case "node":
      return parseNode(args.slice(1));
    case "session":
      return parseSession(args.slice(1));
    case undefined:
      throw new UsageError("No command given");
    default:
      throw new UsageError(`Unknown command: ${group}`);
  }
}

// ---------------------------------------------------------------- HTTP

function errorOf(status, data) {
  if (data && typeof data.error === "string" && data.error) return data.error;
  return `Naught answered HTTP ${status}`;
}

async function request(ctx, method, path, body) {
  const url = `${ctx.baseUrl}${path}`;
  const init = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await ctx.fetch(url, init);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    return { status: 0, ok: false, data: { error: `could not reach Naught at ${ctx.baseUrl}: ${reason}` } };
  }
  const status = response.status;
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let data = {};
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      return { status, ok: false, data: { error: `Naught returned a non-JSON response (HTTP ${status})` } };
    }
  }
  if (data === null || typeof data !== "object") data = { value: data };
  const ok = status >= 200 && status < 300;
  if (!ok) data = Object.assign({ error: errorOf(status, data) }, data, { error: errorOf(status, data) });
  return { status, ok, data };
}

function nodePath(id) {
  return `/api/compute/nodes/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------- nodes

function provisionOf(node) {
  return (node && node.provision) || {};
}

// The flat shape create/wait print on every exit path.
function summarizeNode(node) {
  const provision = provisionOf(node);
  const summary = { id: node.id, name: node.name, status: provision.status };
  if (node.host) {
    const user = node.user ? `${node.user}@` : "";
    const port = node.port ? `-p ${node.port} ` : "";
    summary.ssh = `ssh ${port}${user}${node.host}`;
  }
  if (node.defaultPath) summary.home = node.defaultPath;
  if (provision.hourlyUsd !== undefined) summary.hourlyUsd = provision.hourlyUsd;
  if (provision.provider !== undefined) summary.provider = provision.provider;
  if (provision.gpu !== undefined) summary.gpu = provision.gpu;
  return summary;
}

// Resolves once the node is ready / failed / gone / the wait ran out.
// `initial` lets the caller evaluate a node it already holds before polling.
async function waitForNode(ctx, id, timeoutSeconds, initial) {
  const deadline = ctx.now() + timeoutSeconds * 1000;
  let node = initial;
  for (;;) {
    if (!node) {
      const res = await request(ctx, "GET", nodePath(id));
      if (!res.ok) return { code: 1, output: Object.assign({ id }, res.data) };
      node = res.data.node;
      if (!node) return { code: 1, output: { id, error: "Naught returned no node" } };
    }
    const status = provisionOf(node).status;
    if (status === "ready") return { code: 0, output: summarizeNode(node) };
    if (status === "error" || status === "terminated") {
      const output = { id: node.id || id, status };
      if (provisionOf(node).error) output.error = provisionOf(node).error;
      return { code: 1, output };
    }
    const remaining = deadline - ctx.now();
    if (remaining <= 0) return { code: 1, output: { id: node.id || id, status, timedOut: true } };
    await ctx.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    node = undefined;
  }
}

async function nodeOffers(ctx, args) {
  const providers = args.provider ? [args.provider] : PROVIDERS;
  const results = await Promise.all(providers.map((provider) =>
    request(ctx, "GET", `/api/compute/offers?provider=${encodeURIComponent(provider)}`)
      .then((res) => ({ provider, res }))));
  const offers = [];
  const errors = [];
  for (const { provider, res } of results) {
    if (res.ok) offers.push(...(Array.isArray(res.data.offers) ? res.data.offers : []));
    else errors.push({ provider, error: res.data.error });
  }
  const output = { offers };
  if (errors.length > 0) output.errors = errors;
  ctx.print(output);
  if (errors.length === providers.length) {
    ctx.say(`naught: no provider answered (${errors.map((e) => `${e.provider}: ${e.error}`).join("; ")})`);
    return 1;
  }
  return 0;
}

function parkedMessage(id) {
  return `Naught parked this request for approval in the IDE; run \`naught node wait ${id}\` to block until it is decided.`;
}

async function nodeCreate(ctx, args) {
  const body = { provider: args.provider };
  if (args.gpu !== undefined) body.gpu = args.gpu;
  body.gpuCount = args.gpuCount;
  body.cpu = args.cpu;
  body.memoryGb = args.memoryGb;
  if (args.diskGb !== undefined) body.diskGb = args.diskGb;
  if (args.image !== undefined) body.image = args.image;
  if (args.name !== undefined) body.name = args.name;
  body.requestedBy = ctx.requestedBy;

  const res = await request(ctx, "POST", "/api/compute/nodes", body);
  if (!res.ok) return ctx.fail(res.data);
  const node = res.data.node;
  if (!node || !node.id) return ctx.fail({ error: "Naught returned no node" });

  if (res.status === 202 || res.data.pending === true || provisionOf(node).status === "pending") {
    const reasons = Array.isArray(res.data.reasons) ? res.data.reasons
      : Array.isArray(provisionOf(node).reasons) ? provisionOf(node).reasons : [];
    ctx.print({ id: node.id, status: "pending", reasons });
    ctx.say(parkedMessage(node.id));
    return 2;
  }

  if (args.wait === 0) {
    ctx.print(summarizeNode(node));
    return 0;
  }
  const result = await waitForNode(ctx, node.id, args.wait, node);
  ctx.print(result.output);
  if (result.output.timedOut) {
    ctx.say(`naught: node ${node.id} was not ready after ${args.wait}s; run \`naught node wait ${node.id}\` to keep waiting.`);
  }
  return result.code;
}

async function nodeWait(ctx, args) {
  const result = await waitForNode(ctx, args.id, args.timeout);
  ctx.print(result.output);
  if (result.output.timedOut) {
    ctx.say(`naught: node ${args.id} is still ${result.output.status} after ${args.timeout}s.`);
  }
  return result.code;
}

async function nodeList(ctx) {
  const res = await request(ctx, "GET", "/api/compute/nodes");
  if (!res.ok) return ctx.fail(res.data);
  ctx.print({ nodes: Array.isArray(res.data.nodes) ? res.data.nodes : [] });
  return 0;
}

async function nodeStatus(ctx, args) {
  const res = await request(ctx, "GET", nodePath(args.id));
  if (!res.ok) return ctx.fail(res.data);
  ctx.print({ node: res.data.node });
  return 0;
}

async function nodeTerminate(ctx, args) {
  const res = await request(ctx, "DELETE", nodePath(args.id));
  if (!res.ok) return ctx.fail(res.data);
  ctx.print(Object.keys(res.data).length > 0 ? res.data : { ok: true });
  return 0;
}

// ---------------------------------------------------------------- session move

function destinationName(data) {
  const plan = data && data.plan;
  const destination = plan && plan.destination;
  if (typeof destination === "string" && destination) return destination;
  if (destination && typeof destination === "object") {
    if (typeof destination.name === "string" && destination.name) return destination.name;
    if (typeof destination.id === "string" && destination.id) return destination.id;
  }
  return "the node";
}

async function sessionMove(ctx, args) {
  const sessionId = args.session || ctx.sessionId;
  if (!sessionId) {
    throw new UsageError(
      "session move needs --session <id> outside a Naught session (OPENUI_SESSION_ID is not set)",
      "session",
    );
  }
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/move`;
  let res;
  if (args.home) {
    res = await request(ctx, "POST", `${base}/home`, { afterTurn: true });
  } else if (args.newNode) {
    res = await request(ctx, "POST", base, { newNode: args.newNode, afterTurn: true });
  } else {
    res = await request(ctx, "POST", base, { nodeId: args.nodeId, afterTurn: true });
  }
  if (!res.ok) {
    const output = { error: res.data.error };
    if (Array.isArray(res.data.refusals)) output.refusals = res.data.refusals;
    return ctx.fail(output);
  }
  ctx.print(res.data);
  if (args.home) {
    ctx.say("This session will be brought back to this Mac after this turn; your next turn resumes there.");
  } else {
    ctx.say(`This session will be relaunched on ${destinationName(res.data)} after this turn; your next turn resumes there.`);
  }
  return 0;
}

// ---------------------------------------------------------------- run

function writerFor(target, fallback) {
  if (typeof target === "function") return target;
  if (target && typeof target.write === "function") return (text) => target.write(text);
  return (text) => fallback.write(text);
}

async function run(argv, options = {}) {
  const env = options.env || process.env;
  const out = writerFor(options.out, process.stdout);
  const err = writerFor(options.err, process.stderr);
  const say = (line) => err(`${line}\n`);

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`naught: ${error.message}\n\n${usage(error.topic)}`);
    return 2;
  }
  if (args.cmd === "help") {
    out(usage(args.topic));
    return 0;
  }

  const port = env.OPENUI_PORT;
  if (!port) {
    say("naught: not running inside a Naught session (OPENUI_PORT is not set)");
    return 1;
  }
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    say("naught: this Node has no fetch; Naught needs Node 18 or newer");
    return 1;
  }

  const sessionId = env.OPENUI_SESSION_ID || undefined;
  const ctx = {
    baseUrl: `http://${env.OPENUI_HOST || "127.0.0.1"}:${port}`,
    fetch: fetchFn,
    now: options.now || Date.now,
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    sessionId,
    requestedBy: sessionId ? { kind: "session", sessionId } : { kind: "user" },
    print: (value) => out(`${JSON.stringify(value, null, 2)}\n`),
    say,
    fail: (output) => {
      ctx.print(output);
      say(`naught: ${output && output.error ? output.error : "request failed"}`);
      return 1;
    },
  };

  try {
    switch (args.cmd) {
      case "node.offers": return await nodeOffers(ctx, args);
      case "node.create": return await nodeCreate(ctx, args);
      case "node.wait": return await nodeWait(ctx, args);
      case "node.list": return await nodeList(ctx);
      case "node.status": return await nodeStatus(ctx, args);
      case "node.terminate": return await nodeTerminate(ctx, args);
      case "session.move": return await sessionMove(ctx, args);
      default:
        err(`naught: Unknown command: ${args.cmd}\n\n${usage()}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`naught: ${error.message}\n\n${usage(error.topic)}`);
      return 2;
    }
    throw error;
  }
}

function main() {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`naught: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { parseArgs, run, usage };

if (require.main === module) main();
