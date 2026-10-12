import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, FolderTree, GitBranch, KeyRound, Loader2, MessageSquare, Server, X } from "lucide-react";
import { useStore } from "../../stores/useStore";
import { formatBytes, formatUsd, type ComputeOffer, type MovePlan, type ProviderId } from "../../types/compute";
import { useComputeNodes } from "../../hooks/useComputeNodes";

const NEW_NODE = "__new__";
const MAX_CONFLICTS_SHOWN = 20;
const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "modal", label: "Modal" },
  { id: "thunder", label: "Thunder Compute" },
];

interface NewNodeDraft {
  provider: ProviderId;
  gpu: string;
  gpuCount: number;
}

interface RequestFailure {
  error: string;
  refusals: string[];
  status: number;
}

async function postJson(url: string, body: unknown): Promise<{ ok: true; data: any } | { ok: false; failure: RequestFailure }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        failure: {
          status: res.status,
          error: typeof data?.error === "string" ? data.error : `Request failed (${res.status})`,
          refusals: Array.isArray(data?.refusals) ? data.refusals.filter((r: unknown) => typeof r === "string") : [],
        },
      };
    }
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, failure: { status: 0, error: err?.message || "Network error", refusals: [] } };
  }
}

const sectionLabel = "text-[11px] font-medium uppercase tracking-wide text-zinc-500";
const fieldClass =
  "h-8 w-full rounded-md border border-border bg-canvas px-2.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50";
const radioClass = "h-3.5 w-3.5 accent-white";

/**
 * Both directions of a session move. Reads `moveSheet` from the store, plans
 * against the server before anything happens, and closes on a 202 — progress
 * then shows on the card, which the poll keeps current.
 */
export function MoveSheet() {
  const request = useStore((state) => state.moveSheet);
  const closeMoveSheet = useStore((state) => state.closeMoveSheet);
  const session = useStore((state) => (request ? state.sessions.get(request.nodeId) : undefined));

  return createPortal(
    <AnimatePresence>
      {request && session && (
        <MoveSheetDialog
          key={`${request.nodeId}:${request.direction}`}
          direction={request.direction}
          sessionId={session.sessionId}
          sessionName={session.customName || session.agentName}
          devboxName={session.devboxName}
          cwd={session.cwd}
          onClose={closeMoveSheet}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface DialogProps {
  direction: "out" | "home";
  sessionId: string;
  sessionName: string;
  devboxName?: string;
  cwd: string;
  onClose: () => void;
}

function MoveSheetDialog({ direction, sessionId, sessionName, devboxName, cwd, onClose }: DialogProps) {
  const { ready } = useComputeNodes();
  const isOut = direction === "out";

  // Destination (out only)
  const [destination, setDestination] = useState<string>(() => ready[0]?.id ?? NEW_NODE);
  const [draft, setDraft] = useState<NewNodeDraft>({ provider: "modal", gpu: "", gpuCount: 1 });
  const [offers, setOffers] = useState<ComputeOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);

  // Options
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [whenWorking, setWhenWorking] = useState<"idle" | "cancel">("idle");
  const [conflictChoice, setConflictChoice] = useState<"overwrite" | "worktree" | null>(null);
  const [terminateNode, setTerminateNode] = useState(true);

  // Plan + submit
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [planning, setPlanning] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [serverConflicts, setServerConflicts] = useState<string[] | null>(null);

  // If a ready node appears after the sheet opened with none, pick it once.
  useEffect(() => {
    if (!isOut || destination !== NEW_NODE || ready.length === 0) return;
    if (ready.some((node) => node.id === destination)) return;
    setDestination(ready[0].id);
    // Only on the first arrival; later changes are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.length > 0]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Plan: re-run whenever the inputs that change the answer change.
  useEffect(() => {
    const controller = new AbortController();
    setPlanning(true);
    setPlanError(null);
    setFailure(null);
    const url = isOut
      ? `/api/sessions/${encodeURIComponent(sessionId)}/move/plan`
      : `/api/sessions/${encodeURIComponent(sessionId)}/move/home/plan`;
    const body = isOut ? { nodeId: destination === NEW_NODE ? undefined : destination, includeIgnored } : {};
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Could not plan the move (${res.status})`);
        return data as MovePlan;
      })
      .then((next) => {
        setPlan(next);
        setPlanning(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setPlan(null);
        setPlanError(err?.message || "Could not plan the move");
        setPlanning(false);
      });
    return () => controller.abort();
  }, [isOut, sessionId, destination, includeIgnored]);

  // Offers for the inline new-node form.
  useEffect(() => {
    if (!isOut || destination !== NEW_NODE) return;
    const controller = new AbortController();
    setOffersLoading(true);
    setOffersError(null);
    fetch(`/api/compute/offers?provider=${encodeURIComponent(draft.provider)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Could not load ${draft.provider} offers`);
        return (Array.isArray(data?.offers) ? data.offers : []) as ComputeOffer[];
      })
      .then((list) => {
        setOffers(list);
        setOffersLoading(false);
        setDraft((prev) => {
          if (prev.gpu && list.some((offer) => offer.gpu === prev.gpu)) return prev;
          const firstGpu = list.find((offer) => offer.gpu)?.gpu;
          return { ...prev, gpu: firstGpu ?? "" };
        });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setOffers(null);
        setOffersError(err?.message || "Could not load offers");
        setOffersLoading(false);
      });
    return () => controller.abort();
  }, [isOut, destination, draft.provider]);

  const gpuChoices = useMemo(() => {
    if (!offers) return [];
    const seen = new Map<string, ComputeOffer>();
    for (const offer of offers) {
      if (!offer.gpu || seen.has(offer.gpu)) continue;
      seen.set(offer.gpu, offer);
    }
    return Array.from(seen.values());
  }, [offers]);
  const selectedOffer = useMemo(
    () => (offers ?? []).find((offer) => (draft.gpu ? offer.gpu === draft.gpu : !offer.gpu)),
    [offers, draft.gpu],
  );

  const conflicts = serverConflicts ?? plan?.conflicts ?? [];
  const hasConflicts = !isOut && conflicts.length > 0;
  const refusals = plan?.refusals ?? [];
  const agentWorking = isOut && plan?.agentState === "working";
  const cancelChosen = agentWorking && whenWorking === "cancel";

  const canSubmit =
    !planning &&
    !submitting &&
    !!plan &&
    refusals.length === 0 &&
    (!hasConflicts || conflictChoice !== null) &&
    (!isOut || destination !== NEW_NODE || !!draft.provider);

  const submit = useCallback(async () => {
    if (cancelChosen) {
      onClose();
      return;
    }
    if (!canSubmit) return;
    setSubmitting(true);
    setFailure(null);
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/move`;
    const result = isOut
      ? await postJson(base, {
          ...(destination === NEW_NODE
            ? {
                newNode: {
                  provider: draft.provider,
                  gpu: draft.gpu || undefined,
                  gpuCount: draft.gpu ? Math.max(1, draft.gpuCount) : 0,
                  cpu: 4,
                  memoryGb: 16,
                },
              }
            : { nodeId: destination }),
          includeIgnored,
          whenIdle: plan?.agentState === "working",
        })
      : await postJson(`${base}/home`, {
          conflict: hasConflicts ? conflictChoice : undefined,
          terminateNode,
          whenIdle: true,
        });
    setSubmitting(false);
    if (result.ok) {
      onClose();
      return;
    }
    if (!isOut && result.failure.status === 409) {
      setServerConflicts(result.failure.refusals.length ? result.failure.refusals : ["(local tree changed since the move)"]);
      setConflictChoice(null);
      setFailure({ ...result.failure, refusals: [] });
      return;
    }
    setFailure(result.failure);
  }, [cancelChosen, canSubmit, sessionId, isOut, destination, draft, includeIgnored, plan?.agentState, hasConflicts, conflictChoice, terminateNode, onClose]);

  const title = isOut ? "Move to a node" : "Bring back";
  const primaryLabel = cancelChosen ? "Close" : isOut ? (agentWorking ? "Move when idle" : "Move") : "Bring back";
  const cwdName = cwd.split("/").pop() || cwd;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="move-sheet-title"
          className="titlebar-no-drag pointer-events-auto mx-4 w-full max-w-[540px]"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 id="move-sheet-title" className="text-base font-semibold text-white">{title}</h2>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {sessionName}
                  {!isOut && devboxName ? ` · on ${devboxName}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-canvas hover:text-white"
                aria-label="Close"
                title="Close (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {isOut && (
                <section className="space-y-2">
                  <label htmlFor="move-destination" className={sectionLabel}>Destination</label>
                  <select
                    id="move-destination"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    className={fieldClass}
                  >
                    {ready.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {node.provision.gpu ? `${node.provision.gpu} × ${node.provision.gpuCount || 1}` : "CPU"} · {formatUsd(node.provision.hourlyUsd)}/hr est.
                      </option>
                    ))}
                    <option value={NEW_NODE}>New node…</option>
                  </select>
                  {destination === NEW_NODE && (
                    <div className="space-y-2 rounded-lg border border-border bg-canvas/60 p-3">
                      <div className="grid grid-cols-[1fr_1fr_72px] gap-2">
                        <div>
                          <label htmlFor="move-provider" className="mb-1 block text-[11px] text-zinc-500">Provider</label>
                          <select
                            id="move-provider"
                            value={draft.provider}
                            onChange={(event) => setDraft((prev) => ({ ...prev, provider: event.target.value as ProviderId }))}
                            className={fieldClass}
                          >
                            {PROVIDERS.map((provider) => (
                              <option key={provider.id} value={provider.id}>{provider.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="move-gpu" className="mb-1 block text-[11px] text-zinc-500">GPU</label>
                          {offers && !offersError ? (
                            <select
                              id="move-gpu"
                              value={draft.gpu}
                              onChange={(event) => setDraft((prev) => ({ ...prev, gpu: event.target.value }))}
                              className={fieldClass}
                              disabled={offersLoading}
                            >
                              <option value="">CPU only</option>
                              {gpuChoices.map((offer) => (
                                <option key={offer.gpu} value={offer.gpu}>
                                  {offer.gpu}{offer.available === false ? " (unavailable)" : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id="move-gpu"
                              value={draft.gpu}
                              onChange={(event) => setDraft((prev) => ({ ...prev, gpu: event.target.value }))}
                              placeholder="H100, A100-80GB, … (blank = CPU)"
                              className={fieldClass}
                              spellCheck={false}
                            />
                          )}
                        </div>
                        <div>
                          <label htmlFor="move-gpu-count" className="mb-1 block text-[11px] text-zinc-500">Count</label>
                          <input
                            id="move-gpu-count"
                            type="number"
                            min={1}
                            max={8}
                            value={draft.gpuCount}
                            disabled={!draft.gpu}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, gpuCount: Math.max(1, Math.min(8, Number(event.target.value) || 1)) }))
                            }
                            className={fieldClass}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-zinc-500">
                        {offersLoading
                          ? "Loading offers…"
                          : offersError
                            ? offersError
                            : selectedOffer
                              ? `${selectedOffer.label} · ${formatUsd(selectedOffer.hourlyUsd)}/hr est. · 4 vCPU · 16 GB`
                              : "4 vCPU · 16 GB · the move starts once the node is ready"}
                      </p>
                    </div>
                  )}
                </section>
              )}

              {planning && !plan ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Planning…
                </div>
              ) : planError ? (
                <p role="alert" className="text-xs text-red-400">{planError}</p>
              ) : plan ? (
                <>
                  <section className="space-y-1.5">
                    <div className={sectionLabel}>What moves</div>
                    <div className="flex items-start gap-2 text-xs text-zinc-300">
                      <MessageSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-500" aria-hidden />
                      <span>{plan.harness.description}</span>
                    </div>
                    {plan.manifest && (
                      <div className="flex items-start gap-2 text-xs text-zinc-300">
                        <FolderTree className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-500" aria-hidden />
                        <span>
                          <span className="font-mono text-zinc-200">{cwdName}</span>
                          {" · "}
                          {plan.manifest.files} files · {formatBytes(plan.manifest.bytes)}
                        </span>
                      </div>
                    )}
                    {plan.gitDir && (
                      <div className="flex items-start gap-2 text-xs text-zinc-300">
                        <GitBranch className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-500" aria-hidden />
                        <span>
                          Mother repo <span className="font-mono">.git</span> included
                        </span>
                      </div>
                    )}
                    {isOut && (
                      <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-zinc-300">
                        <input
                          type="checkbox"
                          checked={includeIgnored}
                          onChange={(event) => setIncludeIgnored(event.target.checked)}
                          className="h-3.5 w-3.5 accent-white"
                        />
                        <span>
                          Include ignored files (node_modules, .env, caches)
                          {plan.includeIgnoredExtraBytes !== undefined && !includeIgnored && (
                            <span className="text-zinc-500"> · +{formatBytes(plan.includeIgnoredExtraBytes)}</span>
                          )}
                        </span>
                      </label>
                    )}
                  </section>

                  {agentWorking && (
                    <section className="space-y-1.5" role="radiogroup" aria-labelledby="move-agent-state">
                      <div id="move-agent-state" className={sectionLabel}>Agent is working</div>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="radio"
                          name="move-when-working"
                          checked={whenWorking === "idle"}
                          onChange={() => setWhenWorking("idle")}
                          className={radioClass}
                        />
                        Move when the agent goes idle
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="radio"
                          name="move-when-working"
                          checked={whenWorking === "cancel"}
                          onChange={() => setWhenWorking("cancel")}
                          className={radioClass}
                        />
                        Cancel
                      </label>
                    </section>
                  )}

                  {hasConflicts && (
                    <section className="space-y-1.5" role="radiogroup" aria-labelledby="move-conflicts">
                      <div id="move-conflicts" className={sectionLabel}>
                        Local files changed since the move
                      </div>
                      <ul className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-border bg-canvas/60 px-2.5 py-2 font-mono text-[11px] text-amber-300">
                        {conflicts.slice(0, MAX_CONFLICTS_SHOWN).map((path, index) => (
                          <li key={`${path}-${index}`} className="truncate" title={path}>{path}</li>
                        ))}
                        {conflicts.length > MAX_CONFLICTS_SHOWN && (
                          <li className="text-zinc-500">+{conflicts.length - MAX_CONFLICTS_SHOWN} more</li>
                        )}
                      </ul>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="radio"
                          name="move-conflict"
                          checked={conflictChoice === "overwrite"}
                          onChange={() => setConflictChoice("overwrite")}
                          className={radioClass}
                        />
                        Overwrite local files with the node's copy
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="radio"
                          name="move-conflict"
                          checked={conflictChoice === "worktree"}
                          onChange={() => setConflictChoice("worktree")}
                          className={radioClass}
                        />
                        <span>
                          Bring back into a fresh worktree
                          <span className="text-zinc-500"> · git repositories only</span>
                        </span>
                      </label>
                    </section>
                  )}

                  {!isOut && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={terminateNode}
                        onChange={(event) => setTerminateNode(event.target.checked)}
                        className="h-3.5 w-3.5 accent-white"
                      />
                      Terminate the node afterwards
                    </label>
                  )}

                  {isOut && plan.credential && (
                    <div className="flex items-start gap-2 text-xs text-zinc-400">
                      <KeyRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-500" aria-hidden />
                      <span>
                        Node credential: <span className="font-mono text-zinc-300">{plan.credential}</span>
                      </span>
                    </div>
                  )}

                  {plan.warnings.length > 0 && (
                    <ul className="space-y-1 text-xs text-amber-300">
                      {plan.warnings.map((warning, index) => (
                        <li key={index} className="flex gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                          <span>{warning}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {refusals.length > 0 && (
                    <ul role="alert" className="space-y-1 text-xs text-red-400">
                      {refusals.map((refusal, index) => (
                        <li key={index} className="flex gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                          <span>{refusal}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}

              {failure && (
                <div role="alert" className="space-y-1 text-xs text-red-400">
                  <p>{failure.error}</p>
                  {failure.refusals.length > 0 && (
                    <ul className="space-y-0.5 pl-3">
                      {failure.refusals.map((refusal, index) => (
                        <li key={index}>• {refusal}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Server className="h-3 w-3" aria-hidden />
                {isOut ? "Nothing local is changed by a move out." : "Transcripts come back by overwrite; the node's copy is the newer one."}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 rounded-md border border-border px-3 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!cancelChosen && !canSubmit}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {primaryLabel}
                </button>
              </div>
            </div>
          </form>
        </div>
      </motion.div>
    </>
  );
}
