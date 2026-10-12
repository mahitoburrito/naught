import type { ProviderId } from "../../types";
import type { ComputeSpec } from "./policy";

export type { ComputeSpec } from "./policy";

/** One thing a provider can sell, with an hourly estimate attached. */
export interface ComputeOffer {
  provider: ProviderId;
  gpu?: string;
  gpuCount: number;
  cpu: number;
  memoryGb: number;
  diskGb?: number;
  image?: string;
  hourlyUsd: number;
  available?: boolean;
  label: string;
}

export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
}

export type ProviderStatus = "provisioning" | "ready" | "terminated" | "error";

export interface ProviderConfigured {
  ok: boolean;
  source?: "naught" | "env" | "detected";
  detail?: string;
}

export interface ComputeProvider {
  readonly id: ProviderId;
  /** Whether a usable credential resolves, and where it came from. */
  configured(): Promise<ProviderConfigured>;
  /** A live call that proves the credential works (Settings → Test). */
  test(): Promise<{ ok: boolean; message: string }>;
  offers(): Promise<ComputeOffer[]>;
  estimateHourlyUsd(spec: ComputeSpec): number;
  /** Starts the node and returns as soon as the provider has an id for it. */
  provision(spec: ComputeSpec, publicKey: string): Promise<{ instanceId: string }>;
  /** Resolves when ssh can connect; rejects on provider error or abort. */
  waitReady(instanceId: string, signal: AbortSignal): Promise<SshEndpoint>;
  status(instanceId: string): Promise<ProviderStatus>;
  terminate(instanceId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** True once a TCP connection to the endpoint succeeds; sshd may still be booting, so callers retry. */
export async function tcpReachable(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
