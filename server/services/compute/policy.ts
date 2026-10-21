import type { ComputeConfig, ComputePolicy, ProviderId } from "../../types";

/** What a request asks a provider for. */
export interface ComputeSpec {
  provider: ProviderId;
  gpu?: string;
  gpuCount: number;
  cpu: number;
  memoryGb: number;
  diskGb?: number;
  image?: string;
  name: string;
  maxLifetimeHours: number;
}

export const DEFAULT_COMPUTE_CONFIG: ComputeConfig = {
  policy: {
    maxConcurrentNodes: 2,
    allowedGpus: "any",
    maxLifetimeHours: 8,
    maxHourlyUsd: 5,
  },
  notifications: {
    to: undefined,
    from: "Naught <support@prbe.ai>",
    reminderHours: 4,
    idleAlertMinutes: 60,
  },
  nodeCredentials: { syncCodexAuth: false },
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 320 && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

export function normaliseComputeConfig(input: unknown): ComputeConfig {
  const raw = (input && typeof input === "object" ? input : {}) as any;
  const policyRaw = raw.policy && typeof raw.policy === "object" ? raw.policy : {};
  const notifyRaw = raw.notifications && typeof raw.notifications === "object" ? raw.notifications : {};
  const credsRaw = raw.nodeCredentials && typeof raw.nodeCredentials === "object" ? raw.nodeCredentials : {};
  const defaults = DEFAULT_COMPUTE_CONFIG;

  let allowedGpus: ComputePolicy["allowedGpus"] = "any";
  if (Array.isArray(policyRaw.allowedGpus)) {
    const list = Array.from(
      new Set(
        policyRaw.allowedGpus
          .filter((item: unknown): item is string => typeof item === "string")
          .map((item: string) => item.trim())
          .filter(Boolean),
      ),
    ).slice(0, 64) as string[];
    allowedGpus = list;
  }

  return {
    policy: {
      maxConcurrentNodes: Math.floor(clampNumber(policyRaw.maxConcurrentNodes, defaults.policy.maxConcurrentNodes, 0, 100)),
      allowedGpus,
      maxLifetimeHours: clampNumber(policyRaw.maxLifetimeHours, defaults.policy.maxLifetimeHours, 0.25, 24 * 14),
      maxHourlyUsd: clampNumber(policyRaw.maxHourlyUsd, defaults.policy.maxHourlyUsd, 0, 10_000),
    },
    notifications: {
      to: cleanAddress(notifyRaw.to),
      from: cleanAddress(notifyRaw.from) || defaults.notifications.from,
      reminderHours: clampNumber(notifyRaw.reminderHours, defaults.notifications.reminderHours, 0.25, 24 * 7),
      idleAlertMinutes: clampNumber(notifyRaw.idleAlertMinutes, defaults.notifications.idleAlertMinutes, 5, 24 * 60),
    },
    nodeCredentials: { syncCodexAuth: credsRaw.syncCodexAuth === true },
  };
}

export interface PolicyVerdict {
  allowed: boolean;
  reasons: string[];
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Pure. Every cap that fails adds a reason; the approval sheet shows them all
 * so the user does not approve one thing only to hit the next.
 */
export function evaluatePolicy(
  policy: ComputePolicy,
  spec: ComputeSpec & { hourlyUsd: number },
  context: { liveNodes: number },
): PolicyVerdict {
  const reasons: string[] = [];
  if (context.liveNodes >= policy.maxConcurrentNodes) {
    reasons.push(`Already ${context.liveNodes} of ${policy.maxConcurrentNodes} nodes live`);
  }
  if (spec.gpu && policy.allowedGpus !== "any") {
    const allowed = policy.allowedGpus.map((item) => item.toLowerCase());
    if (!allowed.includes(spec.gpu.toLowerCase())) {
      reasons.push(`GPU ${spec.gpu} is not in the allowed list (${policy.allowedGpus.join(", ") || "none"})`);
    }
  }
  if (spec.hourlyUsd > policy.maxHourlyUsd) {
    reasons.push(`Estimated ${money(spec.hourlyUsd)}/hr exceeds the ${money(policy.maxHourlyUsd)}/hr cap`);
  }
  if (spec.maxLifetimeHours > policy.maxLifetimeHours) {
    reasons.push(`Lifetime ${spec.maxLifetimeHours}h exceeds the ${policy.maxLifetimeHours}h cap`);
  }
  return { allowed: reasons.length === 0, reasons };
}
