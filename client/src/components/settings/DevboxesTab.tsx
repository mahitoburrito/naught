import { useCallback, useEffect, useState } from "react";
import { Check, Cpu, FolderOpen, Loader2, Plus, Server, Trash2, X } from "lucide-react";
import { SectionHeader } from "./primitives";
import { canUseNativeDirectoryPicker, pickDirectoryNative } from "../../utils/nativeDirectoryPicker";
import { NewNodeForm } from "../compute/NewNodeForm";
import { agentStatusStyle } from "../../theme/agentStatus";
import type { AgentStatus } from "../../stores/useStore";
import { estimatedCost, formatUsd, formatUptime } from "../../types/compute";
import type { Devbox, ProvisionRecord, ProvisionStatus } from "../../types/compute";

export type { Devbox };

/** Statuses the list keeps polling for and that Terminate applies to. */
const LIVE_STATUSES: ProvisionStatus[] = ["pending", "provisioning", "ready", "terminating"];

/** Provision statuses borrow the agent-status palette so one colour means one thing app-wide. */
const PROVISION_STATUS_AGENT: Record<ProvisionStatus, AgentStatus> = {
  pending: "waiting_input",
  provisioning: "running",
  ready: "idle",
  terminating: "running",
  terminated: "disconnected",
  error: "error",
};

const PROVISION_STATUS_LABEL: Record<ProvisionStatus, string> = {
  pending: "Awaiting approval",
  provisioning: "Provisioning",
  ready: "Ready",
  terminating: "Terminating",
  terminated: "Terminated",
  error: "Error",
};

const POLL_MS = 5_000;

interface DiscoveredHost {
  name: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  alreadyAdded: boolean;
}

interface TestState {
  status: "idle" | "running" | "ok" | "fail";
  message?: string;
  detail?: string;
}

const inputClass =
  "w-full px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors";

export function DevboxesTab() {
  const [devboxes, setDevboxes] = useState<Devbox[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [sshConfigPath, setSshConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/devboxes");
      const data = await res.json();
      setDevboxes(data.devboxes || []);
      setDiscovered(data.discovered || []);
      setSshConfigPath(data.sshConfigPath || "");
    } catch {
      setNotice("Could not load devboxes.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Provisioned nodes change state on their own (provider, bootstrap, the
  // lifetime cap), so the list re-reads itself while the tab is open.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runTest = async (id: string) => {
    setTests((current) => ({ ...current, [id]: { status: "running" } }));
    try {
      const res = await fetch(`/api/devboxes/${id}/test`, { method: "POST" });
      const data = await res.json();
      setTests((current) => ({
        ...current,
        [id]: { status: data.ok ? "ok" : "fail", message: data.message, detail: data.detail },
      }));
    } catch {
      setTests((current) => ({ ...current, [id]: { status: "fail", message: "Test failed to run" } }));
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/devboxes/${id}`, { method: "DELETE" });
    refresh();
  };

  const promote = async (host: DiscoveredHost) => {
    await fetch("/api/devboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: host.name, source: "ssh-config", inSshConfig: true }),
    });
    refresh();
  };

  return (
    <>
      <SectionHeader title="Devboxes" />
      <div className="rounded-lg border border-border bg-canvas/40">
        {loading ? (
          <div className="px-4 py-6 text-xs text-zinc-500">Loading…</div>
        ) : devboxes.length === 0 && !adding ? (
          <div className="px-4 py-6 text-center">
            <Server className="mx-auto mb-2 h-5 w-5 text-zinc-600" />
            <div className="text-sm text-zinc-300">No devboxes yet</div>
            <div className="mt-1 text-xs text-zinc-500">
              Add a remote machine and you can run sessions on it.
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {devboxes.map((devbox) =>
              devbox.source === "provisioned" && devbox.provision ? (
                <ProvisionedRow
                  key={devbox.id}
                  devbox={devbox}
                  provision={devbox.provision}
                  now={now}
                  test={tests[devbox.id]}
                  onTest={() => runTest(devbox.id)}
                  onRemove={() => remove(devbox.id)}
                />
              ) : (
                <DevboxRow
                  key={devbox.id}
                  devbox={devbox}
                  test={tests[devbox.id]}
                  onTest={() => runTest(devbox.id)}
                  onRemove={() => remove(devbox.id)}
                />
              ),
            )}
          </div>
        )}
      </div>

      {provisioning ? (
        <NewNodeForm
          onCancel={() => setProvisioning(false)}
          onCreated={() => {
            setProvisioning(false);
            setNotice(null);
            refresh();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => { setNotice(null); setAdding(false); setProvisioning(true); }}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-surface-active hover:text-white"
        >
          <Cpu className="h-3.5 w-3.5" />
          Provision a node
        </button>
      )}

      {adding ? (
        <AddDevboxForm
          onCancel={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false);
            setNotice(message);
            refresh();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => { setNotice(null); setProvisioning(false); setAdding(true); }}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-surface-active hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          Add devbox
        </button>
      )}

      {notice && <div className="mt-2 text-[11px] text-amber-400">{notice}</div>}

      <SectionHeader title="Found in ssh config" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-2 text-[11px] text-zinc-600">
          {sshConfigPath || "~/.ssh/config"}
        </div>
        {discovered.length === 0 ? (
          <div className="px-4 pb-3 text-xs text-zinc-500">
            No hosts found. Anything you add above with “also add to ssh config” shows up here.
          </div>
        ) : (
          <div className="max-h-48 divide-y divide-border overflow-y-auto border-t border-border">
            {discovered.map((host) => (
              <div key={host.name} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-200">{host.name}</div>
                  <div className="truncate text-[11px] text-zinc-600">
                    {[host.user && `${host.user}@`, host.hostName, host.port && `:${host.port}`]
                      .filter(Boolean)
                      .join("") || "no HostName set"}
                  </div>
                </div>
                {host.alreadyAdded ? (
                  <span className="flex-shrink-0 text-[11px] text-zinc-600">Added</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => promote(host)}
                    className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-white hover:bg-surface-active"
                  >
                    Add as devbox
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function DevboxRow({
  devbox,
  test,
  onTest,
  onRemove,
}: {
  devbox: Devbox;
  test?: TestState;
  onTest: () => void;
  onRemove: () => void;
}) {
  const subtitle = devbox.inSshConfig
    ? `ssh ${devbox.name}`
    : [devbox.user && `${devbox.user}@`, devbox.host, devbox.port && devbox.port !== 22 && `:${devbox.port}`]
        .filter(Boolean)
        .join("");

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-zinc-200">{devbox.name}</span>
          {devbox.inSshConfig && (
            <span className="flex-shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-zinc-600">
              ssh config
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-zinc-600">{subtitle}</div>
        {devbox.defaultPath && (
          <div className="truncate font-mono text-[11px] text-zinc-600">{devbox.defaultPath}</div>
        )}
        {test && test.status !== "idle" && (
          <div
            className={`mt-1 text-[11px] ${
              test.status === "ok" ? "text-emerald-400" : test.status === "fail" ? "text-red-400" : "text-zinc-500"
            }`}
          >
            {test.status === "running" ? "Testing…" : test.message}
            {test.detail && <span className="text-zinc-600"> — {test.detail}</span>}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onTest}
        disabled={test?.status === "running"}
        className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-white hover:bg-surface-active disabled:opacity-50"
      >
        {test?.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${devbox.name}`}
        className="flex-shrink-0 rounded-md p-1 text-zinc-600 transition-colors hover:bg-surface-active hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ProvisionedRow({
  devbox,
  provision,
  now,
  test,
  onTest,
  onRemove,
}: {
  devbox: Devbox;
  provision: ProvisionRecord;
  now: number;
  test?: TestState;
  onTest: () => void;
  onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState(false);
  const live = LIVE_STATUSES.includes(provision.status);
  const style = agentStatusStyle(PROVISION_STATUS_AGENT[provision.status]);
  const spec = [
    provision.gpu ? `${provision.gpuCount > 1 ? `${provision.gpuCount}× ` : ""}${provision.gpu}` : "CPU",
    `${provision.cpu} vCPU`,
    `${provision.memoryGb} GB`,
  ].join(" · ");
  const sshTarget = devbox.host
    ? `${devbox.user ? `${devbox.user}@` : ""}${devbox.host}${devbox.port ? `:${devbox.port}` : ""}`
    : null;

  // Terminating is final for both providers (neither has a stop API), so the
  // first click only arms the button and the second one acts.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const act = async () => {
    setActing(true);
    try {
      await onRemove();
    } finally {
      setActing(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-zinc-200">{devbox.name}</span>
          <span className="flex-shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-zinc-500">
            {provision.provider}
          </span>
          <span
            className="flex-shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
            style={{ color: style.color, backgroundColor: style.bg, border: `1px solid ${style.border}` }}
          >
            {PROVISION_STATUS_LABEL[provision.status]}
          </span>
        </div>
        <div className="truncate text-[11px] text-zinc-500">{spec}</div>
        {provision.startedAt && (
          <div className="text-[11px] text-zinc-500">
            {provision.status === "terminated" ? "Ran " : "Up "}
            {formatUptime((provision.terminatedAt ?? now) - provision.startedAt)}
            <span className="text-zinc-600"> · {formatUsd(estimatedCost(provision, now))} est.</span>
            {provision.status !== "terminated" && (
              <span className="text-zinc-600"> at {formatUsd(provision.hourlyUsd)}/hr</span>
            )}
          </div>
        )}
        {!provision.startedAt && provision.hourlyUsd > 0 && provision.status !== "terminated" && (
          <div className="text-[11px] text-zinc-600">{formatUsd(provision.hourlyUsd)}/hr est. once it starts</div>
        )}
        {provision.status === "pending" && provision.reasons && provision.reasons.length > 0 && (
          <div className="mt-0.5 text-[11px] text-amber-400">{provision.reasons.join(" · ")}</div>
        )}
        {provision.error && <div className="mt-0.5 text-[11px] text-red-400">{provision.error}</div>}
        {sshTarget && <div className="truncate font-mono text-[11px] text-zinc-600">{sshTarget}</div>}
        {devbox.defaultPath && (
          <div className="truncate font-mono text-[11px] text-zinc-600">{devbox.defaultPath}</div>
        )}
        {test && test.status !== "idle" && (
          <div
            className={`mt-1 text-[11px] ${
              test.status === "ok" ? "text-emerald-400" : test.status === "fail" ? "text-red-400" : "text-zinc-500"
            }`}
          >
            {test.status === "running" ? "Testing…" : test.message}
            {test.detail && <span className="text-zinc-600"> — {test.detail}</span>}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onTest}
        disabled={test?.status === "running" || !sshTarget}
        className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-white hover:bg-surface-active disabled:opacity-50"
      >
        {test?.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
      </button>
      {live ? (
        confirming ? (
          <>
            <button
              type="button"
              onClick={act}
              disabled={acting}
              aria-label={provision.status === "pending" ? `Confirm withdrawing ${devbox.name}` : `Confirm terminating ${devbox.name}`}
              className="flex-shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200 disabled:opacity-50"
            >
              {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : provision.status === "pending" ? "Withdraw?" : "Terminate?"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={acting}
              className="flex-shrink-0 rounded-md px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:text-white"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={provision.status === "terminating"}
            aria-label={`Terminate ${devbox.name}`}
            className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
          >
            {provision.status === "pending" ? "Withdraw" : "Terminate"}
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={act}
          disabled={acting}
          aria-label={`Remove ${devbox.name}`}
          className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-white hover:bg-surface-active disabled:opacity-50"
        >
          {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Remove"}
        </button>
      )}
    </div>
  );
}

function AddDevboxForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (notice: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [defaultPath, setDefaultPath] = useState("");
  const [writeToSshConfig, setWriteToSshConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && host.trim().length > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/devboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          source: "manual",
          host: host.trim(),
          user: user.trim() || undefined,
          port: port.trim() ? Number(port) : undefined,
          identityFile: identityFile.trim() || undefined,
          defaultPath: defaultPath.trim() || undefined,
          writeToSshConfig,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not save devbox.");
        setSaving(false);
        return;
      }
      // The devbox is saved either way; an ssh config write that did not happen
      // is worth saying out loud rather than failing the save.
      onSaved(
        data.sshConfig && !data.sshConfig.written
          ? `Saved, but ~/.ssh/config was not updated: ${data.sshConfig.message}`
          : null,
      );
    } catch (e: any) {
      setError(e?.message || "Could not save devbox.");
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-border bg-canvas/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-zinc-200">New devbox</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-surface-active hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-1 space-y-1">
          <span className="text-[11px] text-zinc-500">Name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="gpu-box" />
        </label>
        <label className="col-span-1 space-y-1">
          <span className="text-[11px] text-zinc-500">Host</span>
          <input className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" />
        </label>
        <label className="col-span-1 space-y-1">
          <span className="text-[11px] text-zinc-500">User</span>
          <input className={inputClass} value={user} onChange={(e) => setUser(e.target.value)} placeholder="ubuntu" />
        </label>
        <label className="col-span-1 space-y-1">
          <span className="text-[11px] text-zinc-500">Port</span>
          <input className={inputClass} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" />
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-[11px] text-zinc-500">Identity file</span>
          <div className="flex gap-2">
            <input
              className={`${inputClass} font-mono`}
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
            />
            {canUseNativeDirectoryPicker() && (
              <button
                type="button"
                onClick={async () => {
                  const picked = await pickDirectoryNative(identityFile || undefined);
                  if (picked) setIdentityFile(picked);
                }}
                aria-label="Choose key directory"
                title="Choose key directory"
                className="flex-shrink-0 rounded-md border border-border bg-canvas px-2.5 py-1.5 text-zinc-400 transition-colors hover:bg-surface-active hover:text-white"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-[11px] text-zinc-500">Default remote directory</span>
          <input
            className={`${inputClass} font-mono`}
            value={defaultPath}
            onChange={(e) => setDefaultPath(e.target.value)}
            placeholder="/home/ubuntu/repo"
          />
        </label>
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={writeToSshConfig}
          onChange={(e) => setWriteToSshConfig(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-[11px] text-zinc-400">
          Also add to <span className="font-mono">~/.ssh/config</span>
          <span className="block text-zinc-600">
            Appends a Host block with keepalives, so <span className="font-mono">ssh {name.trim() || "name"}</span> works
            in your terminal too. Existing entries are never changed, and a backup is taken first.
          </span>
        </span>
      </label>

      {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-canvas hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </div>
  );
}
