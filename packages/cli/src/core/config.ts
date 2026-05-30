import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { AgentName, DevAgentConfig, ProviderName, type ProviderName as ProviderNameType } from "./types.js";

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

function settingsValue<T = unknown>(pathParts: string[], cwd = process.env.SLAD_WORKSPACE ?? process.cwd()): T | undefined {
  const files = [
    path.join(os.homedir(), ".slad", "config.json"),
    ...(pathParts[0] === "activeProfileId" ? [] : [path.join(cwd, ".slad-os", "config.json")]),
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
  process.env.SLAD_CLI_MODEL_ARG = "--model";
  process.env.SLAD_CLI_INHERIT_API_KEYS ??= "false";
  switch (agent) {
    case "codex":
      process.env.SLAD_CLI_BINARY = "codex";
      process.env.SLAD_CLI_ARGS = "exec --skip-git-repo-check --sandbox workspace-write --color never";
      process.env.SLAD_CLI_PROMPT_MODE = "stdin";
      process.env.CLI_MODEL = "";
      break;
    case "claude":
      process.env.SLAD_CLI_BINARY = "claude";
      process.env.SLAD_CLI_ARGS = "--print";
      process.env.SLAD_CLI_PROMPT_MODE = "arg";
      if (!envValue("CLI_MODEL")) process.env.CLI_MODEL = "sonnet";
      break;
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
