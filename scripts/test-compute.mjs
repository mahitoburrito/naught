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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
