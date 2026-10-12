import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { LinearTicket, LinearConfig } from "../types";

import { homedir } from "os";

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

function getConfigFile(): string {
  return join(getLaunchCwd(), ".openui-desktop", "config.json");
}

function getEnvFile(): string {
  return join(getLaunchCwd(), ".openui-desktop", ".env");
}

function loadEnvFile(): Record<string, string> {
  try {
    if (existsSync(getEnvFile())) {
      const content = readFileSync(getEnvFile(), "utf-8");
      const vars: Record<string, string> = {};
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            let value = valueParts.join("=");
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            vars[key.trim()] = value;
          }
        }
      }
      return vars;
    }
  } catch (e) {
    console.error("Failed to load .env file:", e);
  }
  return {};
}

function saveEnvFile(apiKey: string): void {
  try {
    const dir = join(getLaunchCwd(), ".openui-desktop");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let content = "";
    if (existsSync(getEnvFile())) {
      const existing = readFileSync(getEnvFile(), "utf-8");
      const lines = existing.split("\n").filter(line => !line.trim().startsWith("LINEAR_API_KEY="));
      content = lines.join("\n");
      if (content && !content.endsWith("\n")) content += "\n";
    }

    if (apiKey) {
      content += `LINEAR_API_KEY="${apiKey}"\n`;
    }

    writeFileSync(getEnvFile(), content);
  } catch (e) {
    console.error("Failed to save .env file:", e);
  }
}

export function loadConfig(): LinearConfig {
  const envVars = loadEnvFile();
  const config: LinearConfig = {};

  config.apiKey = envVars.LINEAR_API_KEY || process.env.LINEAR_API_KEY;

  try {
    if (existsSync(getConfigFile())) {
      const fileConfig = JSON.parse(readFileSync(getConfigFile(), "utf-8"));
      config.defaultTeamId = fileConfig.defaultTeamId;
      config.defaultBaseBranch = fileConfig.defaultBaseBranch;
      config.createWorktree = fileConfig.createWorktree;
      config.ticketPromptTemplate = fileConfig.ticketPromptTemplate;
      config.autoCareful = fileConfig.autoCareful;
      config.initialPrompt = fileConfig.initialPrompt;
      config.defaultStartingDirectory = fileConfig.defaultStartingDirectory;
      config.rememberLastDirectory = fileConfig.rememberLastDirectory;
      config.defaultAgentId = fileConfig.defaultAgentId;
      config.devboxes = Array.isArray(fileConfig.devboxes) ? fileConfig.devboxes : undefined;
    }
  } catch (e) {
    console.error("Failed to load config:", e);
  }

  return config;
}

export function saveConfig(config: LinearConfig): void {
  if (config.apiKey !== undefined) {
    saveEnvFile(config.apiKey);
  }

  try {
    const dir = join(getLaunchCwd(), ".openui-desktop");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const fileConfig = {
      defaultTeamId: config.defaultTeamId,
      defaultBaseBranch: config.defaultBaseBranch,
      createWorktree: config.createWorktree,
      ticketPromptTemplate: config.ticketPromptTemplate,
      autoCareful: config.autoCareful,
      initialPrompt: config.initialPrompt,
      defaultStartingDirectory: config.defaultStartingDirectory,
      rememberLastDirectory: config.rememberLastDirectory,
      defaultAgentId: config.defaultAgentId,
      devboxes: config.devboxes,
    };
    writeFileSync(getConfigFile(), JSON.stringify(fileConfig, null, 2));
  } catch (e) {
    console.error("Failed to save config:", e);
  }
}

const LINEAR_API = "https://api.linear.app/graphql";

async function linearQuery(apiKey: string, query: string, variables?: any) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API error: ${res.status}`);
  }

  const data: any = await res.json();
  if (data.errors) {
    throw new Error(data.errors[0]?.message || "Linear API error");
  }

  return data.data;
}

export async function fetchTeams(apiKey: string) {
  const query = `query { teams { nodes { id name key } } }`;
  const data = await linearQuery(apiKey, query);
  return data.teams.nodes;
}

export async function fetchMyTickets(apiKey: string, teamId?: string): Promise<LinearTicket[]> {
  const filterParts = [
    'state: { type: { nin: ["completed", "canceled"] } }',
  ];
  if (teamId) {
    filterParts.push(`team: { id: { eq: "${teamId}" } }`);
  }

  const query = `
    query {
      issues(
        filter: { ${filterParts.join(", ")} }
        first: 50
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title url priority
          state { name color }
          assignee { name }
          team { name key }
        }
      }
    }
  `;

  const data = await linearQuery(apiKey, query);
  return data.issues.nodes;
}

export async function searchTickets(apiKey: string, searchTerm: string, teamId?: string): Promise<LinearTicket[]> {
  const filterParts = ['state: { type: { nin: ["completed", "canceled"] } }'];
  if (teamId) {
    filterParts.push(`team: { id: { eq: "${teamId}" } }`);
  }

  const query = `
    query($searchTerm: String!) {
      issueSearch(
        query: $searchTerm
        filter: { ${filterParts.join(", ")} }
        first: 20
      ) {
        nodes {
          id identifier title url priority
          state { name color }
          assignee { name }
          team { name key }
        }
      }
    }
  `;
  const data = await linearQuery(apiKey, query, { searchTerm });
  return data.issueSearch.nodes;
}

export async function fetchTicketByIdentifier(apiKey: string, identifier: string): Promise<LinearTicket | null> {
  try {
    const searchQuery = `
      query($term: String!) {
        issueSearch(query: $term, first: 1) {
          nodes {
            id identifier title url priority
            state { name color }
            assignee { name }
            team { name key }
          }
        }
      }
    `;
    const data = await linearQuery(apiKey, searchQuery, { term: identifier });
    return data.issueSearch.nodes[0] || null;
  } catch {
    return null;
  }
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await linearQuery(apiKey, `query { viewer { id name } }`);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentUser(apiKey: string) {
  const data = await linearQuery(apiKey, `query { viewer { id name email } }`);
  return data.viewer;
}
