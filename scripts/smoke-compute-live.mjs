#!/usr/bin/env node
// Opt-in live smoke: provisions a CPU-only Modal sandbox through the real
// provider, connects over ssh, checks the agent CLIs, terminates. Spends a
// few cents of Modal credits. Never runs unless NAUGHT_LIVE_SMOKE=1.
//
//   NAUGHT_LIVE_SMOKE=1 npm run smoke:compute-live

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

if (process.env.NAUGHT_LIVE_SMOKE !== "1") {
  console.log("skipped: set NAUGHT_LIVE_SMOKE=1 to provision a real Modal sandbox (spends credits)");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron", "server");
// Never the inherited LAUNCH_CWD: inside a Naught session that is the real
// app's state folder, and the test nodes would land in the user's Devboxes.
process.env.LAUNCH_CWD = process.env.NAUGHT_SMOKE_STATE_DIR || mkdtempSync(join(tmpdir(), "naught-live-"));
process.env.OPENUI_QUIET = "1";

const nodes = await import(join(dist, "services", "compute", "nodes.js"));
const sshExec = await import(join(dist, "services", "compute", "sshExec.js"));

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };

const modal = nodes.providerRegistry().modal;
const configured = await modal.configured();
check("modal is configured", configured.ok, configured.source || configured.detail);
if (!configured.ok) process.exit(1);

nodes.saveComputeConfig({ policy: { maxConcurrentNodes: 1, maxHourlyUsd: 2, maxLifetimeHours: 0.5 }, notifications: {} });
console.log("requesting a CPU-only sandbox…");
const { node, pending, reasons } = await nodes.requestNode({ provider: "modal", cpu: 2, memoryGb: 4, name: "naught-live-smoke", maxLifetimeHours: 0.5 }, { kind: "user" });
check("request was inside policy", !pending, reasons.join("; "));
const ready = await nodes.waitForNode(node.id, 20 * 60_000);
check("node became ready", ready?.provision.status === "ready", ready?.provision.error || ready?.provision.status);
if (ready?.provision.status === "ready") {
  console.log(`  ssh -p ${ready.port} ${ready.user}@${ready.host}`);
  const versions = await sshExec.runOverSsh(ready, 'export PATH="$HOME/.local/bin:$HOME/.naught/bin:$PATH"; claude --version; codex --version; naught --help >/dev/null 2>&1 && echo naught-ok', { timeoutMs: 60_000 });
  console.log(versions.stdout.trim().split("\n").map((l) => `    ${l}`).join("\n"));
  check("claude and codex answer on the node", /claude/i.test(versions.stdout) && /codex/i.test(versions.stdout), versions.stderr.trim().split("\n")[0]);
  check("the naught CLI is on the node", versions.stdout.includes("naught-ok"));
}
const gone = await nodes.terminateNode(node.id, "user");
check("node terminated", gone?.provision.status === "terminated");
nodes.stopNodeTicker();
console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
