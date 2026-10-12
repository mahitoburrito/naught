#!/usr/bin/env node
// Behaviour tests for the naught CLI: argument parsing and the HTTP client against a fake Naught server.

import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseArgs, run, usage } = require(join(here, "..", "bin", "naught.js"));

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

function parseError(argv) {
  try {
    parseArgs(argv);
    return null;
  } catch (error) {
    return error.message;
  }
}

// A fake Naught server. `handler(call, n)` returns `{ status, body }` (or `{ status, text }`
// for a non-JSON reply); `undefined` means 404. Every request is recorded on `fn.calls`.
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      url,
      method: init.method || "GET",
      path: parsed.pathname + parsed.search,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call, calls.length) || { status: 404, body: { error: "not found" } };
    const text = reply.text !== undefined ? reply.text : JSON.stringify(reply.body);
    // A 204 must carry a null body: the Response constructor refuses a string there.
    return new Response(text === "" ? null : text, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const ENV = { OPENUI_PORT: "7968", OPENUI_SESSION_ID: "s1" };

async function invoke(argv, { fetch = fakeFetch(() => undefined), env = ENV } = {}) {
  const out = [];
  const err = [];
  const delays = [];
  let clock = 1_000_000;
  const code = await run(argv, {
    fetch,
    env,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    now: () => clock,
  });
  const stdout = out.join("");
  let json = null;
  try { json = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr: err.join(""), json, delays, calls: fetch.calls };
}

const provisioning = {
  id: "n1", name: "gpu-1",
  provision: { provider: "modal", instanceId: "sb-1", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, status: "provisioning", hourlyUsd: 3.95 },
};
const ready = {
  ...provisioning, host: "h", user: "root", port: 22, defaultPath: "/root",
  provision: { ...provisioning.provision, status: "ready", startedAt: 1, readyAt: 2 },
};

// ----------------------------------------------------------------- parseArgs

console.log("\nparseArgs: node create");

check(
  "the plan's example with defaults filled in",
  parseArgs(["node", "create", "--provider", "modal", "--gpu", "H100", "--cpu", "4"]),
  { cmd: "node.create", provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, wait: 600 },
);
check(
  "--count 2",
  parseArgs(["node", "create", "--provider", "modal", "--gpu", "H100", "--count", "2"]).gpuCount,
  2,
);
check(
  "every flag, including the --flag=value form",
  parseArgs(["node", "create", "--provider=thunder", "--gpu", "A100", "--count=2", "--cpu", "8", "--memory", "64",
    "--disk", "200", "--image", "tmpl-1", "--name", "box", "--wait", "30"]),
  { cmd: "node.create", provider: "thunder", gpu: "A100", gpuCount: 2, cpu: 8, memoryGb: 64, diskGb: 200, image: "tmpl-1", name: "box", wait: 30 },
);
check("--no-wait is wait 0", parseArgs(["node", "create", "--provider", "modal", "--gpu", "H100", "--no-wait"]).wait, 0);
check(
  "no --gpu means a CPU-only request with gpuCount 0",
  parseArgs(["node", "create", "--provider", "modal"]),
  { cmd: "node.create", provider: "modal", gpuCount: 0, cpu: 4, memoryGb: 16, wait: 600 },
);
check("--count without --gpu is refused", parseError(["node", "create", "--provider", "modal", "--count", "2"]), "--count needs --gpu");
check("--gpu with --count 0 is refused", parseError(["node", "create", "--provider", "modal", "--gpu", "H100", "--count", "0"]), "--gpu needs a --count of at least 1");
check("a non-numeric --cpu is refused", parseError(["node", "create", "--provider", "modal", "--cpu", "lots"]), '--cpu must be a whole number, got "lots"');
check("--cpu 0 is refused", parseError(["node", "create", "--provider", "modal", "--cpu", "0"]), "--cpu must be at least 1");
check("an unknown flag is a usage error", parseError(["node", "create", "--provider", "modal", "--foo", "1"]), "Unknown flag: --foo");
check("an unknown provider is refused", parseError(["node", "create", "--provider", "lambda"]), 'Unknown provider "lambda" (expected modal or thunder)');
check("--provider is required", parseError(["node", "create", "--gpu", "H100"]), "node create needs --provider");
check("a flag without a value is refused", parseError(["node", "create", "--provider"]), "--provider needs a value");
check("--no-wait and --wait together are refused", parseError(["node", "create", "--provider", "modal", "--no-wait", "--wait", "5"]), "--no-wait and --wait cannot be combined");
check("a stray positional is refused", parseError(["node", "create", "--provider", "modal", "extra"]), "Unexpected argument: extra");

console.log("\nparseArgs: other node commands");

check("node offers", parseArgs(["node", "offers"]), { cmd: "node.offers" });
check("node offers --provider thunder", parseArgs(["node", "offers", "--provider", "thunder"]), { cmd: "node.offers", provider: "thunder" });
check("node offers rejects an unknown provider", parseError(["node", "offers", "--provider", "aws"]), 'Unknown provider "aws" (expected modal or thunder)');
check("node list", parseArgs(["node", "list"]), { cmd: "node.list" });
check("node list rejects an argument", parseError(["node", "list", "n1"]), "Unexpected argument: n1");
check("node status <id>", parseArgs(["node", "status", "n1"]), { cmd: "node.status", id: "n1" });
check("node status needs an id", parseError(["node", "status"]), "Missing node id");
check("node status takes one id", parseError(["node", "status", "n1", "n2"]), "Unexpected argument: n2");
check("node terminate <id>", parseArgs(["node", "terminate", "n1"]), { cmd: "node.terminate", id: "n1" });
check("node wait <id> defaults the timeout", parseArgs(["node", "wait", "n1"]), { cmd: "node.wait", id: "n1", timeout: 600 });
check("node wait --timeout 30", parseArgs(["node", "wait", "n1", "--timeout", "30"]), { cmd: "node.wait", id: "n1", timeout: 30 });
check("node alone is a usage error", parseError(["node"]), "node needs a subcommand");
check("an unknown node subcommand is a usage error", parseError(["node", "reboot"]), "Unknown command: node reboot");

console.log("\nparseArgs: session move");

check("--to <node-id>", parseArgs(["session", "move", "--to", "n1"]), { cmd: "session.move", nodeId: "n1" });
check(
  "--to new:modal:H100 becomes a newNode spec",
  parseArgs(["session", "move", "--to", "new:modal:H100"]),
  { cmd: "session.move", newNode: { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16 } },
);
check(
  "--to new:thunder:A100:2 --session abc",
  parseArgs(["session", "move", "--to", "new:thunder:A100:2", "--session", "abc"]),
  { cmd: "session.move", newNode: { provider: "thunder", gpu: "A100", gpuCount: 2, cpu: 4, memoryGb: 16 }, session: "abc" },
);
check("--home", parseArgs(["session", "move", "--home"]), { cmd: "session.move", home: true });
check("--home --session s9", parseArgs(["session", "move", "--home", "--session", "s9"]), { cmd: "session.move", home: true, session: "s9" });
check("a malformed new: target is refused", parseError(["session", "move", "--to", "new:modal"]), '--to new:<provider>:<gpu>[:count] is malformed: "new:modal"');
check("a new: target with an unknown provider is refused", parseError(["session", "move", "--to", "new:aws:H100"]), 'Unknown provider "aws" (expected modal or thunder)');
check("a new: target with a bad count is refused", parseError(["session", "move", "--to", "new:modal:H100:zero"]), '--to count must be a whole number of at least 1, got "zero"');
check("--to and --home together are refused", parseError(["session", "move", "--to", "n1", "--home"]), "session move takes either --to or --home, not both");
check("neither --to nor --home is refused", parseError(["session", "move"]), "session move needs --to <node-id|new:...> or --home");
check("--home takes no value", parseError(["session", "move", "--home=yes"]), "--home takes no value");
check("an unknown session subcommand is a usage error", parseError(["session", "list"]), "Unknown command: session list");

console.log("\nparseArgs: help and unknown commands");

check("--help", parseArgs(["--help"]), { cmd: "help" });
check("-h", parseArgs(["-h"]), { cmd: "help" });
check("help", parseArgs(["help"]), { cmd: "help" });
check("node --help", parseArgs(["node", "--help"]), { cmd: "help", topic: "node" });
check("node create --help", parseArgs(["node", "create", "--help"]), { cmd: "help", topic: "node" });
check("session --help", parseArgs(["session", "--help"]), { cmd: "help", topic: "session" });
check("no arguments is a usage error", parseError([]), "No command given");
check("an unknown command is a usage error", parseError(["bogus"]), "Unknown command: bogus");
check("usage() covers both groups", usage().includes("naught node create") && usage().includes("naught session move"), true);
check("usage('node') leaves session out", usage("node").includes("naught session move"), false);
check("usage('session') leaves node out", usage("session").includes("naught node create"), false);

// ----------------------------------------------------------------- run: environment and help

console.log("\nrun: environment and help");

{
  const r = await invoke(["node", "list"], { env: { OPENUI_SESSION_ID: "s1" } });
  check("missing OPENUI_PORT exits 1", r.code, 1);
  check("missing OPENUI_PORT names Naught on stderr", r.stderr, "naught: not running inside a Naught session (OPENUI_PORT is not set)\n");
  check("missing OPENUI_PORT prints nothing on stdout", r.stdout, "");
  check("missing OPENUI_PORT never calls the server", r.calls.length, 0);
}
{
  const r = await invoke(["--help"], { env: {} });
  check("--help exits 0 without OPENUI_PORT", r.code, 0);
  check("--help prints usage on stdout", r.stdout, usage());
  check("--help prints nothing on stderr", r.stderr, "");
}
{
  const r = await invoke(["node", "--help"], { env: {} });
  check("node --help exits 0", r.code, 0);
  check("node --help prints the node usage", r.stdout, usage("node"));
}
{
  const r = await invoke(["bogus"]);
  check("an unknown command exits 2", r.code, 2);
  check("an unknown command prints usage on stderr", r.stderr.startsWith("naught: Unknown command: bogus\n\nUsage:\n"), true);
  check("an unknown command prints nothing on stdout", r.stdout, "");
}
{
  const r = await invoke(["node", "create", "--provider", "modal", "--bogus"]);
  check("an unknown flag exits 2", r.code, 2);
  check("an unknown flag prints the node usage on stderr", r.stderr, `naught: Unknown flag: --bogus\n\n${usage("node")}`);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { nodes: [] } }));
  const r = await invoke(["node", "list"], { fetch, env: { OPENUI_PORT: "7968", OPENUI_HOST: "10.0.0.9" } });
  check("OPENUI_HOST overrides the base URL", r.calls[0].url, "http://10.0.0.9:7968/api/compute/nodes");
  check("the base URL defaults to 127.0.0.1", (await invoke(["node", "list"], { fetch: fakeFetch(() => ({ status: 200, body: { nodes: [] } })) })).calls[0].url, "http://127.0.0.1:7968/api/compute/nodes");
}

// ----------------------------------------------------------------- run: node create

console.log("\nrun: node create");

{
  const fetch = fakeFetch((call, n) => {
    if (call.method === "POST" && call.path === "/api/compute/nodes") return { status: 201, body: { node: provisioning } };
    if (call.method === "GET" && call.path === "/api/compute/nodes/n1") return { status: 200, body: { node: n <= 3 ? provisioning : ready } };
    return undefined;
  });
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100"], { fetch });
  check("create POSTs the spec with the session as requester", r.calls[0], {
    url: "http://127.0.0.1:7968/api/compute/nodes",
    method: "POST",
    path: "/api/compute/nodes",
    body: { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, requestedBy: { kind: "session", sessionId: "s1" } },
  });
  check("create polls GET /nodes/:id until ready", r.calls.slice(1).map((c) => `${c.method} ${c.path}`),
    ["GET /api/compute/nodes/n1", "GET /api/compute/nodes/n1", "GET /api/compute/nodes/n1"]);
  check("create sleeps 3 s between polls", r.delays, [3000, 3000, 3000]);
  check("create prints the ready summary", r.json,
    { id: "n1", name: "gpu-1", status: "ready", ssh: "ssh -p 22 root@h", home: "/root", hourlyUsd: 3.95, provider: "modal", gpu: "H100" });
  check("create exits 0 when ready", r.code, 0);
  check("create prints 2-space JSON", r.stdout.startsWith('{\n  "id": "n1",\n'), true);
}
{
  const fetch = fakeFetch(() => ({ status: 201, body: { node: ready } }));
  const r = await invoke(["node", "create", "--provider", "thunder", "--gpu", "A100", "--count", "2", "--cpu", "8", "--memory", "32", "--disk", "100", "--image", "t1", "--name", "box"],
    { fetch, env: { OPENUI_PORT: "7968" } });
  check("create outside a session sends the user as requester and every optional field", r.calls[0].body,
    { provider: "thunder", gpu: "A100", gpuCount: 2, cpu: 8, memoryGb: 32, diskGb: 100, image: "t1", name: "box", requestedBy: { kind: "user" } });
  check("a node already ready in the 201 needs no polling", r.calls.length, 1);
  check("no polling means no sleeping", r.delays, []);
  check("a ready 201 exits 0", r.code, 0);
}
{
  const pending = { ...provisioning, id: "n2", provision: { ...provisioning.provision, status: "pending" } };
  const fetch = fakeFetch(() => ({ status: 202, body: { node: pending, pending: true, reasons: ["H100 is not in allowedGpus", "2 nodes already live"] } }));
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100"], { fetch });
  check("a 202 exits 2", r.code, 2);
  check("a 202 prints the pending shape", r.json, { id: "n2", status: "pending", reasons: ["H100 is not in allowedGpus", "2 nodes already live"] });
  check("a 202 tells the agent how to wait", r.stderr, "Naught parked this request for approval in the IDE; run `naught node wait n2` to block until it is decided.\n");
  check("a 202 does not poll", r.calls.length, 1);
}
{
  const errored = { ...provisioning, provision: { ...provisioning.provision, status: "error", error: "Modal: quota exceeded" } };
  const fetch = fakeFetch((call) => call.method === "POST" ? { status: 201, body: { node: provisioning } } : { status: 200, body: { node: errored } });
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100"], { fetch });
  check("an error status exits 1", r.code, 1);
  check("an error status prints the error", r.json, { id: "n1", status: "error", error: "Modal: quota exceeded" });
}
{
  const gone = { ...provisioning, provision: { ...provisioning.provision, status: "terminated" } };
  const fetch = fakeFetch((call) => call.method === "POST" ? { status: 201, body: { node: provisioning } } : { status: 200, body: { node: gone } });
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100"], { fetch });
  check("a terminated node exits 1", r.code, 1);
  check("a terminated node prints its status", r.json, { id: "n1", status: "terminated" });
}
{
  const fetch = fakeFetch(() => ({ status: 201, body: { node: provisioning } }));
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100", "--no-wait"], { fetch });
  check("--no-wait exits 0 at once", r.code, 0);
  check("--no-wait never polls", r.calls.length, 1);
  check("--no-wait never sleeps", r.delays, []);
  check("--no-wait prints the node as it is (no ssh target yet)", r.json, { id: "n1", name: "gpu-1", status: "provisioning", hourlyUsd: 3.95, provider: "modal", gpu: "H100" });
}
{
  const fetch = fakeFetch((call) => call.method === "POST" ? { status: 201, body: { node: provisioning } } : { status: 200, body: { node: provisioning } });
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "H100", "--wait", "7"], { fetch });
  check("create --wait expiring exits 1", r.code, 1);
  check("create --wait expiring prints timedOut", r.json, { id: "n1", status: "provisioning", timedOut: true });
  check("create --wait never sleeps past the deadline", r.delays, [3000, 3000, 1000]);
  check("create --wait expiring says how to continue", r.stderr, "naught: node n1 was not ready after 7s; run `naught node wait n1` to keep waiting.\n");
}
{
  const fetch = fakeFetch(() => ({ status: 400, body: { error: "unknown gpu Z9" } }));
  const r = await invoke(["node", "create", "--provider", "modal", "--gpu", "Z9"], { fetch });
  check("a 4xx on create exits 1", r.code, 1);
  check("a 4xx on create prints the server error", r.json, { error: "unknown gpu Z9" });
  check("a 4xx on create is also said on stderr", r.stderr, "naught: unknown gpu Z9\n");
}
{
  const fetch = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7968"); };
  fetch.calls = [];
  const r = await invoke(["node", "create", "--provider", "modal"], { fetch });
  check("an unreachable server exits 1", r.code, 1);
  check("an unreachable server names the base URL", r.json, { error: "could not reach Naught at http://127.0.0.1:7968: connect ECONNREFUSED 127.0.0.1:7968" });
}
{
  const fetch = fakeFetch(() => ({ status: 200, text: "<html>not naught</html>" }));
  const r = await invoke(["node", "create", "--provider", "modal"], { fetch });
  check("a non-JSON reply exits 1", r.code, 1);
  check("a non-JSON reply is reported, not thrown", r.json, { error: "Naught returned a non-JSON response (HTTP 200)" });
}

// ----------------------------------------------------------------- run: node wait

console.log("\nrun: node wait");

{
  const fetch = fakeFetch(() => ({ status: 200, body: { node: provisioning } }));
  const r = await invoke(["node", "wait", "n1", "--timeout", "7"], { fetch });
  check("wait polls until the timeout expires", r.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/compute/nodes/n1", "GET /api/compute/nodes/n1", "GET /api/compute/nodes/n1", "GET /api/compute/nodes/n1"]);
  check("wait clips the last sleep to the deadline", r.delays, [3000, 3000, 1000]);
  check("wait expiring exits 1", r.code, 1);
  check("wait expiring prints timedOut with the last status", r.json, { id: "n1", status: "provisioning", timedOut: true });
  check("wait expiring says so on stderr", r.stderr, "naught: node n1 is still provisioning after 7s.\n");
}
{
  const pending = { ...provisioning, provision: { ...provisioning.provision, status: "pending" } };
  const fetch = fakeFetch((call, n) => ({ status: 200, body: { node: n < 3 ? pending : ready } }));
  const r = await invoke(["node", "wait", "n1"], { fetch });
  check("wait keeps polling a pending node until it is approved and ready", r.calls.length, 3);
  check("wait prints the ready summary", r.json, { id: "n1", name: "gpu-1", status: "ready", ssh: "ssh -p 22 root@h", home: "/root", hourlyUsd: 3.95, provider: "modal", gpu: "H100" });
  check("wait exits 0 when ready", r.code, 0);
}
{
  const r = await invoke(["node", "wait", "zz"], { fetch: fakeFetch(() => undefined) });
  check("wait on an unknown node exits 1", r.code, 1);
  check("wait on an unknown node prints the server error with the id", r.json, { id: "zz", error: "not found" });
}
{
  const errored = { ...provisioning, provision: { ...provisioning.provision, status: "error", error: "ssh never came up" } };
  const r = await invoke(["node", "wait", "n1"], { fetch: fakeFetch(() => ({ status: 200, body: { node: errored } })) });
  check("wait on an errored node exits 1 at once", r.code, 1);
  check("wait on an errored node prints the error", r.json, { id: "n1", status: "error", error: "ssh never came up" });
}

// ----------------------------------------------------------------- run: list / status / terminate

console.log("\nrun: node list, status, terminate");

{
  const fetch = fakeFetch(() => ({ status: 200, body: { nodes: [ready] } }));
  const r = await invoke(["node", "list"], { fetch });
  check("list GETs /api/compute/nodes", `${r.calls[0].method} ${r.calls[0].path}`, "GET /api/compute/nodes");
  check("list prints { nodes }", r.json, { nodes: [ready] });
  check("list exits 0", r.code, 0);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { node: ready } }));
  const r = await invoke(["node", "status", "n1"], { fetch });
  check("status GETs /api/compute/nodes/:id", `${r.calls[0].method} ${r.calls[0].path}`, "GET /api/compute/nodes/n1");
  check("status prints { node }", r.json, { node: ready });
  check("status exits 0", r.code, 0);
}
{
  const r = await invoke(["node", "status", "a/b c"], { fetch: fakeFetch(() => undefined) });
  check("status encodes the id in the path", r.calls[0].path, "/api/compute/nodes/a%2Fb%20c");
  check("status on an unknown node exits 1", r.code, 1);
  check("status on an unknown node prints the error", r.json, { error: "not found" });
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  const r = await invoke(["node", "terminate", "n1"], { fetch });
  check("terminate DELETEs /api/compute/nodes/:id", `${r.calls[0].method} ${r.calls[0].path}`, "DELETE /api/compute/nodes/n1");
  check("terminate sends no body", r.calls[0].body, undefined);
  check("terminate prints { ok: true }", r.json, { ok: true });
  check("terminate exits 0", r.code, 0);
}
{
  const r = await invoke(["node", "terminate", "n1"], { fetch: fakeFetch(() => ({ status: 204, text: "" })) });
  check("an empty 204 on terminate still prints { ok: true }", r.json, { ok: true });
  check("an empty 204 on terminate exits 0", r.code, 0);
}

// ----------------------------------------------------------------- run: node offers

console.log("\nrun: node offers");

const modalOffer = { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16, hourlyUsd: 4.9, label: "H100 · medium" };
const thunderOffer = { provider: "thunder", gpu: "A100", gpuCount: 1, cpu: 4, memoryGb: 16, diskGb: 100, hourlyUsd: 1.2, available: true, label: "A100" };

{
  const fetch = fakeFetch((call) => {
    if (call.path === "/api/compute/offers?provider=modal") return { status: 200, body: { offers: [modalOffer] } };
    if (call.path === "/api/compute/offers?provider=thunder") return { status: 502, body: { error: "Thunder: fetch failed" } };
    return undefined;
  });
  const r = await invoke(["node", "offers"], { fetch });
  check("offers asks every provider when none is given", r.calls.map((c) => c.path).sort(), ["/api/compute/offers?provider=modal", "/api/compute/offers?provider=thunder"]);
  check("offers concatenates successes and lists the failing provider", r.json, { offers: [modalOffer], errors: [{ provider: "thunder", error: "Thunder: fetch failed" }] });
  check("offers exits 0 when at least one provider answered", r.code, 0);
}
{
  const fetch = fakeFetch((call) => ({ status: 200, body: { offers: [call.path.endsWith("modal") ? modalOffer : thunderOffer] } }));
  const r = await invoke(["node", "offers"], { fetch });
  check("offers keeps provider order modal, thunder", r.json, { offers: [modalOffer, thunderOffer] });
  check("offers omits errors when there are none", "errors" in r.json, false);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { offers: [thunderOffer] } }));
  const r = await invoke(["node", "offers", "--provider", "thunder"], { fetch });
  check("offers --provider asks only that provider", r.calls.map((c) => c.path), ["/api/compute/offers?provider=thunder"]);
  check("offers --provider prints that provider's offers", r.json, { offers: [thunderOffer] });
}
{
  const fetch = fakeFetch(() => ({ status: 503, body: { error: "no key" } }));
  const r = await invoke(["node", "offers"], { fetch });
  check("offers exits 1 when every provider failed", r.code, 1);
  check("offers still prints the errors when every provider failed", r.json, { offers: [], errors: [{ provider: "modal", error: "no key" }, { provider: "thunder", error: "no key" }] });
}

// ----------------------------------------------------------------- run: session move

console.log("\nrun: session move");

const accepted = { accepted: true, plan: { destination: "gpu-1", harness: "claude", files: 1234 } };

{
  const fetch = fakeFetch(() => ({ status: 202, body: accepted }));
  const r = await invoke(["session", "move", "--to", "n1"], { fetch });
  check("--to posts the node id to the session from the environment", r.calls[0], {
    url: "http://127.0.0.1:7968/api/sessions/s1/move", method: "POST", path: "/api/sessions/s1/move", body: { nodeId: "n1", afterTurn: true },
  });
  check("--to prints the server's answer", r.json, accepted);
  check("--to tells the agent what happens next", r.stderr, "This session will be relaunched on gpu-1 after this turn; your next turn resumes there.\n");
  check("--to exits 0", r.code, 0);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { accepted: true, plan: { destination: { id: "n7" }, harness: "codex", files: 3 } } }));
  const r = await invoke(["session", "move", "--to", "new:modal:H100"], { fetch });
  check("--to new:modal:H100 posts a newNode spec", r.calls[0].body, { newNode: { provider: "modal", gpu: "H100", gpuCount: 1, cpu: 4, memoryGb: 16 }, afterTurn: true });
  check("--to new: names the destination the server reports", r.stderr, "This session will be relaunched on n7 after this turn; your next turn resumes there.\n");
  check("--to new: exits 0", r.code, 0);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { accepted: true } }));
  const r = await invoke(["session", "move", "--home"], { fetch });
  check("--home posts to /move/home", r.calls[0], {
    url: "http://127.0.0.1:7968/api/sessions/s1/move/home", method: "POST", path: "/api/sessions/s1/move/home", body: { afterTurn: true },
  });
  check("--home prints the server's answer", r.json, { accepted: true });
  check("--home tells the agent it comes back to this Mac", r.stderr, "This session will be brought back to this Mac after this turn; your next turn resumes there.\n");
  check("--home exits 0", r.code, 0);
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { accepted: true } }));
  const r = await invoke(["session", "move", "--to", "n1", "--session", "other"], { fetch });
  check("--session overrides the environment's session id", r.calls[0].path, "/api/sessions/other/move");
}
{
  const fetch = fakeFetch(() => ({ status: 200, body: { accepted: true } }));
  const r = await invoke(["session", "move", "--to", "n1", "--session", "s2"], { fetch, env: { OPENUI_PORT: "7968" } });
  check("--session works without OPENUI_SESSION_ID", r.calls[0].path, "/api/sessions/s2/move");
  check("a session move without a plan still says what happens next", r.stderr, "This session will be relaunched on the node after this turn; your next turn resumes there.\n");
}
{
  const r = await invoke(["session", "move", "--to", "n1"], { env: { OPENUI_PORT: "7968" } });
  check("no session id anywhere exits 2", r.code, 2);
  check("no session id anywhere explains --session", r.stderr.startsWith("naught: session move needs --session <id> outside a Naught session (OPENUI_SESSION_ID is not set)\n\nUsage:\n"), true);
  check("no session id anywhere never calls the server", r.calls.length, 0);
  check("no session id anywhere prints nothing on stdout", r.stdout, "");
}
{
  const fetch = fakeFetch(() => ({ status: 409, body: { error: "cannot move", refusals: ["session is already on a node", "node n1 is not ready"] } }));
  const r = await invoke(["session", "move", "--to", "n1"], { fetch });
  check("a refused move exits 1", r.code, 1);
  check("a refused move prints the error and refusals", r.json, { error: "cannot move", refusals: ["session is already on a node", "node n1 is not ready"] });
  check("a refused move does not promise a relaunch", r.stderr, "naught: cannot move\n");
}
{
  const fetch = fakeFetch(() => ({ status: 404, body: { error: "session not found" } }));
  const r = await invoke(["session", "move", "--home"], { fetch });
  check("a 404 on --home exits 1", r.code, 1);
  check("a 404 on --home prints only the error when there are no refusals", r.json, { error: "session not found" });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
