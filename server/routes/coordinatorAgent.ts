import { Hono } from "hono";
import {
  DEFAULT_COORDINATOR_MODEL,
  loadCoordinatorAgentConfig,
  resolveCoordinatorCredentials,
  saveCoordinatorAgentConfig,
} from "../services/coordinatorAgentConfig";

export const coordinatorAgentRoutes = new Hono();

function describeConfig() {
  const config = loadCoordinatorAgentConfig();
  const credentials = resolveCoordinatorCredentials(config);
  return {
    hasApiKey: !!credentials.apiKey,
    source: credentials.source,
    model: config.model || DEFAULT_COORDINATOR_MODEL,
  };
}

coordinatorAgentRoutes.get("/config", (c) => c.json(describeConfig()));

// POST { apiKey } saves a key; an empty string removes the saved key so the
// environment key (if any) applies again.
coordinatorAgentRoutes.post("/config", async (c) => {
  const body = (await c.req.json()) as { apiKey?: unknown; model?: unknown };
  const config = loadCoordinatorAgentConfig();
  if (typeof body.apiKey === "string") config.apiKey = body.apiKey.trim();
  if (typeof body.model === "string") config.model = body.model.trim();
  saveCoordinatorAgentConfig(config);
  return c.json(describeConfig());
});
