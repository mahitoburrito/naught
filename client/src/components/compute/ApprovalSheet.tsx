import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, Server, X } from "lucide-react";
import { useStore } from "../../stores/useStore";
import { agentStatusStyle } from "../../theme/agentStatus";
import { formatUsd, type ProvisionedNode } from "../../types/compute";
import { useComputeNodes } from "../../hooks/useComputeNodes";

const PROVIDER_LABELS: Record<string, string> = { modal: "Modal", thunder: "Thunder Compute" };

function specLine(node: ProvisionedNode): string {
  const p = node.provision;
  const parts = [p.gpu ? `${p.gpu} × ${p.gpuCount || 1}` : "CPU only", `${p.cpu} vCPU`, `${p.memoryGb} GB`];
  if (p.diskGb) parts.push(`${p.diskGb} GB disk`);
  return parts.join(" · ");
}

/**
 * Opens on its own whenever the policy parks a request. Dismissing hides the
 * requests seen so far until a new one arrives; the header indicator keeps
 * counting them, so nothing is lost by closing this.
 */
export function ApprovalSheet() {
  const { pending, refresh } = useComputeNodes();
  const sessions = useStore((state) => state.sessions);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Record<string, "approve" | "deny">>({});
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => pending.filter((node) => !dismissed.has(node.id)), [pending, dismissed]);
  const open = visible.length > 0;

  const dismiss = useCallback(() => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const node of visible) next.add(node.id);
      return next;
    });
    setError(null);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, dismiss]);

  const requesterName = useCallback(
    (node: ProvisionedNode): string => {
      const by = node.provision.requestedBy;
      if (by.kind !== "session") return "You";
      for (const session of sessions.values()) {
        if (session.sessionId === by.sessionId) return session.customName || session.agentName;
      }
      return `Session ${by.sessionId.slice(0, 8)}`;
    },
    [sessions],
  );

  const act = async (node: ProvisionedNode, action: "approve" | "deny") => {
    setBusy((prev) => ({ ...prev, [node.id]: action }));
    setError(null);
    try {
      const res = await fetch(`/api/compute/nodes/${encodeURIComponent(node.id)}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not ${action} ${node.name}`);
    } catch (err: any) {
      setError(err?.message || `Could not ${action} ${node.name}`);
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      await refresh();
    }
  };

  const pendingStyle = agentStatusStyle("waiting_input");

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            onClick={dismiss}
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
              aria-labelledby="approval-sheet-title"
              className="titlebar-no-drag pointer-events-auto mx-4 w-full max-w-[520px]"
            >
              <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
                <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: pendingStyle.color }} aria-hidden />
                    <h2 id="approval-sheet-title" className="text-base font-semibold text-white">
                      {visible.length === 1 ? "Node request awaiting approval" : `${visible.length} node requests awaiting approval`}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={dismiss}
                    className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-canvas hover:text-white"
                    aria-label="Dismiss for now"
                    title="Dismiss for now (Esc) — the header keeps the count"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
                  <p className="text-xs text-zinc-500">
                    These requests fall outside the spend policy. Nothing is billed until you approve.
                  </p>
                  {visible.map((node) => {
                    const p = node.provision;
                    const working = busy[node.id];
                    return (
                      <div key={node.id} className="rounded-lg border border-border bg-canvas/60 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-zinc-100">
                              <Server className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" aria-hidden />
                              <span className="truncate">{node.name}</span>
                              <span className="flex-shrink-0 rounded border border-border px-1.5 py-px text-[10px] font-normal text-zinc-400">
                                {PROVIDER_LABELS[p.provider] || p.provider}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-zinc-400">{specLine(node)}</div>
                            <div className="mt-0.5 text-xs text-zinc-400">
                              <span className="font-medium text-zinc-200">{formatUsd(p.hourlyUsd)}/hr</span> est.
                              {p.maxLifetimeHours > 0 && <> · up to {p.maxLifetimeHours} h</>}
                            </div>
                          </div>
                          <div className="text-right text-[11px] text-zinc-500">
                            <div>Requested by</div>
                            <div className="max-w-[160px] truncate font-medium text-zinc-300">{requesterName(node)}</div>
                          </div>
                        </div>

                        {p.reasons && p.reasons.length > 0 && (
                          <ul className="mt-2.5 space-y-0.5 text-xs" style={{ color: pendingStyle.color }}>
                            {p.reasons.map((reason, index) => (
                              <li key={index} className="flex gap-1.5">
                                <span aria-hidden>•</span>
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="mt-3 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void act(node, "deny")}
                            disabled={!!working}
                            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {working === "deny" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                            Deny
                          </button>
                          <button
                            type="button"
                            onClick={() => void act(node, "approve")}
                            disabled={!!working}
                            className="flex h-7 items-center gap-1.5 rounded-md bg-white px-3 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {working === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            Approve
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {error && (
                    <p role="alert" className="text-xs text-red-400">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
