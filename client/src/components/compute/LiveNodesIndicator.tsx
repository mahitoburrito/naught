import { Server } from "lucide-react";
import { useStore } from "../../stores/useStore";
import { agentStatusStyle } from "../../theme/agentStatus";
import { formatUsd } from "../../types/compute";
import { useComputeNodes } from "../../hooks/useComputeNodes";

/**
 * Header pill that stays visible for as long as a node is billing or a
 * request is waiting for approval. Spend is consequential state, so it lives
 * here and not in a toast. Click lands on Settings → Devboxes.
 */
export function LiveNodesIndicator() {
  const { live, pending, hourlyUsd } = useComputeNodes();
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const setSettingsTab = useStore((state) => state.setSettingsTab);

  if (live + pending.length === 0) return null;

  const awaiting = pending.length;
  const style = agentStatusStyle(awaiting > 0 ? "waiting_input" : "running");
  const parts: string[] = [];
  if (live > 0) parts.push(`${live} node${live === 1 ? "" : "s"} · ${formatUsd(hourlyUsd)}/hr est.`);
  if (awaiting > 0) parts.push(`${awaiting} awaiting approval`);
  const label = parts.join(" · ");

  return (
    <button
      type="button"
      onClick={() => {
        setSettingsTab("devboxes");
        setSettingsOpen(true);
      }}
      className="titlebar-no-drag ml-1 flex h-6 flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
      style={{ color: style.color, backgroundColor: style.bg, borderColor: style.border }}
      title={awaiting > 0 ? "Compute nodes — a request is waiting for your approval" : "Compute nodes — open Settings → Devboxes"}
      aria-label={`Compute nodes: ${label}. Open Settings, Devboxes tab`}
    >
      <Server className="h-3 w-3 flex-shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
