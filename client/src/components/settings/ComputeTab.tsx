import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { SectionHeader, Toggle } from "./primitives";
import type { ComputeNotifications, ComputeOffer, ComputePolicy, ProviderId, ProviderInfo } from "../../types/compute";

/* Settings → Compute. Every field saves on its own (blur, Enter, or the
   section's Save button); the modal footer shows Done, never Save, so the
   inline status text is the only place a save reports back. */

const inputClass =
  "w-full px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors";
const buttonClass =
  "flex-shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-surface-active hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
const removeButtonClass =
  "flex-shrink-0 rounded-md px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50";

const SECRET_PLACEHOLDER = "••••••••";

const PROVIDER_LABEL: Record<ProviderId, string> = { modal: "Modal", thunder: "Thunder Compute" };
const PROVIDER_FILE: Record<ProviderId, string> = { modal: "~/.modal.toml", thunder: "~/.thunder/token" };

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : "";
    throw new Error(message || `Request failed (${res.status})`);
  }
  return data as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

/** "Saved" fades back to idle on its own; errors stay until the next attempt. */
function useSaveStatus(): [SaveStatus, (next: SaveStatus) => void] {
  const [status, setStatusState] = useState<SaveStatus>({ kind: "idle" });
  const timer = useRef<number | null>(null);
  const setStatus = useCallback((next: SaveStatus) => {
    if (timer.current) window.clearTimeout(timer.current);
    setStatusState(next);
    if (next.kind === "saved") {
      timer.current = window.setTimeout(() => setStatusState({ kind: "idle" }), 2500);
    }
  }, []);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return [status, setStatus];
}

function StatusText({ status }: { status: SaveStatus }) {
  if (status.kind === "idle") return null;
  const cls = status.kind === "error" ? "text-red-400" : status.kind === "saved" ? "text-emerald-400" : "text-zinc-500";
  return (
    <span role="status" className={`text-[11px] ${cls}`}>
      {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : status.message}
    </span>
  );
}

/** A text or number input that commits on blur or Enter, only when the value changed. */
function CommitField({
  id,
  label,
  value,
  onCommit,
  type = "text",
  placeholder,
  suffix,
  min,
  step,
  mono,
  description,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  type?: "text" | "number" | "email";
  placeholder?: string;
  suffix?: string;
  min?: number;
  step?: number;
  mono?: boolean;
  description?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") setDraft(value);
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[11px] text-zinc-500">{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={type}
          value={draft}
          min={min}
          step={step}
          inputMode={type === "number" ? "decimal" : undefined}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          className={`${inputClass} ${mono ? "font-mono" : ""} ${type === "number" ? "max-w-[120px]" : ""}`}
        />
        {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      </div>
      {description && <div className="text-[11px] text-zinc-600">{description}</div>}
    </div>
  );
}

/** A password input that never shows the stored value; a stored secret is a placeholder, not text. */
function SecretInput({
  id,
  label,
  value,
  onChange,
  stored,
  placeholder,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  stored: boolean;
  placeholder?: string;
  onEnter?: () => void;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-[11px] text-zinc-500">
        {label}
        {stored && (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1 text-[9px] uppercase tracking-wide text-emerald-400">
            set
          </span>
        )}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); } }}
        placeholder={stored ? SECRET_PLACEHOLDER : placeholder}
        className={`${inputClass} font-mono`}
      />
    </div>
  );
}

function parsePositive(raw: string, label: string, integer = false): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${label} must be a ${integer ? "whole " : ""}number above 0.`);
  }
  return n;
}

function parseNonNegative(raw: string, label: string, integer = false): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${label} must be a ${integer ? "whole " : ""}number of 0 or more.`);
  }
  return n;
}

export function ComputeTab() {
  return (
    <>
      <ProvidersSection />
      <PolicySection />
      <NotificationsSection />
      <NodeCredentialsSection />
    </>
  );
}

/* ─── Providers ───────────────────────────────────────────────────────────── */

function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<{ providers: ProviderInfo[] }>("/api/compute/providers")
      .then((data) => { if (!cancelled) setProviders(data.providers); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, []);

  const replace = (next: ProviderInfo) =>
    setProviders((current) => (current ?? []).map((p) => (p.id === next.id ? next : p)));

  return (
    <>
      <SectionHeader title="Providers" />
      <div className="rounded-lg border border-border bg-canvas/40">
        {loadError ? (
          <div className="px-4 py-3 text-xs text-red-400">Could not load providers: {loadError}</div>
        ) : providers === null ? (
          <div className="px-4 py-3 text-xs text-zinc-500">Loading…</div>
        ) : (
          <div className="divide-y divide-border">
            {providers.map((info) => (
              <ProviderRow key={info.id} info={info} onChange={replace} />
            ))}
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-600">
        Keys stay on this Mac. A key set here wins over the environment and over the provider's own config file.
      </p>
    </>
  );
}

function providerStatusLine(info: ProviderInfo): { text: string; tone: "ok" | "warn" } {
  if (!info.ok) return { text: info.detail || "Not configured", tone: "warn" };
  const from =
    info.source === "naught"
      ? "set in Naught"
      : info.source === "env"
        ? "from environment"
        : `from ${PROVIDER_FILE[info.id]}`;
  return { text: `Configured · ${from}`, tone: "ok" };
}

function ProviderRow({ info, onChange }: { info: ProviderInfo; onChange: (next: ProviderInfo) => void }) {
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useSaveStatus();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const canSave = info.id === "modal" ? tokenId.trim() && tokenSecret.trim() : token.trim();
  const line = providerStatusLine(info);

  const save = async () => {
    if (!canSave) return;
    setStatus({ kind: "saving" });
    setTestResult(null);
    try {
      const body = info.id === "modal" ? { tokenId: tokenId.trim(), tokenSecret: tokenSecret.trim() } : { token: token.trim() };
      const data = await requestJson<{ provider: ProviderInfo }>(`/api/compute/providers/${info.id}/key`, jsonInit("PUT", body));
      onChange(data.provider);
      setTokenId("");
      setTokenSecret("");
      setToken("");
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const remove = async () => {
    setStatus({ kind: "saving" });
    setTestResult(null);
    try {
      const data = await requestJson<{ provider: ProviderInfo }>(`/api/compute/providers/${info.id}/key`, { method: "DELETE" });
      onChange(data.provider);
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await requestJson<{ ok: boolean; message: string }>(`/api/compute/providers/${info.id}/test`, { method: "POST" });
      setTestResult(data);
    } catch (error) {
      setTestResult({ ok: false, message: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-zinc-200">{PROVIDER_LABEL[info.id]}</div>
          <div className={`mt-0.5 text-[11px] ${line.tone === "ok" ? "text-zinc-500" : "text-amber-400"}`}>{line.text}</div>
        </div>
        <StatusText status={status} />
      </div>

      <div className="mt-2 flex items-end gap-2">
        {info.id === "modal" ? (
          <>
            <SecretInput
              id="compute-modal-token-id"
              label="Token id"
              value={tokenId}
              onChange={setTokenId}
              stored={info.storedInNaught}
              placeholder="ak-…"
              onEnter={save}
            />
            <SecretInput
              id="compute-modal-token-secret"
              label="Token secret"
              value={tokenSecret}
              onChange={setTokenSecret}
              stored={info.storedInNaught}
              placeholder="as-…"
              onEnter={save}
            />
          </>
        ) : (
          <SecretInput
            id="compute-thunder-token"
            label="API token"
            value={token}
            onChange={setToken}
            stored={info.storedInNaught}
            placeholder="Thunder Compute API token"
            onEnter={save}
          />
        )}
        <button type="button" onClick={save} disabled={!canSave || status.kind === "saving"} className={buttonClass}>
          Save
        </button>
        <button
          type="button"
          onClick={test}
          disabled={testing || !info.ok}
          className={buttonClass}
          aria-label={`Test ${PROVIDER_LABEL[info.id]} connection`}
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
        </button>
        {info.storedInNaught && (
          <button
            type="button"
            onClick={remove}
            disabled={status.kind === "saving"}
            className={removeButtonClass}
            aria-label={`Remove the ${PROVIDER_LABEL[info.id]} key stored in Naught`}
          >
            Remove
          </button>
        )}
      </div>

      {testResult && (
        <div role="status" className={`mt-1.5 text-[11px] ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}

/* ─── Policy ──────────────────────────────────────────────────────────────── */

function PolicySection() {
  const [policy, setPolicy] = useState<ComputePolicy | null>(null);
  const [gpusFromOffers, setGpusFromOffers] = useState<string[]>([]);
  const [offersLoaded, setOffersLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useSaveStatus();

  useEffect(() => {
    let cancelled = false;
    requestJson<{ policy: ComputePolicy }>("/api/compute/policy")
      .then((data) => { if (!cancelled) setPolicy(data.policy); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    requestJson<{ offers: ComputeOffer[] }>("/api/compute/offers")
      .then((data) => {
        if (cancelled) return;
        const distinct = Array.from(new Set(data.offers.map((o) => o.gpu).filter((g): g is string => !!g)));
        setGpusFromOffers(distinct);
      })
      .catch(() => { /* no configured provider: the list below says so */ })
      .finally(() => { if (!cancelled) setOffersLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // Every GPU class we know about: what the providers offer today, plus anything
  // already allowed (so a saved choice never silently disappears from the list).
  const gpus = useMemo(() => {
    const allowed = policy && policy.allowedGpus !== "any" ? policy.allowedGpus : [];
    return Array.from(new Set([...gpusFromOffers, ...allowed]));
  }, [gpusFromOffers, policy]);

  const save = async (patch: Partial<ComputePolicy>) => {
    setStatus({ kind: "saving" });
    try {
      const data = await requestJson<{ policy: ComputePolicy }>("/api/compute/policy", jsonInit("PUT", patch));
      setPolicy(data.policy);
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const commitNumber = (key: "maxConcurrentNodes" | "maxLifetimeHours" | "maxHourlyUsd", label: string, integer: boolean) =>
    (raw: string) => {
      try {
        void save({ [key]: parsePositive(raw, label, integer) });
      } catch (error) {
        setStatus({ kind: "error", message: errorMessage(error) });
      }
    };

  const anyGpu = policy?.allowedGpus === "any";
  const allowedList = policy && policy.allowedGpus !== "any" ? policy.allowedGpus : [];

  const toggleGpu = (gpu: string, checked: boolean) => {
    const next = checked ? Array.from(new Set([...allowedList, gpu])) : allowedList.filter((g) => g !== gpu);
    void save({ allowedGpus: next });
  };

  return (
    <>
      <SectionHeader title="Policy" />
      <div className="rounded-lg border border-border bg-canvas/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-zinc-500">
            Requests inside these caps start immediately; anything above waits for your approval.
          </p>
          <StatusText status={status} />
        </div>

        {loadError ? (
          <div className="mt-3 text-xs text-red-400">Could not load the policy: {loadError}</div>
        ) : !policy ? (
          <div className="mt-3 text-xs text-zinc-500">Loading…</div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <CommitField
                id="compute-policy-max-nodes"
                label="Max concurrent nodes"
                type="number"
                min={1}
                step={1}
                value={String(policy.maxConcurrentNodes)}
                onCommit={commitNumber("maxConcurrentNodes", "Max concurrent nodes", true)}
              />
              <CommitField
                id="compute-policy-max-lifetime"
                label="Auto-terminate after"
                type="number"
                min={0.25}
                step={0.5}
                suffix="h"
                value={String(policy.maxLifetimeHours)}
                onCommit={commitNumber("maxLifetimeHours", "Auto-terminate after", false)}
              />
              <CommitField
                id="compute-policy-max-hourly"
                label="Max $/hr per node"
                type="number"
                min={0.01}
                step={0.5}
                suffix="$/hr"
                value={String(policy.maxHourlyUsd)}
                onCommit={commitNumber("maxHourlyUsd", "Max $/hr per node", false)}
              />
            </div>

            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm text-zinc-200">Allowed GPUs</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {anyGpu ? "Any GPU class a provider offers." : "Only the classes ticked below start without approval."}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  Any GPU
                  <Toggle
                    checked={!!anyGpu}
                    onChange={(checked) => void save({ allowedGpus: checked ? "any" : gpus })}
                  />
                </label>
              </div>

              {!anyGpu && (
                gpus.length === 0 ? (
                  <div className="mt-2 text-[11px] text-amber-400">
                    {offersLoaded
                      ? "No GPU classes to choose from until a provider is configured above."
                      : "Loading GPU classes…"}
                  </div>
                ) : (
                  <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1.5">
                    {gpus.map((gpu) => (
                      <label key={gpu} className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="checkbox"
                          checked={allowedList.includes(gpu)}
                          onChange={(e) => toggleGpu(gpu, e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-zinc-600 bg-canvas text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                        />
                        <span className="font-mono">{gpu}</span>
                        {!gpusFromOffers.includes(gpu) && offersLoaded && (
                          <span className="text-[10px] text-zinc-600">not offered now</span>
                        )}
                      </label>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Notifications ───────────────────────────────────────────────────────── */

interface NotificationsView {
  notifications: ComputeNotifications;
  hasResendKey: boolean;
}

function NotificationsSection() {
  const [view, setView] = useState<NotificationsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useSaveStatus();
  const [resendKey, setResendKey] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<NotificationsView>("/api/compute/notifications")
      .then((data) => { if (!cancelled) setView(data); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, []);

  const save = async (body: Partial<ComputeNotifications> & { resendApiKey?: string }) => {
    setStatus({ kind: "saving" });
    try {
      const data = await requestJson<NotificationsView>("/api/compute/notifications", jsonInit("PUT", body));
      setView(data);
      setStatus({ kind: "saved" });
      return true;
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
      return false;
    }
  };

  const saveKey = async () => {
    if (!resendKey.trim()) return;
    if (await save({ resendApiKey: resendKey.trim() })) setResendKey("");
  };

  const commitNumber = (key: "reminderHours" | "idleAlertMinutes", label: string) => (raw: string) => {
    try {
      void save({ [key]: parseNonNegative(raw, label, key === "idleAlertMinutes") });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const sendTest = async () => {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/compute/notifications/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { sent?: boolean; skipped?: string; error?: string };
      if (data.sent) setSendResult({ ok: true, text: "Sent" });
      else if (data.skipped === "no-recipient") setSendResult({ ok: false, text: "Skipped: no recipient" });
      else if (data.skipped === "no-api-key") setSendResult({ ok: false, text: "Skipped: no API key" });
      else setSendResult({ ok: false, text: data.error || `Not sent (${res.status})` });
    } catch (error) {
      setSendResult({ ok: false, text: errorMessage(error) });
    } finally {
      setSending(false);
    }
  };

  const n = view?.notifications;

  return (
    <>
      <SectionHeader title="Notifications" />
      <div className="rounded-lg border border-border bg-canvas/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-zinc-500">
            Email when a node starts billing, on a schedule while it stays up, when it sits idle, and when it ends.
          </p>
          <StatusText status={status} />
        </div>

        {loadError ? (
          <div className="mt-3 text-xs text-red-400">Could not load notification settings: {loadError}</div>
        ) : !view || !n ? (
          <div className="mt-3 text-xs text-zinc-500">Loading…</div>
        ) : (
          <div className="mt-3 space-y-3">
            {!n.to && (
              <div role="alert" className="text-xs text-red-400">
                No recipient: billing emails are off until you set one.
              </div>
            )}

            <div className="flex items-end gap-2">
              <SecretInput
                id="compute-resend-key"
                label="Resend API key"
                value={resendKey}
                onChange={setResendKey}
                stored={view.hasResendKey}
                placeholder="re_…"
                onEnter={saveKey}
              />
              <button type="button" onClick={saveKey} disabled={!resendKey.trim() || status.kind === "saving"} className={buttonClass}>
                Save
              </button>
              {view.hasResendKey && (
                <button
                  type="button"
                  onClick={() => void save({ resendApiKey: "" })}
                  disabled={status.kind === "saving"}
                  className={removeButtonClass}
                  aria-label="Remove the Resend API key"
                >
                  Remove
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <CommitField
                id="compute-notify-to"
                label="To"
                type="email"
                placeholder="you@example.com"
                value={n.to ?? ""}
                onCommit={(raw) => void save({ to: raw.trim() })}
              />
              <CommitField
                id="compute-notify-from"
                label="From"
                placeholder="Naught <naught@example.com>"
                value={n.from}
                onCommit={(raw) => void save({ from: raw.trim() })}
                description="The domain must be verified on your Resend account."
              />
              <CommitField
                id="compute-notify-reminder"
                label="Reminder every"
                type="number"
                min={0}
                step={0.5}
                suffix="h"
                value={String(n.reminderHours)}
                onCommit={commitNumber("reminderHours", "Reminder interval")}
                description="0 turns reminders off."
              />
              <CommitField
                id="compute-notify-idle"
                label="Idle alert after"
                type="number"
                min={0}
                step={5}
                suffix="min"
                value={String(n.idleAlertMinutes)}
                onCommit={commitNumber("idleAlertMinutes", "Idle alert")}
                description="No PTY input or output on any attached session."
              />
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-3">
              <button type="button" onClick={sendTest} disabled={sending} className={buttonClass}>
                {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Send test email"}
              </button>
              {sendResult && (
                <span role="status" className={`text-[11px] ${sendResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {sendResult.text}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Node credentials ────────────────────────────────────────────────────── */

interface CredentialsView {
  hasClaudeToken: boolean;
  hasOpenAiKey: boolean;
  syncCodexAuth: boolean;
}

function NodeCredentialsSection() {
  const [view, setView] = useState<CredentialsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useSaveStatus();
  const [claudeToken, setClaudeToken] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    requestJson<CredentialsView>("/api/compute/node-credentials")
      .then((data) => { if (!cancelled) setView(data); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, []);

  const save = async (body: { claudeToken?: string; openAiKey?: string; syncCodexAuth?: boolean }) => {
    setStatus({ kind: "saving" });
    try {
      const data = await requestJson<CredentialsView>("/api/compute/node-credentials", jsonInit("PUT", body));
      setView(data);
      setStatus({ kind: "saved" });
      return true;
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
      return false;
    }
  };

  const saveClaude = async () => {
    if (!claudeToken.trim()) return;
    if (await save({ claudeToken: claudeToken.trim() })) setClaudeToken("");
  };
  const saveOpenAi = async () => {
    if (!openAiKey.trim()) return;
    if (await save({ openAiKey: openAiKey.trim() })) setOpenAiKey("");
  };

  return (
    <>
      <SectionHeader title="Node credentials" />
      <div className="rounded-lg border border-border bg-canvas/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-zinc-500">
            Copied to each node so the agents there can sign in. Nodes cannot read this Mac's keychain, which is why these exist.
          </p>
          <StatusText status={status} />
        </div>

        {loadError ? (
          <div className="mt-3 text-xs text-red-400">Could not load node credentials: {loadError}</div>
        ) : !view ? (
          <div className="mt-3 text-xs text-zinc-500">Loading…</div>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <div className="flex items-end gap-2">
                <SecretInput
                  id="compute-claude-token"
                  label="Claude token"
                  value={claudeToken}
                  onChange={setClaudeToken}
                  stored={view.hasClaudeToken}
                  placeholder="sk-ant-oat01-…"
                  onEnter={saveClaude}
                />
                <button type="button" onClick={saveClaude} disabled={!claudeToken.trim() || status.kind === "saving"} className={buttonClass}>
                  Save
                </button>
                {view.hasClaudeToken && (
                  <button
                    type="button"
                    onClick={() => void save({ claudeToken: "" })}
                    disabled={status.kind === "saving"}
                    className={removeButtonClass}
                    aria-label="Remove the Claude token"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-1 text-[11px] text-zinc-600">
                Run <span className="font-mono">claude setup-token</span> and paste the result. Nodes cannot read this Mac's keychain.
              </div>
            </div>

            <div className="flex items-end gap-2">
              <SecretInput
                id="compute-openai-key"
                label="OpenAI key"
                value={openAiKey}
                onChange={setOpenAiKey}
                stored={view.hasOpenAiKey}
                placeholder="sk-…"
                onEnter={saveOpenAi}
              />
              <button type="button" onClick={saveOpenAi} disabled={!openAiKey.trim() || status.kind === "saving"} className={buttonClass}>
                Save
              </button>
              {view.hasOpenAiKey && (
                <button
                  type="button"
                  onClick={() => void save({ openAiKey: "" })}
                  disabled={status.kind === "saving"}
                  className={removeButtonClass}
                  aria-label="Remove the OpenAI key"
                >
                  Remove
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <div>
                <div className="text-sm text-zinc-200">
                  Copy <span className="font-mono text-xs">~/.codex/auth.json</span> to nodes
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">Lets Codex on a node reuse this Mac's sign-in instead of an API key.</div>
              </div>
              <Toggle checked={view.syncCodexAuth} onChange={(checked) => void save({ syncCodexAuth: checked })} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
