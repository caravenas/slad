import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STAGE_NAMES, SladSettings, type SladSettings as SladSettingsType } from "@slad/shared";
import { SLAD_DOCS_ROOT, SLAD_ROOT, readTrustConfig, trustWorkspace } from "./slad-server";

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".slad", "config.json");
const PROJECT_CONFIG_PATH = path.join(SLAD_ROOT, ".slad-os", "config.json");
const PROJECT_HARNESS_PATH = path.join(SLAD_ROOT, ".slad-os", "harness.json");

const STAGES = STAGE_NAMES;

export const DEFAULT_PROFILES = [
  { id: "codex-best", label: "codex-best", agent: "codex", model: "gpt-5.5", promptGuidance: {} },
  { id: "codex-fast", label: "codex-fast", agent: "codex", model: "gpt-5.4-mini", promptGuidance: {} },
  { id: "codex-coding", label: "codex-coding", agent: "codex", model: "gpt-5.3-codex", promptGuidance: {} },
  { id: "gemini-best", label: "gemini-best", agent: "gemini", model: "gemini-3.1-pro-preview", promptGuidance: {} },
  { id: "gemini-tools", label: "gemini-tools", agent: "gemini", model: "gemini-3.1-pro-preview-customtools", promptGuidance: {} },
  { id: "gemini-fast", label: "gemini-fast", agent: "gemini", model: "gemini-3-flash-preview", promptGuidance: {} },
  { id: "gemini-cheap", label: "gemini-cheap", agent: "gemini", model: "gemini-3.1-flash-lite-preview", promptGuidance: {} },
  { id: "claude-best", label: "claude-best", agent: "claude", model: "opus", promptGuidance: {} },
  { id: "claude-code", label: "claude-code", agent: "claude", model: "sonnet", promptGuidance: {} },
  { id: "claude-fast", label: "claude-fast", agent: "claude", model: "haiku", promptGuidance: {} },
  { id: "agent", label: "agent", agent: "agent", promptGuidance: {} },
] satisfies SladSettingsType["profiles"];

export const BUILT_IN_PROMPTS = Object.fromEntries(
  STAGES.map((stage) => [
    stage,
    `Built-in ${stage} system prompt from packages/cli/src/agents/prompts.ts. Profile guidance is appended after this prompt.`,
  ]),
) as Record<(typeof STAGES)[number], string>;

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function uniqProfiles(profiles: SladSettingsType["profiles"]): SladSettingsType["profiles"] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

function mergeSettings(
  base: SladSettingsType,
  override: Record<string, unknown>,
): SladSettingsType {
  const parsed = SladSettings.partial().parse(override);
  const nextActiveProfileId = typeof override.activeProfileId === "string"
    ? override.activeProfileId
    : base.activeProfileId;
  return SladSettings.parse({
    ...base,
    ...parsed,
    activeProfileId: nextActiveProfileId,
    providers: { ...base.providers, ...parsed.providers },
    harness: { ...base.harness, ...parsed.harness },
    paths: { ...base.paths, ...parsed.paths },
    runtime: { ...base.runtime, ...parsed.runtime },
    profiles: uniqProfiles([...(parsed.profiles ?? []), ...base.profiles]),
  });
}

function baseSettings(): SladSettingsType {
  const trust = readTrustConfig();
  return SladSettings.parse({
    activeProfileId: "codex-best",
    profiles: DEFAULT_PROFILES,
    providers: {
      defaultProvider: "anthropic",
      models: {
        anthropic: process.env.ANTHROPIC_MODEL ?? process.env.SLAD_MODEL ?? "MiniMax-M2.7",
        openai: process.env.OPENAI_MODEL ?? process.env.SLAD_MODEL ?? "gpt-4o",
        gemini: process.env.GEMINI_MODEL ?? process.env.GOOGLE_MODEL ?? process.env.SLAD_MODEL ?? "gemini-1.5-pro",
        cli: process.env.CLI_MODEL ?? "",
      },
      apiKeyEnv: {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "GEMINI_API_KEY",
        cli: "",
      },
    },
    harness: readHarnessSettings(),
    paths: {
      docsPath: path.relative(SLAD_ROOT, SLAD_DOCS_ROOT) || SLAD_DOCS_ROOT,
      wikiPath: process.env.SLAD_WIKI_PATH,
      activeWorkspace: trust.activeWorkspace ?? SLAD_ROOT,
    },
    runtime: {
      apiTimeoutMs: Number.parseInt(process.env.SLAD_API_TIMEOUT_MS ?? "", 10) || undefined,
      cliTimeoutMs: Number.parseInt(process.env.SLAD_CLI_TIMEOUT_MS ?? "", 10) || undefined,
      cliInheritApiKeys: process.env.SLAD_CLI_INHERIT_API_KEYS === "true",
      cliArgs: {},
    },
  });
}

function readHarnessSettings(): SladSettingsType["harness"] {
  const raw = readJson(PROJECT_HARNESS_PATH);
  return SladSettings.parse({ harness: raw }).harness;
}

export function readSettings() {
  const globalRaw = readJson(GLOBAL_CONFIG_PATH);
  const projectRaw = { ...readJson(PROJECT_CONFIG_PATH) };
  delete projectRaw.activeProfileId;
  let effective = mergeSettings(baseSettings(), globalRaw);
  effective = mergeSettings(effective, projectRaw);
  const activeProfile = effective.profiles.find((profile) => profile.id === effective.activeProfileId)
    ?? effective.profiles[0];
  return {
    globalPath: GLOBAL_CONFIG_PATH,
    projectPath: PROJECT_CONFIG_PATH,
    harnessPath: PROJECT_HARNESS_PATH,
    builtInPrompts: BUILT_IN_PROMPTS,
    global: globalRaw,
    project: projectRaw,
    effective,
    activeProfile,
    validation: validateSettings(effective),
  };
}

export function writeSettings(settings: SladSettingsType): void {
  const parsed = SladSettings.parse(settings);
  const { activeProfileId, ...projectSettings } = parsed;
  const globalRaw = readJson(GLOBAL_CONFIG_PATH);
  fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    GLOBAL_CONFIG_PATH,
    JSON.stringify({ ...globalRaw, activeProfileId }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.dirname(PROJECT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(PROJECT_CONFIG_PATH, JSON.stringify(projectSettings, null, 2), "utf8");
  fs.writeFileSync(PROJECT_HARNESS_PATH, JSON.stringify(parsed.harness, null, 2), "utf8");
  if (parsed.paths.activeWorkspace) trustWorkspace(parsed.paths.activeWorkspace);
}

export function validateSettings(settings: SladSettingsType) {
  const apiKeys = Object.entries(settings.providers.apiKeyEnv).map(([provider, envName]) => ({
    provider,
    envName,
    present: envName ? Boolean(process.env[envName]) : provider === "cli",
  }));
  const profileIds = new Set<string>();
  const duplicateProfiles = settings.profiles
    .map((profile) => profile.id)
    .filter((id) => {
      if (profileIds.has(id)) return true;
      profileIds.add(id);
      return false;
    });
  const warnings: string[] = [];
  if (!settings.profiles.some((profile) => profile.id === settings.activeProfileId)) {
    warnings.push("Active profile does not match an existing profile.");
  }
  if (!settings.harness.allowedWritePaths.some((p) => p.includes("docs") || p.includes("src"))) {
    warnings.push("Harness allowedWritePaths does not include docs or src.");
  }
  return { apiKeys, duplicateProfiles, warnings };
}
