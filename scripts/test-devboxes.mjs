#!/usr/bin/env node
// Behaviour tests for ssh_config parsing, safe appends, and devbox command building.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const { parseSshConfig, appendSshConfigHost, readSshConfigHosts } = await import(
  join(here, "..", "dist", "electron", "server", "services", "sshConfig.js")
);
const { buildSshTarget, buildDevboxLaunchCommand } = await import(
  join(here, "..", "dist", "electron", "server", "services", "devboxes.js")
);

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

console.log("\nssh_config parsing");

check(
  "a plain host block",
  parseSshConfig("Host gpu\n  HostName 10.0.0.5\n  User ubuntu\n  Port 2222\n"),
  [{ name: "gpu", hostName: "10.0.0.5", user: "ubuntu", port: 2222 }],
);

check(
  "one Host line declaring several aliases shares the block",
  parseSshConfig("Host a b\n  HostName box\n  User me\n").map((h) => `${h.name}:${h.hostName}:${h.user}`),
  ["a:box:me", "b:box:me"],
);

check(
  "glob patterns are not connectable hosts",
  parseSshConfig("Host ashby cedar s275-? hive?? *.lab !no\n  HostName x\n").map((h) => h.name),
  ["ashby", "cedar"],
);

check(
  "keyword=value form",
  parseSshConfig("Host k\n  HostName=1.2.3.4\n  Port=99\n"),
  [{ name: "k", hostName: "1.2.3.4", port: 99 }],
);

check(
  "comments, blank lines and unknown keywords are ignored",
  parseSshConfig("# lead\n\nHost c\n  ForwardAgent yes\n  HostName h\n  ProxyCommand none\n"),
  [{ name: "c", hostName: "h" }],
);

check(
  "an out-of-range port is dropped rather than trusted",
  parseSshConfig("Host p\n  HostName h\n  Port 70000\n"),
  [{ name: "p", hostName: "h" }],
);

check("settings before any Host line are ignored", parseSshConfig("User nobody\nPort 22\n"), []);

check("a missing file reads as no hosts", readSshConfigHosts(join(tmpdir(), "definitely-absent-config")), []);

console.log("\nappending to ssh config");

const dir = mkdtempSync(join(tmpdir(), "openui-sshconfig-"));
const configPath = join(dir, "config");
const original = "Host existing\n  HostName 1.1.1.1\n";
writeFileSync(configPath, original);

const added = appendSshConfigHost(
  { name: "gpu-box", hostName: "10.0.0.9", user: "ubuntu", port: 2200, identityFile: "~/.ssh/id_ed25519" },
  configPath,
);
check("a new host is appended", added.ok, true);
check(
  "the appended host parses back with its settings",
  readSshConfigHosts(configPath).find((h) => h.name === "gpu-box"),
  { name: "gpu-box", hostName: "10.0.0.9", user: "ubuntu", port: 2200, identityFile: "~/.ssh/id_ed25519" },
);
check(
  "existing blocks are left byte-identical",
  readFileSync(configPath, "utf-8").startsWith(original),
  true,
);
check("keepalives ride along", readFileSync(configPath, "utf-8").includes("ServerAliveInterval 30"), true);
check("a backup was taken", readdirSync(dir).some((f) => f.includes("openui-backup")), true);

const duplicate = appendSshConfigHost({ name: "existing", hostName: "2.2.2.2" }, configPath);
check("a duplicate alias is refused, not shadowed", [duplicate.ok, duplicate.reason], [false, "duplicate"]);

const spaced = appendSshConfigHost({ name: "bad name", hostName: "h" }, configPath);
check("an alias with spaces is refused", [spaced.ok, spaced.reason], [false, "invalid"]);

const globbed = appendSshConfigHost({ name: "gpu*", hostName: "h" }, configPath);
check("a globbed alias is refused", [globbed.ok, globbed.reason], [false, "invalid"]);

console.log("\nssh targets");

check(
  "an ssh-config box is addressed by alias alone, so the user's own settings apply",
  buildSshTarget({ id: "1", name: "dev", source: "ssh-config", inSshConfig: true }),
  ["dev"],
);
check(
  "a manual box builds explicit arguments",
  buildSshTarget({
    id: "2", name: "gpu", source: "manual", inSshConfig: false,
    host: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "/k/id",
  }),
  ["-p", "2222", "-i", "/k/id", "ubuntu@10.0.0.5"],
);
check(
  "port 22 and a missing user are left off",
  buildSshTarget({ id: "3", name: "g", source: "manual", inSshConfig: false, host: "h", port: 22 }),
  ["h"],
);

console.log("\nlaunch commands");

const alias = { id: "1", name: "dev", source: "ssh-config", inSshConfig: true };

check(
  "the agent runs under exec so quitting it ends the session",
  buildDevboxLaunchCommand(alias, "claude --yolo", "/home/ubuntu/repo"),
  "ssh 'dev' -t 'cd '\\''/home/ubuntu/repo'\\'' && exec claude --yolo'",
);
check(
  "no remote path means no cd",
  buildDevboxLaunchCommand(alias, "claude"),
  "ssh 'dev' -t 'exec claude'",
);
check(
  "no agent falls back to a login shell",
  buildDevboxLaunchCommand(alias, "", "/srv"),
  "ssh 'dev' -t 'cd '\\''/srv'\\'' && exec $SHELL -l'",
);
check(
  "a defaultPath is used when no path is passed",
  buildDevboxLaunchCommand({ ...alias, defaultPath: "/opt/work" }, "codex"),
  "ssh 'dev' -t 'cd '\\''/opt/work'\\'' && exec codex'",
);
check(
  "a quote in the remote path cannot break out of the command",
  buildDevboxLaunchCommand(alias, "claude", "/tmp/it's here; rm -rf /"),
  "ssh 'dev' -t 'cd '\\''/tmp/it'\\''\\'\\'''\\''s here; rm -rf /'\\'' && exec claude'",
);


console.log("\ninstrumented launch");
{
  const { buildDevboxLaunch } = await import(
    join(here, "..", "dist", "electron", "server", "services", "devboxes.js")
  );
  const manual = { id: "m", name: "gpu", source: "provisioned", inSshConfig: false, host: "h", user: "root", port: 2200, identityFile: "/k" };
  const plain = buildDevboxLaunch(manual, "claude", "/w");
  check("the first command is a bare ssh the shim can instrument", plain.launch, "ssh '-p' '2200' '-i' '/k' 'root@h'");
  check(
    "the remote command cds, sources the node env, fixes PATH and execs the agent with the remote plugin",
    plain.remote,
    "cd '/w' || exit 1; [ -f \"$HOME/.naught/env\" ] && . \"$HOME/.naught/env\"; export PATH=\"$HOME/.naught/bin:$HOME/.local/bin:$PATH\"; exec claude --plugin-dir \"$HOME/.naught/claude-code-plugin\"",
  );
  check("the legacy -t form is kept for the fallback", plain.legacy, "ssh '-p' '2200' '-i' '/k' 'root@h' -t 'cd '\\''/w'\\'' && exec claude'");
  const hooked = buildDevboxLaunch(manual, "codex --model o3", undefined, { hooks: { port: 43125, sessionId: "s-1" } });
  check(
    "hooks export the tunnel port and the session id; codex gets no plugin dir",
    hooked.remote,
    "[ -f \"$HOME/.naught/env\" ] && . \"$HOME/.naught/env\"; export PATH=\"$HOME/.naught/bin:$HOME/.local/bin:$PATH\"; export OPENUI_HOST=127.0.0.1 OPENUI_PORT=43125 OPENUI_SESSION_ID='s-1'; exec codex --model o3",
  );
  check("a shell session stays in the instrumented shell", buildDevboxLaunch(manual, "", "/w").remote.includes("exec"), false);
  check("an explicit --plugin-dir is respected", buildDevboxLaunch(manual, "claude --plugin-dir /x").remote.endsWith("exec claude --plugin-dir /x"), true);

  const { createRequire } = await import("module");
  const wrapper = createRequire(import.meta.url)(join(here, "..", "resources", "remote-terminal", "openui_ssh_wrapper.cjs"));
  check("parseAllocatedPort reads ssh's -R 0 report", wrapper.parseAllocatedPort("Warning: x\nAllocated port 43125 for remote forward to 127.0.0.1:6968\n"), 43125);
  check("parseAllocatedPort ignores other output", wrapper.parseAllocatedPort("Permission denied (publickey)."), null);
  check("a bare destination is instrumentable", wrapper.parseInteractiveInvocation(["dev"]).destination, "dev");
  check("a remote command is not", wrapper.parseInteractiveInvocation(["dev", "-t", "claude"]), null);
}

console.log("\nnested shims");
{
  const { stripShimDirectories } = await import(join(here, "..", "dist", "electron", "server", "services", "sessionManager.js"));
  check("shim directories from an outer session are dropped from PATH", stripShimDirectories("/Users/me/.openui-desktop/runtime-shell-shims/abc:/usr/local/bin:/usr/bin"), "/usr/local/bin:/usr/bin");
  check("ordinary PATH is untouched", stripShimDirectories("/opt/bin:/usr/bin"), "/opt/bin:/usr/bin");
  const { sshControlDirectoryPrefix } = await import(join(here, "..", "dist", "electron", "server", "services", "sessionManager.js"));
  const macPrefix = sshControlDirectoryPrefix("abcdef0123456789", "darwin", "/var/folders/6f/sc3qc_w131ldn15mcj6f1hk00000gn/T/");
  // mkdtemp adds 6 chars, then "/c-" + 16 hex, then ssh's 17-char temp suffix.
  check("a macOS control socket path stays under the 104-byte limit", macPrefix.startsWith("/tmp/nssh-") && macPrefix.length + 6 + 19 + 17 < 104, true);
  check("a short Linux tmpdir is kept", sshControlDirectoryPrefix("abcdef01", "linux", "/tmp").startsWith("/tmp/nssh-"), true);
}

console.log("\nnode tunnel host check");
{
  const { nodeTunnelRequest } = await import(join(here, "..", "dist", "electron", "server", "index.js"));
  const ports = new Set([43125]);
  check("status hooks through an allocated tunnel port are accepted", nodeTunnelRequest("127.0.0.1:43125", "/api/status-update", ports), true);
  check("the naught CLI's compute and move calls are accepted", [nodeTunnelRequest("127.0.0.1:43125", "/api/compute/nodes", ports), nodeTunnelRequest("127.0.0.1:43125", "/api/sessions/s-1/move/home", ports)], [true, true]);
  check("other endpoints through the tunnel are refused", nodeTunnelRequest("127.0.0.1:43125", "/api/sessions", ports), false);
  check("an unallocated port is refused", nodeTunnelRequest("127.0.0.1:9999", "/api/status-update", ports), false);
  check("a non-loopback host is refused", nodeTunnelRequest("evil.example:43125", "/api/status-update", ports), false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
