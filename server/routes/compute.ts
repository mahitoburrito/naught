import { Hono } from "hono";
import type { ProviderId, ProvisionRequester } from "../types";
import { resolveSecret, updateEnvValue } from "../services/secrets";
import { sendTestEmail } from "../services/compute/notify";
import {
  approveNode,
  denyNode,
  getComputeConfig,
  getNode,
  listNodes,
  liveHourlyUsd,
  liveNodes,
  pendingNodes,
  providerRegistry,
  requestNode,
  saveComputeConfig,
  terminateNode,
} from "../services/compute/nodes";

export const computeRoutes = new Hono();

const PROVIDER_IDS: ProviderId[] = ["modal", "thunder"];

function failure(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function providerId(value: string): ProviderId | null {
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : null;
}

async function describeProvider(id: ProviderId) {
  const provider = providerRegistry()[id];
  const configured = provider ? await provider.configured() : { ok: false, detail: "unavailable" };
  const stored = id === "modal"
    ? !!resolveSecret("MODAL_TOKEN_ID", { env: {} }) && !!resolveSecret("MODAL_TOKEN_SECRET", { env: {} })
    : !!resolveSecret("TNR_API_TOKEN", { env: {} });
  return { id, ok: configured.ok, source: configured.source, detail: configured.detail, storedInNaught: stored };
}

// ─── providers ─────────────────────────────────────────────────────────────

computeRoutes.get("/providers", async (c) => {
  const providers = await Promise.all(PROVIDER_IDS.map(describeProvider));
  return c.json({ providers });
});

computeRoutes.put("/providers/:id/key", async (c) => {
  const id = providerId(c.req.param("id"));
  if (!id) return c.json({ error: "Unknown provider" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    if (id === "modal") {
      const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
      const tokenSecret = typeof body.tokenSecret === "string" ? body.tokenSecret.trim() : "";
      if (!tokenId || !tokenSecret) return c.json({ error: "Modal needs both a token id and a token secret." }, 400);
      updateEnvValue("MODAL_TOKEN_ID", tokenId);
      updateEnvValue("MODAL_TOKEN_SECRET", tokenSecret);
    } else {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return c.json({ error: "A Thunder API token is required." }, 400);
      updateEnvValue("TNR_API_TOKEN", token);
    }
    return c.json({ provider: await describeProvider(id) });
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});

computeRoutes.delete("/providers/:id/key", async (c) => {
  const id = providerId(c.req.param("id"));
  if (!id) return c.json({ error: "Unknown provider" }, 404);
  if (id === "modal") {
    updateEnvValue("MODAL_TOKEN_ID", "");
    updateEnvValue("MODAL_TOKEN_SECRET", "");
  } else {
    updateEnvValue("TNR_API_TOKEN", "");
  }
  return c.json({ provider: await describeProvider(id) });
});

computeRoutes.post("/providers/:id/test", async (c) => {
  const id = providerId(c.req.param("id"));
  if (!id) return c.json({ error: "Unknown provider" }, 404);
  const provider = providerRegistry()[id];
  if (!provider) return c.json({ ok: false, message: "Provider unavailable" });
  return c.json(await provider.test());
});

computeRoutes.get("/offers", async (c) => {
  const requested = c.req.query("provider");
  const ids = requested ? [providerId(requested)].filter((id): id is ProviderId => !!id) : PROVIDER_IDS;
  if (requested && ids.length === 0) return c.json({ error: "Unknown provider" }, 404);
  const offers: unknown[] = [];
  const errors: Array<{ provider: ProviderId; error: string }> = [];
  for (const id of ids) {
    const provider = providerRegistry()[id];
    if (!provider) {
      errors.push({ provider: id, error: "unavailable" });
      continue;
    }
    const configured = await provider.configured();
    if (!configured.ok) {
      errors.push({ provider: id, error: configured.detail || "not configured" });
      continue;
    }
    try {
      offers.push(...(await provider.offers()));
    } catch (error) {
      errors.push({ provider: id, error: failure(error) });
    }
  }
  if (requested && offers.length === 0 && errors.length) return c.json({ error: errors[0].error, errors }, 502);
  return c.json({ offers, errors });
});

// ─── nodes ─────────────────────────────────────────────────────────────────

function summary() {
  return { nodes: listNodes(), live: liveNodes().length, pending: pendingNodes().length, hourlyUsd: liveHourlyUsd() };
}

computeRoutes.get("/nodes", (c) => c.json(summary()));

computeRoutes.post("/nodes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const requestedBy: ProvisionRequester =
    body?.requestedBy?.kind === "session" && typeof body.requestedBy.sessionId === "string"
      ? { kind: "session", sessionId: body.requestedBy.sessionId }
      : { kind: "user" };
  try {
    const result = await requestNode(body, requestedBy);
    if (result.pending) return c.json({ node: result.node, pending: true, reasons: result.reasons }, 202);
    return c.json({ node: result.node }, 201);
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});

computeRoutes.get("/nodes/:id", (c) => {
  const node = getNode(c.req.param("id"));
  if (!node) return c.json({ error: "Node not found" }, 404);
  return c.json({ node });
});

computeRoutes.post("/nodes/:id/approve", async (c) => {
  const node = await approveNode(c.req.param("id"));
  if (!node) return c.json({ error: "Node not found" }, 404);
  return c.json({ node });
});

computeRoutes.post("/nodes/:id/deny", async (c) => {
  const node = await denyNode(c.req.param("id"));
  if (!node) return c.json({ error: "Node not found" }, 404);
  return c.json({ node });
});

computeRoutes.delete("/nodes/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reason = body?.requestedBy?.kind === "session" ? "agent" : "user";
  try {
    const node = await terminateNode(c.req.param("id"), reason);
    if (!node) return c.json({ error: "Node not found" }, 404);
    return c.json({ ok: node.provision.status === "terminated", node });
  } catch (error) {
    return c.json({ error: failure(error) }, 500);
  }
});

// ─── settings ──────────────────────────────────────────────────────────────

computeRoutes.get("/policy", (c) => c.json({ policy: getComputeConfig().policy }));

computeRoutes.put("/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = getComputeConfig();
  const saved = saveComputeConfig({ ...current, policy: { ...current.policy, ...(body?.policy ?? body) } });
  return c.json({ policy: saved.policy });
});

function notificationsView() {
  const config = getComputeConfig();
  return { notifications: config.notifications, hasResendKey: !!resolveSecret("RESEND_API_KEY") };
}

computeRoutes.get("/notifications", (c) => c.json(notificationsView()));

computeRoutes.put("/notifications", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    if (typeof body.resendApiKey === "string") updateEnvValue("RESEND_API_KEY", body.resendApiKey.trim());
    const current = getComputeConfig();
    const { resendApiKey: _ignored, ...rest } = body;
    saveComputeConfig({ ...current, notifications: { ...current.notifications, ...(rest.notifications ?? rest) } });
    return c.json(notificationsView());
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});

computeRoutes.post("/notifications/test", async (c) => {
  try {
    const result = await sendTestEmail(getComputeConfig().notifications, resolveSecret("RESEND_API_KEY")?.value);
    return c.json(result);
  } catch (error) {
    return c.json({ sent: false, error: failure(error) }, 502);
  }
});

function credentialsView() {
  return {
    hasClaudeToken: !!resolveSecret("CLAUDE_CODE_OAUTH_TOKEN", { env: {} }),
    hasOpenAiKey: !!resolveSecret("OPENAI_API_KEY", { env: {} }),
    syncCodexAuth: getComputeConfig().nodeCredentials.syncCodexAuth,
  };
}

computeRoutes.get("/node-credentials", (c) => c.json(credentialsView()));

computeRoutes.put("/node-credentials", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    if (typeof body.claudeToken === "string") updateEnvValue("CLAUDE_CODE_OAUTH_TOKEN", body.claudeToken.trim());
    if (typeof body.openAiKey === "string") updateEnvValue("OPENAI_API_KEY", body.openAiKey.trim());
    if (typeof body.syncCodexAuth === "boolean") {
      const current = getComputeConfig();
      saveComputeConfig({ ...current, nodeCredentials: { syncCodexAuth: body.syncCodexAuth } });
    }
    return c.json(credentialsView());
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});
