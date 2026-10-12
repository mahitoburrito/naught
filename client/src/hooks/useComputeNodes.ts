import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodesSummary, ProvisionedNode } from "../types/compute";

/**
 * One poller for `/api/compute/nodes`, shared by every surface that shows
 * nodes (header indicator, approval sheet, move sheet). The first subscriber
 * starts the interval, the last one stops it, so mounting the hook in several
 * places costs one request per tick, not one per mount.
 */

const POLL_MS = 5_000;
const EMPTY: NodesSummary = { nodes: [], live: 0, pending: 0, hourlyUsd: 0 };

type Listener = (summary: NodesSummary) => void;

let cache: NodesSummary = EMPTY;
let loaded = false;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<Listener>();

function normalise(data: any): NodesSummary {
  const nodes: ProvisionedNode[] = Array.isArray(data?.nodes)
    ? data.nodes.filter((node: any) => node && typeof node.id === "string" && node.provision)
    : [];
  return {
    nodes,
    live: typeof data?.live === "number" ? data.live : 0,
    pending: typeof data?.pending === "number" ? data.pending : 0,
    hourlyUsd: typeof data?.hourlyUsd === "number" ? data.hourlyUsd : 0,
  };
}

function fetchNodes(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/compute/nodes");
      if (!res.ok) return;
      cache = normalise(await res.json());
      loaded = true;
      for (const listener of listeners) listener(cache);
    } catch {
      // Keep the last good summary; the next tick retries.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void fetchNodes();
    timer = setInterval(() => void fetchNodes(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export interface ComputeNodesView {
  nodes: ProvisionedNode[];
  /** Nodes that are provisioning or ready (billing or about to). */
  live: number;
  /** Requests parked by the policy, waiting for Approve / Deny. */
  pending: ProvisionedNode[];
  /** Nodes a session can be moved to right now. */
  ready: ProvisionedNode[];
  hourlyUsd: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useComputeNodes(): ComputeNodesView {
  const [summary, setSummary] = useState<NodesSummary>(cache);
  const [loading, setLoading] = useState(!loaded);

  useEffect(() => {
    if (loaded) {
      setSummary(cache);
      setLoading(false);
    }
    return subscribe((next) => {
      setSummary(next);
      setLoading(false);
    });
  }, []);

  const refresh = useCallback(() => fetchNodes(), []);
  const pending = useMemo(
    () => summary.nodes.filter((node) => node.provision.status === "pending"),
    [summary.nodes],
  );
  const ready = useMemo(
    () => summary.nodes.filter((node) => node.provision.status === "ready"),
    [summary.nodes],
  );

  return { nodes: summary.nodes, live: summary.live, pending, ready, hourlyUsd: summary.hourlyUsd, loading, refresh };
}

/**
 * The display name of one node, for surfaces that only need a label (a card
 * mid-move knows the node id before the session carries `devboxName`).
 * Subscribes to the shared poller only while an id is given.
 */
export function useComputeNodeName(nodeId: string | undefined): string | undefined {
  const [name, setName] = useState<string | undefined>(() =>
    nodeId ? cache.nodes.find((node) => node.id === nodeId)?.name : undefined,
  );

  useEffect(() => {
    if (!nodeId) {
      setName(undefined);
      return;
    }
    const pick = (summary: NodesSummary) => setName(summary.nodes.find((node) => node.id === nodeId)?.name);
    pick(cache);
    return subscribe(pick);
  }, [nodeId]);

  return name;
}
