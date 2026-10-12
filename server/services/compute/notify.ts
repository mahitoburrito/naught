import type { ComputeNotifications, DevboxConfig, ProvisionRecord } from "../../types";

/**
 * Billing mail through Resend. Every message carries an idempotency key built
 * from the node and the event, so a restart inside Resend's 24-hour window
 * cannot send the same reminder twice.
 */

export type NodeEmailKind = "started" | "reminder" | "idle" | "terminated";

export interface NodeEmailInput {
  kind: NodeEmailKind;
  /** Reminder / idle ordinal, starting at 1. */
  n?: number;
  node: DevboxConfig & { provision: ProvisionRecord };
  attachedSessions: string[];
  now: number;
}

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export function idempotencyKey(nodeId: string, kind: NodeEmailKind, n?: number): string {
  const suffix = kind === "reminder" || kind === "idle" ? `${kind}-${n ?? 1}` : kind;
  return `naught-${nodeId}-${suffix}`;
}

export function formatUptime(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function estimatedCost(provision: ProvisionRecord, now: number): number {
  const start = provision.startedAt;
  if (!start) return 0;
  const end = provision.terminatedAt ?? now;
  return (Math.max(0, end - start) / 3_600_000) * provision.hourlyUsd;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function describeSpec(provision: ProvisionRecord): string {
  const gpu = provision.gpu
    ? `${provision.gpuCount > 1 ? `${provision.gpuCount}× ` : ""}${provision.gpu}`
    : "CPU only";
  return `${gpu} · ${provision.cpu} vCPU · ${provision.memoryGb} GB`;
}

export function renderNodeEmail(input: NodeEmailInput): { subject: string; text: string } {
  const { node, kind, now } = input;
  const p = node.provision;
  const uptime = p.startedAt ? formatUptime((p.terminatedAt ?? now) - p.startedAt) : "0 min";
  const cost = money(estimatedCost(p, now));
  const sessions = input.attachedSessions.length
    ? input.attachedSessions.map((name) => `  - ${name}`).join("\n")
    : "  (none attached)";
  const stop = [
    "To stop it:",
    "  - Naught → Settings → Devboxes → Terminate",
    `  - or from any session: naught node terminate ${node.id}`,
  ].join("\n");
  const header = [
    `Node: ${node.name} (${node.id})`,
    `Provider: ${p.provider}`,
    `Spec: ${describeSpec(p)}`,
    `Rate: ${money(p.hourlyUsd)}/hr est.`,
    p.startedAt ? `Billing started: ${new Date(p.startedAt).toISOString()}` : "Billing not started",
    `Uptime: ${uptime}`,
    `Cost so far: ${cost} est.`,
    `Sessions attached:\n${sessions}`,
  ].join("\n");

  switch (kind) {
    case "started":
      return {
        subject: `[Naught] ${node.name} is live: ${describeSpec(p)} at ${money(p.hourlyUsd)}/hr est.`,
        text: `Billing started for a node Naught provisioned.\n\n${header}\n\n${stop}\n`,
      };
    case "reminder":
      return {
        subject: `[Naught] ${node.name} still live after ${uptime} (${cost} est.)`,
        text: `Reminder ${input.n ?? 1}: this node is still running and billing.\n\n${header}\n\n${stop}\n`,
      };
    case "idle":
      return {
        subject: `[Naught] ${node.name} has been idle for ${formatUptime(now - p.lastActivityAt)} (${cost} est.)`,
        text: `No session has used this node for ${formatUptime(now - p.lastActivityAt)}. It is still billing.\n\n${header}\n\n${stop}\n`,
      };
    case "terminated":
      return {
        subject: `[Naught] ${node.name} terminated after ${uptime} (${cost} est.)`,
        text: `This node is gone (${p.terminateReason || "terminated"}). Final figures:\n\n${header}\n`,
      };
  }
}

export interface SendResult {
  sent: boolean;
  id?: string;
  skipped?: "no-recipient" | "no-api-key";
}

export async function sendNodeEmail(
  input: NodeEmailInput & { config: ComputeNotifications; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!input.config.to) return { sent: false, skipped: "no-recipient" };
  if (!input.apiKey) return { sent: false, skipped: "no-api-key" };
  const { subject, text } = renderNodeEmail(input);
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey(input.node.id, input.kind, input.n),
    },
    body: JSON.stringify({
      from: input.config.from,
      to: [input.config.to],
      subject,
      text,
      tags: [{ name: "naught", value: input.kind }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Resend ${response.status}: ${detail || response.statusText}`);
  }
  const body: any = await response.json().catch(() => ({}));
  return { sent: true, id: typeof body?.id === "string" ? body.id : undefined };
}

/** A plain test message from Settings. */
export async function sendTestEmail(
  config: ComputeNotifications,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!config.to) return { sent: false, skipped: "no-recipient" };
  if (!apiKey) return { sent: false, skipped: "no-api-key" };
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject: "[Naught] Test email",
      text: "Naught can reach you here. Node billing emails will arrive at this address.\n",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Resend ${response.status}: ${detail || response.statusText}`);
  }
  const body: any = await response.json().catch(() => ({}));
  return { sent: true, id: typeof body?.id === "string" ? body.id : undefined };
}
