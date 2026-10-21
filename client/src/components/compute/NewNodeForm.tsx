import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { formatUsd } from "../../types/compute";
import type { ComputeOffer, NodeRequest, ProviderId, ProviderInfo, ProvisionedNode } from "../../types/compute";

/* The one form that asks a provider for a node. It lives in two places:
   Settings → Devboxes (full: header, Create and Cancel) and the new-session
   modal (compact: no buttons, the modal's own primary button provisions and
   reads the request through onSpecChange). */

export type CreateNodeResult =
  | { ok: true; node: ProvisionedNode; pending: boolean; reasons: string[] }
  | { ok: false; error: string };

/** POST /api/compute/nodes. 201 starts provisioning, 202 parks the request for approval. */
export async function createNode(spec: NodeRequest): Promise<CreateNodeResult> {
  try {
    const res = await fetch("/api/compute/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...spec, requestedBy: { kind: "user" } }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      node?: ProvisionedNode;
      pending?: boolean;
      reasons?: string[];
      error?: string;
    };
    if (!res.ok || !data.node) return { ok: false, error: data.error || `Could not request a node (${res.status}).` };
    return { ok: true, node: data.node, pending: res.status === 202 || !!data.pending, reasons: data.reasons ?? [] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reach Naught." };
  }
}

const PROVIDER_LABEL: Record<ProviderId, string> = { modal: "Modal", thunder: "Thunder Compute" };

const inputClass =
  "w-full px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors";
const selectClass =
  "w-full px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-50";

export function offerKey(offer: ComputeOffer): string {
  return [offer.provider, offer.gpu ?? "cpu", offer.gpuCount, offer.cpu, offer.memoryGb, offer.diskGb ?? "", offer.image ?? "", offer.label].join("|");
}

export function defaultNodeName(provider: ProviderId, gpu?: string): string {
  const label = gpu ? gpu.toLowerCase().replace(/[^a-z0-9]+/g, "") : "cpu";
  return `${provider}-${label}`;
}

interface NewNodeFormProps {
  onCreated: (node: ProvisionedNode, pending: boolean) => void;
  onCancel: () => void;
  /** No header or buttons; the host owns Create and reads the request through onSpecChange. */
  compact?: boolean;
  /** The current request, or null while the form cannot produce one. */
  onSpecChange?: (spec: NodeRequest | null) => void;
}

export function NewNodeForm({ onCreated, onCancel, compact = false, onSpecChange }: NewNodeFormProps) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [offers, setOffers] = useState<ComputeOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [selectedOffer, setSelectedOffer] = useState("");
  const [gpuCount, setGpuCount] = useState(1);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parkedReasons, setParkedReasons] = useState<string[] | null>(null);

  const configured = useMemo(() => (providers ?? []).filter((p) => p.ok), [providers]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/compute/providers")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { providers?: ProviderInfo[]; error?: string };
        if (!res.ok) throw new Error(data.error || `Could not load providers (${res.status}).`);
        return data.providers ?? [];
      })
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        const first = list.find((p) => p.ok);
        if (first) setProvider(first.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProvidersError(err instanceof Error ? err.message : "Could not load providers.");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!provider) {
      setOffers([]);
      setSelectedOffer("");
      return;
    }
    let cancelled = false;
    setOffersLoading(true);
    setOffersError(null);
    fetch(`/api/compute/offers?provider=${encodeURIComponent(provider)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { offers?: ComputeOffer[]; error?: string };
        if (!res.ok) throw new Error(data.error || `Could not load offers (${res.status}).`);
        return data.offers ?? [];
      })
      .then((list) => {
        if (cancelled) return;
        setOffers(list);
        const first = list.find((o) => o.available !== false) ?? list[0];
        setSelectedOffer(first ? offerKey(first) : "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOffers([]);
        setSelectedOffer("");
        setOffersError(err instanceof Error ? err.message : "Could not load offers.");
      })
      .finally(() => { if (!cancelled) setOffersLoading(false); });
    return () => { cancelled = true; };
  }, [provider]);

  const offer = useMemo(() => offers.find((o) => offerKey(o) === selectedOffer) ?? null, [offers, selectedOffer]);

  const spec: NodeRequest | null = useMemo(() => {
    if (!provider || !offer) return null;
    return {
      provider,
      gpu: offer.gpu,
      gpuCount: offer.gpu ? gpuCount : 0,
      cpu: offer.cpu,
      memoryGb: offer.memoryGb,
      diskGb: offer.diskGb,
      image: offer.image,
      name: name.trim() || undefined,
    };
  }, [provider, offer, gpuCount, name]);

  // The host's callback is held in a ref so a new closure per render does not
  // re-fire the effect; only the request itself matters.
  const onSpecChangeRef = useRef(onSpecChange);
  useEffect(() => { onSpecChangeRef.current = onSpecChange; }, [onSpecChange]);
  useEffect(() => { onSpecChangeRef.current?.(spec); }, [spec]);
  useEffect(() => () => { onSpecChangeRef.current?.(null); }, []);

  const submit = async () => {
    if (!spec || submitting) return;
    setSubmitting(true);
    setError(null);
    setParkedReasons(null);
    const result = await createNode(spec);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.pending) setParkedReasons(result.reasons);
    onCreated(result.node, result.pending);
  };

  const noProvider = providers !== null && configured.length === 0;
  const namePlaceholder = provider ? defaultNodeName(provider, offer?.gpu) : "";

  const body = (
    <>
      {providersError ? (
        <div className="text-xs text-red-400">{providersError}</div>
      ) : providers === null ? (
        <div className="text-xs text-zinc-500">Loading providers…</div>
      ) : noProvider ? (
        <div className="text-xs text-amber-400">
          No compute provider is configured.
          <span className="block text-zinc-500">Add a Modal or Thunder Compute key under Settings → Compute.</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-1 space-y-1">
            <span className="text-[11px] text-zinc-500">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              disabled={submitting}
              className={selectClass}
            >
              {configured.map((p) => (
                <option key={p.id} value={p.id}>{PROVIDER_LABEL[p.id]}</option>
              ))}
            </select>
          </label>

          <label className="col-span-1 space-y-1">
            <span className="text-[11px] text-zinc-500">Name (optional)</span>
            <input
              className={`${inputClass} font-mono`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={namePlaceholder}
              maxLength={64}
              disabled={submitting}
            />
          </label>

          <label className="col-span-2 space-y-1">
            <span className="text-[11px] text-zinc-500">Machine</span>
            <select
              value={selectedOffer}
              onChange={(e) => setSelectedOffer(e.target.value)}
              disabled={submitting || offersLoading || offers.length === 0}
              className={selectClass}
            >
              {offersLoading && <option value="">Loading offers…</option>}
              {!offersLoading && offers.length === 0 && <option value="">No offers</option>}
              {offers.map((o) => (
                <option key={offerKey(o)} value={offerKey(o)} disabled={o.available === false}>
                  {o.label} · {formatUsd(o.hourlyUsd)}/hr est.{o.available === false ? " · unavailable" : ""}
                </option>
              ))}
            </select>
          </label>

          {offer?.gpu && (
            <label className="col-span-1 space-y-1">
              <span className="text-[11px] text-zinc-500">GPUs</span>
              <select
                value={gpuCount}
                onChange={(e) => setGpuCount(Number(e.target.value))}
                disabled={submitting}
                className={selectClass}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>{n}× {offer.gpu}</option>
                ))}
              </select>
            </label>
          )}

          {offersError && <div className="col-span-2 text-[11px] text-red-400">{offersError}</div>}
        </div>
      )}

      {error && <div role="alert" className="mt-2 text-[11px] text-red-400">{error}</div>}
      {parkedReasons && (
        <div role="status" className="mt-2 text-[11px] text-amber-400">
          Waiting for your approval in Naught.
          {parkedReasons.length > 0 && (
            <ul className="mt-0.5 list-disc pl-4 text-zinc-500">
              {parkedReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </>
  );

  if (compact) return <div className="space-y-1">{body}</div>;

  return (
    <div className="mt-2 rounded-lg border border-border bg-canvas/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-zinc-200">Provision a node</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-surface-active hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {body}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-canvas hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!spec || submitting || noProvider}
          className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Create
        </button>
      </div>
    </div>
  );
}
