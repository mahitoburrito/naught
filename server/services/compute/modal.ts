import { detectModalToken, resolveSecret } from "../secrets";
import {
  ProviderError,
  sleep,
  tcpReachable,
  type ComputeOffer,
  type ComputeProvider,
  type ComputeSpec,
  type ProviderConfigured,
  type ProviderStatus,
  type SshEndpoint,
} from "./provider";

/**
 * Modal Sandboxes through the official `modal` npm SDK. A node is a sandbox
 * whose entrypoint is sshd, with port 22 tunneled out, built from an image
 * that already carries the Claude and Codex CLIs.
 */

export const MODAL_APP_NAME = "naught";
export const MODAL_USER = "root";
const CPU_IMAGE = "ubuntu:22.04";
const GPU_IMAGE = "nvidia/cuda:12.4.0-devel-ubuntu22.04";

/** Public list prices, $/hr. Sandbox CPU and memory bill at the higher sandbox rates. */
export const MODAL_GPU_HOURLY_USD: Record<string, number> = {
  T4: 0.59,
  L4: 0.80,
  A10G: 1.10,
  L40S: 1.95,
  "A100-40GB": 2.10,
  "A100-80GB": 2.50,
  H100: 3.95,
  H200: 4.54,
  B200: 6.25,
};
export const MODAL_SANDBOX_CPU_HOURLY_USD = 0.00003942 * 3600;   // per core
export const MODAL_SANDBOX_MEMORY_HOURLY_USD = 0.00000667 * 3600; // per GiB

export const MODAL_PRESETS: Array<{ id: string; cpu: number; memoryGb: number }> = [
  { id: "small", cpu: 2, memoryGb: 8 },
  { id: "medium", cpu: 4, memoryGb: 16 },
  { id: "large", cpu: 8, memoryGb: 32 },
];

/** The subset of the SDK the provider touches, so tests can hand in a fake. */
export interface ModalClientLike {
  apps: { fromName(name: string, params?: { createIfMissing?: boolean }): Promise<unknown> };
  images: { fromRegistry(tag: string): { dockerfileCommands(commands: string[]): unknown } };
  sandboxes: {
    create(app: unknown, image: unknown, params?: Record<string, unknown>): Promise<ModalSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSandboxLike>;
    list(params?: { appId?: string; tags?: Record<string, string> }): AsyncIterable<ModalSandboxLike>;
  };
}

export interface ModalSandboxLike {
  sandboxId: string;
  tunnels(timeoutMs?: number): Promise<Record<number, { host: string; port: number; tcpSocket: [string, number] }>>;
  poll(): Promise<number | null>;
  terminate(): Promise<void>;
}

export interface ModalOptions {
  env?: NodeJS.ProcessEnv;
  file?: Record<string, string>;
  clientFactory?: (tokens: { tokenId: string; tokenSecret: string }) => Promise<ModalClientLike>;
  pollMs?: number;
  tcpProbe?: (host: string, port: number) => Promise<boolean>;
}

export function buildModalImageCommands(spec: Pick<ComputeSpec, "gpu">, publicKey: string): { base: string; commands: string[] } {
  const base = spec.gpu ? GPU_IMAGE : CPU_IMAGE;
  const key = publicKey.replace(/'/g, "");
  return {
    base,
    commands: [
      "ENV DEBIAN_FRONTEND=noninteractive",
      "RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git rsync curl ca-certificates gnupg python3 tar && rm -rf /var/lib/apt/lists/*",
      // Ubuntu 22.04's packaged nodejs is v12: too old for the Codex CLI and for
      // the naught CLI's fetch. NodeSource gives a current LTS.
      "RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*",
      "RUN curl -fsSL https://claude.ai/install.sh | bash",
      "RUN npm install -g @openai/codex",
      "RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
      `RUN echo '${key}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
      "RUN sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config",
      "ENV PATH=/root/.local/bin:$PATH",
    ],
  };
}

export function toSandboxParams(spec: ComputeSpec): Record<string, unknown> {
  return {
    command: ["/usr/sbin/sshd", "-D", "-e"],
    unencryptedPorts: [22],
    ...(spec.gpu ? { gpu: spec.gpuCount > 1 ? `${spec.gpu}:${spec.gpuCount}` : spec.gpu } : {}),
    cpu: spec.cpu,
    memoryMiB: Math.round(spec.memoryGb * 1024),
    timeoutMs: Math.round(spec.maxLifetimeHours * 3_600_000),
    name: spec.name,
  };
}

export function estimateModalHourlyUsd(spec: Pick<ComputeSpec, "gpu" | "gpuCount" | "cpu" | "memoryGb">): number {
  const gpu = spec.gpu ? (MODAL_GPU_HOURLY_USD[spec.gpu] ?? 0) * Math.max(1, spec.gpuCount) : 0;
  const cpu = spec.cpu * MODAL_SANDBOX_CPU_HOURLY_USD;
  const memory = spec.memoryGb * MODAL_SANDBOX_MEMORY_HOURLY_USD;
  return Math.round((gpu + cpu + memory) * 100) / 100;
}

export function modalOffers(): ComputeOffer[] {
  const offers: ComputeOffer[] = [];
  for (const preset of MODAL_PRESETS) {
    const hourlyUsd = estimateModalHourlyUsd({ gpu: undefined, gpuCount: 0, cpu: preset.cpu, memoryGb: preset.memoryGb });
    offers.push({
      provider: "modal",
      gpuCount: 0,
      cpu: preset.cpu,
      memoryGb: preset.memoryGb,
      hourlyUsd,
      label: `CPU only · ${preset.cpu} vCPU · ${preset.memoryGb} GB`,
    });
  }
  for (const gpu of Object.keys(MODAL_GPU_HOURLY_USD)) {
    const preset = MODAL_PRESETS[1];
    const hourlyUsd = estimateModalHourlyUsd({ gpu, gpuCount: 1, cpu: preset.cpu, memoryGb: preset.memoryGb });
    offers.push({
      provider: "modal",
      gpu,
      gpuCount: 1,
      cpu: preset.cpu,
      memoryGb: preset.memoryGb,
      hourlyUsd,
      label: `${gpu} · ${preset.cpu} vCPU · ${preset.memoryGb} GB`,
    });
  }
  return offers;
}

async function defaultClientFactory(tokens: { tokenId: string; tokenSecret: string }): Promise<ModalClientLike> {
  const sdk: any = await import("modal");
  return new sdk.ModalClient({ tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret }) as ModalClientLike;
}

export class ModalProvider implements ComputeProvider {
  readonly id = "modal" as const;
  private readonly pollMs: number;
  private readonly tcpProbe: (host: string, port: number) => Promise<boolean>;
  private readonly clientFactory: NonNullable<ModalOptions["clientFactory"]>;
  private clientPromise: Promise<ModalClientLike> | null = null;
  private clientTokenId: string | null = null;
  private readonly sandboxes = new Map<string, ModalSandboxLike>();

  constructor(private readonly options: ModalOptions = {}) {
    this.pollMs = options.pollMs ?? 3_000;
    this.tcpProbe = options.tcpProbe ?? ((host, port) => tcpReachable(host, port));
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  private tokens(): { tokenId: string; tokenSecret: string; source: "naught" | "env" | "detected" } | undefined {
    const id = resolveSecret("MODAL_TOKEN_ID", { env: this.options.env, file: this.options.file });
    const secret = resolveSecret("MODAL_TOKEN_SECRET", { env: this.options.env, file: this.options.file });
    if (id && secret) return { tokenId: id.value, tokenSecret: secret.value, source: id.source === secret.source ? id.source : "naught" };
    const detected = detectModalToken(this.options.env);
    if (detected) return { tokenId: detected.tokenId, tokenSecret: detected.tokenSecret, source: "detected" };
    return undefined;
  }

  async configured(): Promise<ProviderConfigured> {
    const tokens = this.tokens();
    if (!tokens) return { ok: false, detail: "No Modal token: set it in Settings → Compute or run `modal token new`." };
    return { ok: true, source: tokens.source };
  }

  private client(): Promise<ModalClientLike> {
    const tokens = this.tokens();
    if (!tokens) throw new ProviderError("Modal is not configured (no MODAL_TOKEN_ID / MODAL_TOKEN_SECRET).");
    if (!this.clientPromise || this.clientTokenId !== tokens.tokenId) {
      this.clientTokenId = tokens.tokenId;
      this.clientPromise = this.clientFactory({ tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret });
      this.clientPromise.catch(() => { this.clientPromise = null; });
    }
    return this.clientPromise;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const client = await this.client();
      await client.apps.fromName(MODAL_APP_NAME, { createIfMissing: true });
      let count = 0;
      try {
        for await (const _sandbox of client.sandboxes.list({ tags: { naught: "node" } })) count++;
      } catch {
        // Listing is a nicety; the app lookup already proved the token.
      }
      return { ok: true, message: `Connected · ${count} sandbox${count === 1 ? "" : "es"} live` };
    } catch (error: any) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  async offers(): Promise<ComputeOffer[]> {
    return modalOffers();
  }

  estimateHourlyUsd(spec: ComputeSpec): number {
    return estimateModalHourlyUsd(spec);
  }

  async provision(spec: ComputeSpec, publicKey: string): Promise<{ instanceId: string }> {
    const client = await this.client();
    const app = await client.apps.fromName(MODAL_APP_NAME, { createIfMissing: true });
    const { base, commands } = buildModalImageCommands(spec, publicKey);
    const image = client.images.fromRegistry(base).dockerfileCommands(commands);
    let sandbox: ModalSandboxLike;
    try {
      sandbox = await client.sandboxes.create(app, image, toSandboxParams(spec));
    } catch (error: any) {
      throw new ProviderError(`Modal could not start the sandbox: ${error?.message || String(error)}`);
    }
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return { instanceId: sandbox.sandboxId };
  }

  private async sandbox(instanceId: string): Promise<ModalSandboxLike> {
    const cached = this.sandboxes.get(instanceId);
    if (cached) return cached;
    const client = await this.client();
    const sandbox = await client.sandboxes.fromId(instanceId);
    this.sandboxes.set(instanceId, sandbox);
    return sandbox;
  }

  async waitReady(instanceId: string, signal: AbortSignal): Promise<SshEndpoint> {
    const sandbox = await this.sandbox(instanceId);
    for (;;) {
      const exit = await sandbox.poll().catch(() => null);
      if (exit !== null) throw new ProviderError(`Modal sandbox ${instanceId} exited with code ${exit} before it was reachable`);
      let endpoint: SshEndpoint | undefined;
      try {
        const tunnels = await sandbox.tunnels();
        const tunnel = tunnels[22];
        if (tunnel) {
          const [host, port] = tunnel.tcpSocket ?? [tunnel.host, tunnel.port];
          if (host && port) endpoint = { host, port, user: MODAL_USER };
        }
      } catch {
        // Tunnels are not published until the container is up; keep polling.
      }
      if (endpoint && (await this.tcpProbe(endpoint.host, endpoint.port))) return endpoint;
      await sleep(this.pollMs, signal);
    }
  }

  async status(instanceId: string): Promise<ProviderStatus> {
    try {
      const sandbox = await this.sandbox(instanceId);
      const exit = await sandbox.poll();
      return exit === null ? "ready" : "terminated";
    } catch (error: any) {
      if (/not found|does not exist|NOT_FOUND/i.test(error?.message || "")) return "terminated";
      throw new ProviderError(`Modal status failed: ${error?.message || String(error)}`);
    }
  }

  async terminate(instanceId: string): Promise<void> {
    try {
      const sandbox = await this.sandbox(instanceId);
      await sandbox.terminate();
    } catch (error: any) {
      if (/not found|does not exist|NOT_FOUND/i.test(error?.message || "")) return;
      throw new ProviderError(`Modal terminate failed: ${error?.message || String(error)}`);
    } finally {
      this.sandboxes.delete(instanceId);
    }
  }
}
