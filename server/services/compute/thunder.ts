import { detectThunderToken, resolveSecret } from "../secrets";
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
 * Thunder Compute: on-demand GPU VMs over a bearer-token REST API, billed per
 * minute. Their docs give shapes without example payloads, so every read of a
 * response goes through the small `num`/`str` helpers and nothing throws on a
 * field that is not where we expected it.
 */

export const THUNDER_BASE_URL = "https://api.thundercompute.com:8443/v1";
export const THUNDER_DEFAULT_TEMPLATE = "ubuntu-22.04";
export const THUNDER_USER = "ubuntu";
const OFFER_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface ThunderOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  file?: Record<string, string>;
  baseUrl?: string;
  /** Poll interval while waiting for an instance (tests shrink it). */
  pollMs?: number;
  tcpProbe?: (host: string, port: number) => Promise<boolean>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

interface ThunderInstance {
  id: string;
  uuid?: string;
  status?: string;
  ip?: string;
  port?: number;
}

export function parseInstanceList(body: unknown): ThunderInstance[] {
  if (!body || typeof body !== "object") return [];
  const raw = body as any;
  const entries: Array<[string, any]> = Array.isArray(raw.instances)
    ? raw.instances.map((item: any, index: number) => [str(item?.id) ?? str(item?.identifier) ?? String(index), item])
    : Array.isArray(raw)
      ? raw.map((item: any, index: number) => [str(item?.id) ?? str(item?.identifier) ?? String(index), item])
      : Object.entries(raw.instances && typeof raw.instances === "object" ? raw.instances : raw);
  return entries.flatMap(([key, item]) => {
    if (!item || typeof item !== "object") return [];
    return [{
      id: str(item.id) ?? str(item.identifier) ?? key,
      uuid: str(item.uuid),
      status: str(item.status)?.toLowerCase(),
      ip: str(item.ip) ?? str(item.ipAddress),
      port: num(item.port),
    }];
  });
}

export function parseSpecs(specsBody: unknown, pricingBody: unknown, templates: string[]): ComputeOffer[] {
  const specs = (specsBody as any)?.specs;
  const pricing = (pricingBody as any)?.pricing;
  if (!specs || typeof specs !== "object") return [];
  const priceFor = (key: string, display?: string): number | undefined => {
    if (!pricing || typeof pricing !== "object") return undefined;
    const candidates = [key, key.toLowerCase(), key.toUpperCase(), display ?? "", (display ?? "").toLowerCase()];
    for (const candidate of candidates) {
      const direct = num((pricing as any)[candidate]);
      if (direct !== undefined) return direct;
      const nested = (pricing as any)[candidate];
      if (nested && typeof nested === "object") {
        const hourly = num(nested.hourly) ?? num(nested.perHour) ?? num(nested.price) ?? num(nested.usd);
        if (hourly !== undefined) return hourly;
      }
    }
    return undefined;
  };
  const offers: ComputeOffer[] = [];
  for (const [key, value] of Object.entries(specs)) {
    if (!value || typeof value !== "object") continue;
    const spec = value as any;
    const display = str(spec.displayName) ?? key;
    const gpuCount = num(spec.gpuCount) ?? 1;
    const ramPerVcpu = num(spec.ramPerVCPUGiB) ?? 4;
    const vcpuOptions = Array.isArray(spec.vcpuOptions)
      ? spec.vcpuOptions.map(num).filter((n: number | undefined): n is number => n !== undefined)
      : [];
    const diskMin = num(spec.storageGB?.min) ?? 100;
    const price = priceFor(key, display);
    for (const cpu of vcpuOptions.length ? vcpuOptions : [4]) {
      const memoryGb = Math.min(num(spec.ramCapGiB) ?? Infinity, cpu * ramPerVcpu);
      offers.push({
        provider: "thunder",
        gpu: key,
        gpuCount,
        cpu,
        memoryGb,
        diskGb: diskMin,
        image: templates[0] ?? THUNDER_DEFAULT_TEMPLATE,
        hourlyUsd: price ?? 0,
        label: `${display} · ${cpu} vCPU · ${memoryGb} GB${price === undefined ? " · price unknown" : ""}`,
      });
    }
  }
  return offers;
}

export function parseTemplates(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = body as any;
  const source = raw.templates && typeof raw.templates === "object" ? raw.templates : raw;
  if (Array.isArray(source)) return source.map((item) => str(item?.id) ?? str(item?.name) ?? str(item)).filter((x): x is string => !!x);
  return Object.keys(source).filter((key) => key && typeof source[key] === "object");
}

export class ThunderProvider implements ComputeProvider {
  readonly id = "thunder" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly pollMs: number;
  private readonly tcpProbe: (host: string, port: number) => Promise<boolean>;
  private offerCache: { at: number; offers: ComputeOffer[] } | null = null;
  /** create() answers with a uuid and an integer identifier; list and delete want the identifier. */
  private readonly identifiers = new Map<string, string>();

  constructor(private readonly options: ThunderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? THUNDER_BASE_URL;
    this.pollMs = options.pollMs ?? 5_000;
    this.tcpProbe = options.tcpProbe ?? ((host, port) => tcpReachable(host, port));
  }

  private token(): { value: string; source: "naught" | "env" | "detected" } | undefined {
    return resolveSecret("TNR_API_TOKEN", {
      env: this.options.env,
      file: this.options.file,
      detector: detectThunderToken,
    });
  }

  async configured(): Promise<ProviderConfigured> {
    const token = this.token();
    if (!token) return { ok: false, detail: "No Thunder token: set TNR_API_TOKEN in Settings → Compute or log in with the tnr CLI." };
    return { ok: true, source: token.source };
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const token = this.token();
    if (!token) throw new ProviderError("Thunder Compute is not configured (no TNR_API_TOKEN).");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token.value}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: any) {
      throw new ProviderError(`Thunder request failed: ${error?.message || String(error)}`);
    }
    const text = await response.text().catch(() => "");
    let body: any = {};
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    }
    if (!response.ok) {
      const message = str(body?.message) ?? str(body?.error) ?? str(body?.raw) ?? response.statusText;
      throw new ProviderError(`Thunder ${response.status}: ${message}`, response.status);
    }
    return body;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const list = parseInstanceList(await this.request("/instances/list"));
      return { ok: true, message: `Connected · ${list.length} instance${list.length === 1 ? "" : "s"}` };
    } catch (error: any) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  async offers(): Promise<ComputeOffer[]> {
    if (this.offerCache && Date.now() - this.offerCache.at < OFFER_CACHE_MS) return this.offerCache.offers;
    const [specs, pricing, templates] = await Promise.all([
      this.request("/v2/specs"),
      this.request("/v2/pricing").catch(() => ({})),
      this.request("/thunder-templates").catch(() => ({})),
    ]);
    const templateIds = parseTemplates(templates);
    const ordered = templateIds.includes(THUNDER_DEFAULT_TEMPLATE)
      ? [THUNDER_DEFAULT_TEMPLATE, ...templateIds.filter((t) => t !== THUNDER_DEFAULT_TEMPLATE)]
      : templateIds;
    const offers = parseSpecs(specs, pricing, ordered);
    this.offerCache = { at: Date.now(), offers };
    return offers;
  }

  estimateHourlyUsd(spec: ComputeSpec): number {
    const offers = this.offerCache?.offers ?? [];
    const match = offers.find((offer) =>
      (offer.gpu ?? "").toLowerCase() === (spec.gpu ?? "").toLowerCase() && offer.cpu === spec.cpu,
    ) ?? offers.find((offer) => (offer.gpu ?? "").toLowerCase() === (spec.gpu ?? "").toLowerCase());
    return match ? match.hourlyUsd * Math.max(1, spec.gpuCount) / Math.max(1, match.gpuCount) : 0;
  }

  async provision(spec: ComputeSpec, publicKey: string): Promise<{ instanceId: string }> {
    const body = await this.request("/instances/create", {
      method: "POST",
      body: JSON.stringify({
        num_gpus: spec.gpuCount,
        gpu_type: spec.gpu,
        cpu_cores: spec.cpu,
        disk_size_gb: spec.diskGb ?? 100,
        template: spec.image ?? THUNDER_DEFAULT_TEMPLATE,
        public_key: publicKey,
      }),
    });
    const uuid = str(body?.uuid);
    const identifier = str(body?.identifier) ?? (num(body?.identifier) !== undefined ? String(num(body?.identifier)) : undefined);
    const instanceId = uuid ?? identifier;
    if (!instanceId) throw new ProviderError("Thunder create returned no instance id.");
    if (identifier) this.identifiers.set(instanceId, identifier);
    return { instanceId };
  }

  private async find(instanceId: string): Promise<ThunderInstance | undefined> {
    const list = parseInstanceList(await this.request("/instances/list"));
    const identifier = this.identifiers.get(instanceId);
    const found = list.find((item) => item.uuid === instanceId || item.id === instanceId || (identifier !== undefined && item.id === identifier));
    if (found && !this.identifiers.has(instanceId)) this.identifiers.set(instanceId, found.id);
    return found;
  }

  async waitReady(instanceId: string, signal: AbortSignal): Promise<SshEndpoint> {
    for (;;) {
      const instance = await this.find(instanceId);
      if (instance?.status && /error|failed/.test(instance.status)) {
        throw new ProviderError(`Thunder instance ${instanceId} reported ${instance.status}`);
      }
      if (instance?.ip && instance.status && /running|active|ready/.test(instance.status)) {
        const endpoint = { host: instance.ip, port: instance.port ?? 22, user: THUNDER_USER };
        if (await this.tcpProbe(endpoint.host, endpoint.port)) return endpoint;
      }
      await sleep(this.pollMs, signal);
    }
  }

  async status(instanceId: string): Promise<ProviderStatus> {
    const instance = await this.find(instanceId);
    if (!instance) return "terminated";
    if (!instance.status) return "provisioning";
    if (/error|failed/.test(instance.status)) return "error";
    if (/running|active|ready/.test(instance.status)) return "ready";
    if (/deleted|terminated|destroyed/.test(instance.status)) return "terminated";
    return "provisioning";
  }

  async terminate(instanceId: string): Promise<void> {
    const identifier = this.identifiers.get(instanceId) ?? (await this.find(instanceId))?.id ?? instanceId;
    try {
      await this.request(`/instances/${encodeURIComponent(identifier)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return;
      throw error;
    }
  }
}
