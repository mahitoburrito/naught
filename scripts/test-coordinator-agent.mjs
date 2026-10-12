#!/usr/bin/env node
// Behaviour tests for the Claude-backed workspace coordinator agent:
// config resolution, tool runner, and the turn loop (fake client, real tools).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "electron");

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

// ---------------------------------------------------------------- config
console.log("coordinatorAgentConfig");
{
  const cfg = await import(join(dist, "server", "services", "coordinatorAgentConfig.js"));
  const dir = mkdtempSync(join(tmpdir(), "coord-cfg-"));
  check("empty dir loads empty config", cfg.loadCoordinatorAgentConfig(dir), {});
  cfg.saveCoordinatorAgentConfig({ apiKey: "sk-ant-1", model: "claude-opus-5" }, dir);
  check("save then load round-trips", cfg.loadCoordinatorAgentConfig(dir), { apiKey: "sk-ant-1", model: "claude-opus-5" });
  check("settings key beats env", cfg.resolveCoordinatorCredentials({ apiKey: "sk-ant-1" }, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-ant-1", source: "settings" });
  check("env key used when settings empty", cfg.resolveCoordinatorCredentials({}, { ANTHROPIC_API_KEY: "sk-env" }), { apiKey: "sk-env", source: "env" });
  check("no key anywhere", cfg.resolveCoordinatorCredentials({}, {}), { apiKey: undefined, source: null });
  cfg.saveCoordinatorAgentConfig({ apiKey: "" }, dir);
  check("empty key is dropped on save", cfg.loadCoordinatorAgentConfig(dir), {});
  check("default model constant", cfg.DEFAULT_COORDINATOR_MODEL, "claude-opus-5");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
