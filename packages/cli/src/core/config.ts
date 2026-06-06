import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { AgentName, DevAgentConfig, ProviderName, type ProviderName as ProviderNameType } from "./types.js";
import { DEFAULT_AGENT_ID } from "@slad/shared";
import { backendEnvPatch, CliBackendId } from "./backend-registry.js";

const DEFAULT_MODELS: Record<ProviderNameType, string> = {
  anthropic: "MiniMax-M2.7",
  openai: "gpt-4o",
  gemini: "gemini-1.5-pro",
  cli: "",
};

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".slad", "config.json");
}

export function writeGlobalConfigPatch(
  patch: Record<string, unknown>,
  configPath = getGlobalConfigPath(),
): Record<string, unknown> {
  const existing = readJson(configPath);
  const next = deepMerge(existing, patch);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function settingsValue<T = unknown>(pathParts: string[], cwd = process.env.SLAD_WORKSPACE ?? process.cwd()): T | undefined {
  const globalOnlyKeys = new Set(["activeProfileId", "activeAgentId"]);
  const files = [
    getGlobalConfigPath(),
    ...(globalOnlyKeys.has(pathParts[0]!) ? [] : [path.join(cwd, ".slad-os", "config.json")]),
  ];
  let current: unknown;
  for (const file of files) {
    const root = readJson(file);
    let value: unknown = root;
    for (const part of pathParts) {
      if (!value || typeof value !== "object" || !(part in value)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (value !== undefined) current = value;
  }
  return current as T | undefined;
}

/**
 * Load environment variables from the project-level .env.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  const localEnv = path.join(cwd, ".env");

  if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv, override: true });
}

/**
 * Resolve config from environment variables.
 * CLI flags are still applied by callers before using these defaults.
 */
export function loadConfig(): DevAgentConfig {
  return DevAgentConfig.parse({
    defaultProvider: envValue("SLAD_DEFAULT_PROVIDER") ?? settingsValue(["providers", "defaultProvider"]),
    defaultAgent: envValue("SLAD_DEFAULT_AGENT") ?? settingsValue(["providers", "defaultAgent"]),
    wikiPath: envValue("SLAD_WIKI_PATH") ?? settingsValue(["paths", "wikiPath"]),
  });
}

/**
 * Pull the API key for a given provider from the environment.
 * Returns null if missing — commands decide how to handle it.
 */
export function getApiKey(provider: ProviderNameType): string | null {
  const configuredEnv = settingsValue<string>(["providers", "apiKeyEnv", provider]);
  if (configuredEnv) return envValue(configuredEnv) ?? null;
  switch (provider) {
    case "anthropic":
      return envValue("ANTHROPIC_API_KEY") ?? null;
    case "openai":
      return envValue("OPENAI_API_KEY") ?? null;
    case "gemini":
      return envValue("GEMINI_API_KEY") ?? envValue("GOOGLE_API_KEY") ?? null;
    case "cli":
      return null;
  }
}

/**
 * Resolve the model from environment variables.
 * Provider-specific vars win over the shared fallback.
 */
export function getModel(provider: ProviderNameType): string {
  const configured = settingsValue<string>(["providers", "models", provider]);
  switch (provider) {
    case "anthropic":
      return envValue("ANTHROPIC_MODEL") ?? envValue("SLAD_MODEL") ?? configured ?? DEFAULT_MODELS.anthropic;
    case "openai":
      return envValue("OPENAI_MODEL") ?? envValue("SLAD_MODEL") ?? configured ?? DEFAULT_MODELS.openai;
    case "gemini":
      return envValue("GEMINI_MODEL") ?? envValue("GOOGLE_MODEL") ?? envValue("SLAD_MODEL") ?? configured ?? DEFAULT_MODELS.gemini;
    case "cli":
      return envValue("CLI_MODEL") ?? configured ?? DEFAULT_MODELS.cli;
  }
}

export function resolveProvider(
  provider: string | undefined,
  agent: string | undefined,
  defaultProvider: ProviderNameType,
  defaultAgent?: string,
): ProviderNameType {
  // When defaultAgent is set (not an explicit --agent flag), configure the CLI
  // binary env vars so the run stage can use it, but keep the API provider for
  // the reasoning stages (explore, snapshot, plan, learn, evolve) that need getProvider().
  if (!agent && defaultAgent) {
    applyAgentEnv(AgentName.parse(defaultAgent));
    return ProviderName.parse(provider ?? defaultProvider);
  }

  if (!agent) {
    return ProviderName.parse(provider ?? defaultProvider);
  }

  const selectedAgent = AgentName.parse(agent);
  process.env.SLAD_DEFAULT_PROVIDER = "cli";
  applyAgentEnv(selectedAgent);
  return "cli";
}

function applyAgentEnv(agent: import("@slad/shared").AgentName): void {
  const configuredBinary = settingsValue<string>(["providers", "binaries", agent]);
  const configuredAgentModel = settingsValue<string>(["providers", "agentModels", agent]);
  const configuredCliModel = settingsValue<string>(["providers", "models", "cli"]);

  if (agent === "codex" || agent === "claude") {
    const model = envValue("CLI_MODEL") ?? configuredAgentModel ?? configuredCliModel ?? (agent === "claude" ? "sonnet" : undefined);
    const envPatch = backendEnvPatch(CliBackendId.parse(agent), model, configuredBinary);
    if (process.env.SLAD_CLI_INHERIT_API_KEYS) delete envPatch.SLAD_CLI_INHERIT_API_KEYS;
    Object.assign(process.env, envPatch);
    process.env.SLAD_CLI_INHERIT_API_KEYS ??= "false";
    return;
  }

  process.env.SLAD_CLI_MODEL_ARG = "--model";
  process.env.SLAD_CLI_INHERIT_API_KEYS ??= "false";
  switch (agent) {
    case "gemini":
      process.env.SLAD_CLI_BINARY = "gemini";
      process.env.SLAD_CLI_ARGS = "";
      process.env.SLAD_CLI_PROMPT_MODE = "";
      break;
    case "agent":
      process.env.SLAD_CLI_BINARY = "agent";
      process.env.SLAD_CLI_ARGS = "";
      process.env.SLAD_CLI_PROMPT_MODE = "arg";
      process.env.CLI_MODEL = "";
      break;
  }
}

export function parseCliDiscoveryAnswer(answer: string | undefined): string | null {
  if (!answer) return null;
  const value = answer.trim();
  if (!value) return null;
  if (!value.includes(" | ")) return value;

  const parts = value.split(" | ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[1]) return parts[1];
  return parts[0] ?? null;
}

/** The active agent id (global config), defaulting to the developer agent. */
export function getActiveAgentId(): string {
  return settingsValue<string>(["activeAgentId"]) ?? DEFAULT_AGENT_ID;
}

/** Persist the active agent id to the global config. */
export function setActiveAgentId(id: string): void {
  writeGlobalConfigPatch({ activeAgentId: id });
}

export function withPromptGuidance(stage: string, basePrompt: string): string {
  const activeProfileId = settingsValue<string>(["activeProfileId"]);
  if (!activeProfileId) return basePrompt;
  const profiles = settingsValue<Array<Record<string, unknown>>>(["profiles"]) ?? [];
  const profile = profiles.find((item) => item.id === activeProfileId);
  const promptGuidance = profile?.promptGuidance;
  if (!promptGuidance || typeof promptGuidance !== "object") return basePrompt;
  const guidance = (promptGuidance as Record<string, unknown>)[stage];
  if (typeof guidance !== "string" || !guidance.trim()) return basePrompt;
  return `${basePrompt}\n\nAdditional profile guidance for ${stage}:\n${guidance.trim()}`;
}
