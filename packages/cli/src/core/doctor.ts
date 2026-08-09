import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DoctorReport,
  RunManifest,
  type DoctorCheck,
  type DoctorReport as DoctorReportValue,
  type DoctorStatus,
} from "@slad/shared";
import { listSupportedBackends, type CliBackendDefinition } from "./backend-registry.js";

const defaultExecFile = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_RECENT_MANIFEST_LIMIT = 5;

type ExecResult = { stdout: string; stderr: string };

type DoctorExec = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ExecResult>;

type DoctorFs = {
  access(filePath: string, mode?: number): Promise<void>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  readdir(filePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  stat(filePath: string): Promise<{ isDirectory(): boolean; mtimeMs: number }>;
};

export type RunDoctorOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  recentManifestLimit?: number;
  fs?: DoctorFs;
  exec?: DoctorExec;
};

type CommandOutcome =
  | { status: "ok"; stdout: string; stderr: string }
  | { status: "timeout"; message: string }
  | { status: "error"; message: string };

const nodeFs: DoctorFs = {
  access: fs.access,
  readFile: fs.readFile,
  readdir: async (filePath) => fs.readdir(filePath),
  stat: fs.stat,
};

async function nodeExec(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecResult> {
  const { stdout, stderr } = await defaultExecFile(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function check(name: string, status: DoctorStatus, message: string, options: {
  evidence?: string[];
  recommendation?: string;
} = {}): DoctorCheck {
  return {
    name,
    status,
    message,
    blocking: status === "blocked",
    ...(options.evidence && options.evidence.length > 0 ? { evidence: options.evidence } : {}),
    ...(options.recommendation ? { recommendation: options.recommendation } : {}),
  };
}

function aggregate(checks: DoctorCheck[]): DoctorReportValue {
  const summary = {
    passed: checks.filter((item) => item.status === "healthy").length,
    warnings: checks.filter((item) => item.status === "warning").length,
    blockers: checks.filter((item) => item.status === "blocked").length,
  };
  const status: DoctorStatus = summary.blockers > 0 ? "blocked" : summary.warnings > 0 ? "warning" : "healthy";
  return DoctorReport.parse({ status, summary, checks });
}

function isExecutablePath(input: string): boolean {
  return path.isAbsolute(input) || input.includes("/") || (path.sep === "\\" && input.includes("\\"));
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function pathextEntries(env: NodeJS.ProcessEnv): string[] {
  return process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
}

async function canAccess(fsImpl: DoctorFs, filePath: string, mode?: number): Promise<boolean> {
  try {
    await fsImpl.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(binary: string, deps: { fs: DoctorFs; env: NodeJS.ProcessEnv; cwd: string }): Promise<string | undefined> {
  const input = binary.trim();
  if (!input) return undefined;
  if (isExecutablePath(input)) {
    const resolved = path.resolve(deps.cwd, input);
    return await canAccess(deps.fs, resolved, fsConstants.X_OK) ? resolved : undefined;
  }

  for (const dir of pathEntries(deps.env)) {
    for (const ext of pathextEntries(deps.env)) {
      const candidate = path.join(dir, `${input}${ext}`);
      if (await canAccess(deps.fs, candidate, fsConstants.X_OK)) return candidate;
    }
  }

  const home = deps.env.HOME || os.homedir();
  const versionsDir = path.join(home, ".nvm", "versions", "node");
  let versions: string[];
  try {
    versions = await deps.fs.readdir(versionsDir);
  } catch {
    return undefined;
  }
  for (const version of versions.sort().reverse()) {
    const candidate = path.join(versionsDir, version, "bin", input);
    if (await canAccess(deps.fs, candidate, fsConstants.X_OK)) return candidate;
  }
  return undefined;
}

async function runCommand(
  execImpl: DoctorExec,
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandOutcome> {
  try {
    const result = await execImpl(file, args, opts);
    return { status: "ok", stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const maybeError = error as { code?: string; killed?: boolean; signal?: string; message?: string };
    if (maybeError.code === "ETIMEDOUT" || maybeError.killed || maybeError.signal === "SIGTERM") {
      return { status: "timeout", message: maybeError.message ?? `${file} timed out` };
    }
    return { status: "error", message: maybeError.message ?? String(error) };
  }
}

function backendFromEnv(env: NodeJS.ProcessEnv, backend: CliBackendDefinition): { binary: string; model: string | undefined; args: string[] } {
  const selectedAgent = env.SLAD_DEFAULT_AGENT;
  const binary = selectedAgent === backend.id && env.SLAD_CLI_BINARY?.trim() ? env.SLAD_CLI_BINARY.trim() : backend.defaultBinary;
  const model = selectedAgent === backend.id ? env.CLI_MODEL?.trim() || env.SLAD_MODEL?.trim() : undefined;
  const args = selectedAgent === backend.id && env.SLAD_CLI_ARGS !== undefined
    ? env.SLAD_CLI_ARGS.split(/\s+/).filter(Boolean)
    : backend.defaultArgs;
  return { binary, model, args };
}

async function queryBinaryVersion(
  execImpl: DoctorExec,
  resolvedBinary: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandOutcome> {
  return runCommand(execImpl, resolvedBinary, ["--version"], { ...opts, timeoutMs: Math.min(opts.timeoutMs, 800) });
}

async function checkBackends(opts: { fs: DoctorFs; exec: DoctorExec; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const selectedBackend = opts.env.SLAD_DEFAULT_AGENT;
  for (const backend of listSupportedBackends()) {
    const launch = backendFromEnv(opts.env, backend);
    const resolved = await resolveExecutable(launch.binary, opts);
    const isSelected = selectedBackend === backend.id;
    if (!resolved) {
      checks.push(check(
        `backend:${backend.id}:binary`,
        isSelected ? "blocked" : "warning",
        isSelected
          ? `${backend.label} está seleccionado pero no tiene un binario ejecutable detectable.`
          : `${backend.label} no tiene un binario ejecutable detectable.`,
        { evidence: [`binary:${launch.binary}`], recommendation: `Instalá ${backend.defaultBinary} o configurá providers.binaries.${backend.id}.` },
      ));
      continue;
    }

    const binaryEvidence = [`binary:${launch.binary}`, `resolved:${resolved}`];
    const version = await queryBinaryVersion(opts.exec, resolved, opts);
    if (version.status === "ok") {
      binaryEvidence.push(`version:${(version.stdout || version.stderr).trim().split(/\r?\n/)[0]?.slice(0, 80) || "unknown"}`);
    } else {
      binaryEvidence.push(`version:${version.status}:${version.message}`);
    }

    checks.push(check(
      `backend:${backend.id}:binary`,
      "healthy",
      version.status === "ok"
        ? `${backend.label} tiene binario ejecutable.`
        : `${backend.label} tiene binario ejecutable; no se pudo obtener su versión de forma no fatal.`,
      { evidence: binaryEvidence },
    ));

    const missingWorkspace = backend.id === "agy" && (!launch.args.includes("--add-dir") || !launch.args.includes("{workspace}"));
    const missingPrintMode = backend.promptMode === "arg" && !launch.args.includes("--print");
    const selectedBackendMissingModel = opts.env.SLAD_DEFAULT_AGENT === backend.id && backend.id !== "codex" && !launch.model;
    if (missingWorkspace || missingPrintMode || selectedBackendMissingModel) {
      checks.push(check(
        `backend:${backend.id}:launch`,
        "warning",
        `${backend.label} tiene LaunchSpec potencialmente incompleto.`,
        {
          evidence: [`args:${launch.args.join(" ") || "<empty>"}`, `model:${launch.model ?? "<unset>"}`],
          recommendation: "Revisá los argumentos no interactivos y el modelo configurado antes de ejecutar agentes.",
        },
      ));
    } else {
      checks.push(check(
        `backend:${backend.id}:launch`,
        "healthy",
        `${backend.label} tiene LaunchSpec/modelo compatible con ejecución no interactiva.`,
        { evidence: [`args:${launch.args.join(" ")}`, `model:${launch.model ?? "<backend-default>"}`] },
      ));
    }
  }
  return checks;
}

async function checkGit(opts: { exec: DoctorExec; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const head = await runCommand(opts.exec, "git", ["rev-parse", "--verify", "HEAD"], opts);
  if (head.status === "timeout") {
    return [check("git:head", "blocked", "git rev-parse excedió el timeout.", { evidence: [head.message], recommendation: "Verificá que git responda en este workspace." })];
  }
  if (head.status === "error") {
    return [check("git:head", "blocked", "No se pudo leer HEAD de git.", { evidence: [head.message], recommendation: "Ejecutá doctor dentro de un repositorio git con un commit inicial." })];
  }
  const headEvidence = (head.stdout || head.stderr).trim().slice(0, 40) || "HEAD verified";
  checks.push(check("git:head", "healthy", "HEAD de git está disponible.", { evidence: [headEvidence] }));

  const status = await runCommand(opts.exec, "git", ["status", "--porcelain=v1"], opts);
  if (status.status === "timeout") {
    checks.push(check("git:status", "blocked", "git status excedió el timeout.", { evidence: [status.message] }));
  } else if (status.status === "error") {
    checks.push(check("git:status", "blocked", "No se pudo leer el estado de git.", { evidence: [status.message] }));
  } else {
    const changed = status.stdout.split(/\r?\n/).filter(Boolean).length;
    checks.push(check(
      "git:status",
      changed > 0 ? "warning" : "healthy",
      changed > 0 ? `El workspace tiene ${changed} cambio(s) sin commit.` : "El workspace no tiene cambios pendientes.",
      changed > 0 ? { evidence: [`changed:${changed}`], recommendation: "Revisá cambios ajenos antes de ejecutar tareas paralelas." } : {},
    ));
  }

  const worktrees = await runCommand(opts.exec, "git", ["worktree", "list", "--porcelain"], opts);
  if (worktrees.status === "timeout") {
    checks.push(check("git:worktrees", "warning", "git worktree list excedió el timeout.", { evidence: [worktrees.message] }));
  } else if (worktrees.status === "error") {
    checks.push(check("git:worktrees", "warning", "No se pudieron listar worktrees.", { evidence: [worktrees.message] }));
  } else {
    const count = worktrees.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length;
    checks.push(check("git:worktrees", "healthy", `Git reporta ${count} worktree(s).`, { evidence: [`worktrees:${count}`] }));
  }
  return checks;
}

async function checkTmux(opts: { exec: DoctorExec; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<DoctorCheck> {
  const result = await runCommand(opts.exec, "tmux", ["-V"], opts);
  if (result.status === "timeout") {
    return check("tmux", "warning", "tmux -V excedió el timeout.", { evidence: [result.message], recommendation: "Instalá o repará tmux para ejecución paralela interactiva." });
  }
  if (result.status === "error") {
    return check("tmux", "warning", "tmux no está disponible.", { evidence: [result.message], recommendation: "Instalá tmux o usá modos sin tmux cuando estén disponibles." });
  }
  return check("tmux", "healthy", "tmux está disponible.", { evidence: [(result.stdout || result.stderr).trim()] });
}

async function checkRuntimePermissions(opts: { fs: DoctorFs; cwd: string }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const runtimeDir = path.join(opts.cwd, ".slad-os");
  const cwdReadable = await canAccess(opts.fs, opts.cwd, fsConstants.R_OK);
  const cwdWritable = await canAccess(opts.fs, opts.cwd, fsConstants.W_OK);
  if (!cwdReadable) {
    checks.push(check("runtime:workspace", "blocked", "El workspace no es legible.", { evidence: [opts.cwd] }));
  } else if (!cwdWritable) {
    checks.push(check("runtime:workspace", "warning", "El workspace es legible pero no escribible.", { evidence: [opts.cwd] }));
  } else {
    checks.push(check("runtime:workspace", "healthy", "El workspace es legible y escribible.", { evidence: [opts.cwd] }));
  }

  try {
    const stat = await opts.fs.stat(runtimeDir);
    if (!stat.isDirectory()) {
      checks.push(check("runtime:slad-os", "warning", ".slad-os existe pero no es un directorio.", { evidence: [runtimeDir] }));
    } else if (!(await canAccess(opts.fs, runtimeDir, fsConstants.R_OK | fsConstants.W_OK))) {
      checks.push(check("runtime:slad-os", "warning", ".slad-os no tiene permisos suficientes de lectura/escritura.", { evidence: [runtimeDir] }));
    } else {
      checks.push(check("runtime:slad-os", "healthy", ".slad-os tiene permisos de lectura/escritura.", { evidence: [runtimeDir] }));
    }
  } catch {
    checks.push(check("runtime:slad-os", "warning", ".slad-os todavía no existe.", { evidence: [runtimeDir], recommendation: "Se creará cuando ejecutes comandos que escriben estado." }));
  }
  return checks;
}

async function checkRecentManifests(opts: { fs: DoctorFs; cwd: string; recentManifestLimit: number }): Promise<DoctorCheck> {
  const runsDir = path.join(opts.cwd, ".slad-os", "runs");
  let runIds: string[];
  try {
    runIds = await opts.fs.readdir(runsDir);
  } catch {
    return check("manifests:recent", "healthy", "No hay manifests recientes que validar.", { evidence: [runsDir] });
  }

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const runId of runIds) {
    const manifestPath = path.join(runsDir, runId, "manifest.json");
    try {
      const stat = await opts.fs.stat(manifestPath);
      candidates.push({ path: manifestPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore run directories without manifest.json; stale partial dirs are not fatal.
    }
  }

  const recent = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, opts.recentManifestLimit);
  const valid: string[] = [];
  const active: string[] = [];
  const interrupted: string[] = [];
  const corrupt: string[] = [];
  for (const item of recent) {
    try {
      const raw = JSON.parse(await opts.fs.readFile(item.path, "utf8")) as unknown;
      const parsed = RunManifest.safeParse(raw);
      if (!parsed.success) {
        corrupt.push(item.path);
        continue;
      }
      valid.push(item.path);
      if (parsed.data.status === "starting" || parsed.data.status === "running") active.push(item.path);
      if (parsed.data.status === "interrupted") interrupted.push(item.path);
    } catch {
      corrupt.push(item.path);
    }
  }

  const evidence = [
    `checked:${recent.length}`,
    `valid:${valid.length}`,
    `active:${active.length}`,
    `interrupted:${interrupted.length}`,
    `corrupt:${corrupt.length}`,
    ...active.map((item) => `active:${item}`),
    ...interrupted.map((item) => `interrupted:${item}`),
    ...corrupt.map((item) => `corrupt:${item}`),
  ];

  if (corrupt.length > 0 || active.length > 0 || interrupted.length > 0) {
    const fragments = [
      `${valid.length} válido(s)`,
      `${active.length} activo(s)`,
      `${interrupted.length} interrumpido(s)`,
      `${corrupt.length} corrupto(s)/ilegible(s)`,
    ];
    return check(
      "manifests:recent",
      "warning",
      `Manifests recientes: ${fragments.join(", ")}.`,
      { evidence, recommendation: "Inspeccioná los manifests activos, interrumpidos o corruptos; doctor continúa en modo solo lectura." },
    );
  }
  return check("manifests:recent", "healthy", `Manifests recientes: ${valid.length} válido(s), 0 activo(s), 0 interrumpido(s), 0 corrupto(s)/ilegible(s).`, { evidence });
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReportValue> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fsImpl = options.fs ?? nodeFs;
  const execImpl = options.exec ?? nodeExec;
  const recentManifestLimit = options.recentManifestLimit ?? DEFAULT_RECENT_MANIFEST_LIMIT;

  const checks = [
    ...await checkBackends({ fs: fsImpl, exec: execImpl, cwd, env, timeoutMs }),
    ...await checkGit({ exec: execImpl, cwd, env, timeoutMs }),
    await checkTmux({ exec: execImpl, cwd, env, timeoutMs }),
    ...await checkRuntimePermissions({ fs: fsImpl, cwd }),
    await checkRecentManifests({ fs: fsImpl, cwd, recentManifestLimit }),
  ];

  return aggregate(checks);
}
