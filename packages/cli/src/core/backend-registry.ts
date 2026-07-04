import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { DiscoveryResult, type DiscoveryResult as DiscoveryResultType } from "./types.js";

const exec = promisify(execFile);

export const CliBackendId = z.enum(["codex", "claude", "pi", "agy"]);
export type CliBackendId = z.infer<typeof CliBackendId>;

export const CliBackendSelection = z.object({
  provider: CliBackendId,
  binary: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
});
export type CliBackendSelection = z.infer<typeof CliBackendSelection>;

export type CliBackendDefinition = {
  id: CliBackendId;
  label: string;
  defaultBinary: string;
  defaultArgs: string[];
  promptMode: "stdin" | "arg";
  modelArg: string;
  modelQueryCommands: string[][];
};

export type BinaryResolution = {
  input: string;
  resolvedPath?: string;
  status: "resolved" | "missing";
  explicitPath: boolean;
  reason?: string;
};

export type BackendModel = {
  id: string;
  source: "binary";
};

export type BackendModelList = {
  provider: CliBackendId;
  binary: string;
  models: BackendModel[];
  sourceCommand: string;
};

export type BackendValidationResult = {
  selection: CliBackendSelection;
  binary: BinaryResolution;
  modelList?: BackendModelList;
  configPatch: Record<string, unknown>;
  warnings: string[];
};

export type CommandRunner = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const BACKENDS: Record<CliBackendId, CliBackendDefinition> = {
  codex: {
    id: "codex",
    label: "Codex",
    defaultBinary: "codex",
    defaultArgs: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never"],
    promptMode: "stdin",
    modelArg: "--model",
    modelQueryCommands: [
      ["models", "--json"],
      ["models", "list", "--json"],
      ["models"],
      ["model", "list"],
    ],
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    defaultBinary: "claude",
    // Non-interactive claude auto-denies Write/Bash permission prompts, so
    // workers report blocked without --dangerously-skip-permissions. Same
    // tradeoff as agy: ownership checks and worktrees are the containment.
    defaultArgs: ["--print", "--dangerously-skip-permissions"],
    promptMode: "arg",
    modelArg: "--model",
    modelQueryCommands: [
      ["models", "--json"],
      ["models", "list", "--json"],
      ["models"],
      ["model", "list"],
    ],
  },
  pi: {
    id: "pi",
    label: "Pi",
    defaultBinary: "pi",
    defaultArgs: ["--print", "--no-session"],
    promptMode: "arg",
    modelArg: "--model",
    modelQueryCommands: [["--list-models"]],
  },
  agy: {
    id: "agy",
    label: "Agy",
    defaultBinary: "agy",
    // Without --add-dir, agy works in its own scratch workspace
    // (~/.gemini/antigravity-cli/scratch) and reports cwd writes that never
    // happened there. {workspace} is substituted with the absolute workspace
    // at spawn time. Writes need --dangerously-skip-permissions in print mode;
    // SLAD's ownership checks and worktrees are the containment.
    defaultArgs: ["--dangerously-skip-permissions", "--add-dir", "{workspace}", "--print"],
    promptMode: "arg",
    modelArg: "--model",
    // `agy models` prints one display name per line ("Gemini 3.5 Flash (Low)");
    // those full names are what --model accepts.
    modelQueryCommands: [["models"]],
  },
};

function defaultRunner(file: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return exec(file, args, { timeout: opts.timeout })
    .then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

function isPathLike(input: string): boolean {
  return path.isAbsolute(input) || input.includes("/") || (path.sep === "\\" && input.includes("\\"));
}

function executableAccess(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(binary: string): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`);
      if (executableAccess(candidate)) return candidate;
    }
  }
  return undefined;
}

function nvmNodeVersionsDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".nvm", "versions", "node");
}

function parseNvmVersionName(name: string): number[] {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(name);
  if (!match) return [-1, -1, -1];
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

function compareNvmVersionDirsDesc(a: string, b: string): number {
  const left = parseNvmVersionName(a);
  const right = parseNvmVersionName(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? -1) - (left[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function resolveFromNvm(binary: string): string | undefined {
  const versionsDir = nvmNodeVersionsDir();
  if (!fs.existsSync(versionsDir)) return undefined;

  const candidates = new Set<string>();
  const versionEntries = fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => compareNvmVersionDirsDesc(a.name, b.name));

  for (const entry of versionEntries) {
    if (!entry.isDirectory()) continue;
    candidates.add(path.join(versionsDir, entry.name, "bin", binary));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && executableAccess(candidate)) return candidate;
  }
  return undefined;
}

const binaryFallbackResolvers = [resolveFromNvm];

function resolveFromFallbacks(binary: string): string | undefined {
  for (const resolver of binaryFallbackResolvers) {
    const resolvedPath = resolver(binary);
    if (resolvedPath) return resolvedPath;
  }
  return undefined;
}

function assertExplicitPathExecutable(input: string): string {
  const resolvedPath = path.resolve(input);
  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`No se puede persistir el binario "${input}": la ruta no existe.`, {
      binary: input,
      resolvedPath,
    });
  }
  if (!executableAccess(resolvedPath)) {
    throw new ConfigError(`No se puede persistir el binario "${input}": la ruta no es ejecutable.`, {
      binary: input,
      resolvedPath,
    });
  }
  return resolvedPath;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function collectModelIds(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const model = value.trim();
    if (model) out.add(model);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelIds(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const direct = record.id ?? record.name ?? record.model;
  if (typeof direct === "string" && direct.trim()) out.add(direct.trim());

  for (const key of ["models", "data", "items"]) {
    if (key in record) collectModelIds(record[key], out);
  }
}

export function parseModelList(stdout: string): BackendModel[] {
  const text = stripAnsi(stdout).trim();
  const ids = new Set<string>();

  if (text) {
    try {
      collectModelIds(JSON.parse(text), ids);
    } catch {
      // Tables headed "provider  model  \u2026" (pi --list-models) identify models
      // as provider/model pairs; plain lists use the first column as the id.
      const providerModelTable = /^provider\s{2,}model\b/i.test(text.split(/\r?\n/)[0] ?? "");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine
          .trim()
          .replace(/^[*\-\u2022]\s*/, "")
          .replace(/^\d+[.)]\s*/, "");
        if (!line || /^available models:?$/i.test(line) || /^id\s+/i.test(line) || /^provider\s+/i.test(line)) continue;
        const columns = line.split(/\s{2,}|\t|\|/).map((c) => c.trim());
        if (providerModelTable && columns[0] && columns[1]) {
          ids.add(`${columns[0]}/${columns[1]}`);
        } else if (columns[0]) {
          ids.add(columns[0]);
        }
      }
    }
  }

  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, source: "binary" as const }));
}

export function listSupportedBackends(): CliBackendDefinition[] {
  return Object.values(BACKENDS).map((backend) => ({ ...backend, defaultArgs: [...backend.defaultArgs] }));
}

export function getCliBackend(provider: CliBackendId | string): CliBackendDefinition {
  const id = CliBackendId.parse(provider);
  const backend = BACKENDS[id];
  return { ...backend, defaultArgs: [...backend.defaultArgs], modelQueryCommands: backend.modelQueryCommands.map((args) => [...args]) };
}

export function resolveBackendBinary(provider: CliBackendId | string, binary?: string): BinaryResolution {
  const backend = getCliBackend(provider);
  const input = (binary?.trim() || backend.defaultBinary);
  const explicitPath = isPathLike(input);

  if (explicitPath) {
    return {
      input,
      resolvedPath: assertExplicitPathExecutable(input),
      status: "resolved",
      explicitPath,
    };
  }

  const resolvedPath = resolveFromPath(input);
  if (resolvedPath) {
    return { input, resolvedPath, status: "resolved", explicitPath };
  }

  const fallbackPath = resolveFromFallbacks(input);
  if (fallbackPath) {
    return { input, resolvedPath: fallbackPath, status: "resolved", explicitPath };
  }

  return {
    input,
    status: "missing",
    explicitPath,
    reason: `No se encontró "${input}" en PATH ni en ~/.nvm/versions/node/*/bin.`,
  };
}

export async function discoverBackendBinaries(
  providers: CliBackendId[] = ["codex", "claude", "pi", "agy"],
): Promise<DiscoveryResultType> {
  const candidates = [];

  for (const provider of providers) {
    const backend = getCliBackend(provider);
    const resolution = resolveBackendBinary(provider);
    if (resolution.status !== "resolved" || !resolution.resolvedPath) continue;

    let version = "unknown";
    try {
      const result = await defaultRunner(resolution.resolvedPath, ["--version"], { timeout: 800 });
      version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.slice(0, 80) || "unknown";
    } catch {
      version = "unknown";
    }

    candidates.push({
      binary: backend.defaultBinary,
      resolvedPath: resolution.resolvedPath,
      version,
      evidence: ["path:found", `provider:${provider}`],
      confidenceScore: 0.9,
      conflicts: [],
    });
  }

  return DiscoveryResult.parse({
    candidates,
    selected: candidates[0],
    pathHash: "0".repeat(64),
    status: candidates.length > 0 ? "resolved" : "empty",
  });
}

export async function listBackendModels(
  provider: CliBackendId | string,
  opts: { binary?: string; runner?: CommandRunner; timeoutMs?: number } = {},
): Promise<BackendModelList> {
  const backend = getCliBackend(provider);
  const resolution = resolveBackendBinary(backend.id, opts.binary);
  if (resolution.status !== "resolved" || !resolution.resolvedPath) {
    throw new ConfigError(
      `No se pudieron consultar modelos para ${backend.label}: ${resolution.reason ?? "no hay binario ejecutable."}`,
      { provider: backend.id, binary: resolution.input },
    );
  }

  const runner = opts.runner ?? defaultRunner;
  const errors: string[] = [];

  for (const args of backend.modelQueryCommands) {
    try {
      const result = await runner(resolution.resolvedPath, args, { timeout: opts.timeoutMs ?? 5_000 });
      const models = parseModelList(result.stdout || result.stderr);
      if (models.length > 0) {
        return {
          provider: backend.id,
          binary: resolution.resolvedPath,
          models,
          sourceCommand: `${resolution.resolvedPath} ${args.join(" ")}`,
        };
      }
      errors.push(`${args.join(" ")}: no devolvió modelos parseables`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${args.join(" ")}: ${message}`);
    }
  }

  throw new ConfigError(
    `No se pudieron consultar modelos para ${backend.label}. Ejecutá "${backend.defaultBinary} models" o ingresá un modelo manualmente.`,
    { provider: backend.id, binary: resolution.resolvedPath, attempts: errors },
  );
}

export function serializeBackendSelectionToConfigPatch(
  selection: CliBackendSelection,
  binary?: BinaryResolution,
): Record<string, unknown> {
  const backend = getCliBackend(selection.provider);
  const providers: Record<string, unknown> = {
    defaultProvider: "cli",
    defaultAgent: backend.id,
    models: { cli: selection.model },
    agentModels: { [backend.id]: selection.model },
  };

  if (binary?.status === "resolved" && binary.resolvedPath) {
    providers.binaries = { [backend.id]: binary.resolvedPath };
  }

  return { providers };
}

export async function validateBackendSelection(
  rawSelection: CliBackendSelection,
  opts: { runner?: CommandRunner; timeoutMs?: number } = {},
): Promise<BackendValidationResult> {
  const selection = CliBackendSelection.parse(rawSelection);
  const backend = getCliBackend(selection.provider);
  const binary = resolveBackendBinary(backend.id, selection.binary);
  const warnings: string[] = [];
  let modelList: BackendModelList | undefined;

  if (binary.status === "resolved") {
    modelList = await listBackendModels(backend.id, {
      binary: binary.resolvedPath,
      runner: opts.runner,
      timeoutMs: opts.timeoutMs,
    });
    const availableModels = new Set(modelList.models.map((model) => model.id));
    if (!availableModels.has(selection.model)) {
      throw new ConfigError(`El modelo "${selection.model}" no está disponible para ${backend.label}.`, {
        provider: backend.id,
        binary: binary.resolvedPath,
        availableModels: modelList.models.map((model) => model.id),
      });
    }
  } else {
    warnings.push(
      `No hay binario ejecutable para ${backend.label}; se persistirá provider + model y se omitirá binary.`,
    );
  }

  return {
    selection,
    binary,
    modelList,
    configPatch: serializeBackendSelectionToConfigPatch(selection, binary),
    warnings,
  };
}

export function backendEnvPatch(provider: CliBackendId | string, model?: string, binary?: string): NodeJS.ProcessEnv {
  const backend = getCliBackend(provider);
  const env: NodeJS.ProcessEnv = {
    SLAD_DEFAULT_PROVIDER: "cli",
    SLAD_DEFAULT_AGENT: backend.id,
    SLAD_CLI_BINARY: binary?.trim() || backend.defaultBinary,
    SLAD_CLI_ARGS: backend.defaultArgs.join(" "),
    SLAD_CLI_PROMPT_MODE: backend.promptMode,
    SLAD_CLI_MODEL_ARG: backend.modelArg,
  };
  if (model?.trim()) env.CLI_MODEL = model.trim();
  if (backend.id === "codex" && !model?.trim()) env.CLI_MODEL = "";
  return env;
}
