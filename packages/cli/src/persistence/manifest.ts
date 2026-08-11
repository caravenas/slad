import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { RunManifest, type RunManifest as RunManifestValue } from "@slad/shared";
import { ParseError } from "../core/errors.js";

export type CreateRunManifestInput = Omit<
  RunManifestValue,
  "schemaVersion" | "runId" | "traceId" | "status" | "stages" | "tasks" | "artifacts" | "retry" | "startedAt" | "updatedAt"
> & {
  runId?: string;
  traceId?: string;
  stages?: RunManifestValue["stages"];
  tasks?: RunManifestValue["tasks"];
};

export interface RunManifestHandle {
  path: string;
  value: RunManifestValue;
}

/** Repo-local path of a run's manifest, whether or not it exists yet. */
export function runManifestPath(runId: string, cwd: string = process.cwd()): string {
  return path.join(cwd, ".slad-os", "runs", runId, "manifest.json");
}

export async function createRunManifest(
  input: CreateRunManifestInput,
  cwd: string = process.cwd(),
): Promise<RunManifestHandle> {
  const now = new Date().toISOString();
  const runId = input.runId ?? `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const value = RunManifest.parse({
    ...input,
    schemaVersion: 1,
    runId,
    traceId: input.traceId ?? randomUUID(),
    status: "starting",
    stages: input.stages ?? [],
    tasks: input.tasks ?? [],
    artifacts: [],
    retry: { count: 0 },
    startedAt: now,
    updatedAt: now,
  });
  const manifestPath = runManifestPath(runId, cwd);
  await writeManifestAtomic(manifestPath, value);
  return { path: manifestPath, value };
}

export async function updateRunManifest(
  handle: RunManifestHandle,
  update: Partial<RunManifestValue> | ((current: RunManifestValue) => RunManifestValue),
): Promise<RunManifestHandle> {
  const candidate = typeof update === "function" ? update(handle.value) : { ...handle.value, ...update };
  const value = RunManifest.parse({ ...candidate, updatedAt: new Date().toISOString() });
  await writeManifestAtomic(handle.path, value);
  handle.value = value;
  return handle;
}

export async function completeRunManifest(
  handle: RunManifestHandle,
  status: Extract<RunManifestValue["status"], "completed" | "partial" | "failed" | "cancelled" | "applied" | "aborted">,
  terminalReason?: string,
): Promise<RunManifestHandle> {
  const completedAt = new Date().toISOString();
  return updateRunManifest(handle, {
    status,
    completedAt,
    ...(terminalReason ? { terminalReason } : {}),
  });
}

export async function readRunManifest(
  manifestPath: string,
  options: { markInterrupted?: boolean } = {},
): Promise<RunManifestHandle> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new ParseError(`cannot read run manifest: ${manifestPath}`, {
      path: manifestPath,
      phase: error instanceof SyntaxError ? "json" : "filesystem",
      cause: error,
    });
  }
  const parsed = RunManifest.safeParse(raw);
  if (!parsed.success) {
    throw new ParseError(`run manifest failed schema validation: ${manifestPath}`, {
      path: manifestPath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  const handle = { path: manifestPath, value: parsed.data };
  if (options.markInterrupted && ["starting", "running"].includes(handle.value.status)) {
    await updateRunManifest(handle, (current) => ({
      ...current,
      status: "interrupted",
      terminalReason: "previous process ended before recording a terminal state",
      completedAt: new Date().toISOString(),
      // Class B: nobody terminalized this run, so the manifest cannot be
      // trusted to describe the integration branch. Never resumable.
      recovery: { safe: false, reason: "uncaught" },
      stages: current.stages.map((stage) => stage.status === "running" ? { ...stage, status: "interrupted" } : stage),
      tasks: current.tasks.map((task) => task.status === "running" ? { ...task, status: "interrupted" } : task),
    }));
  }
  return handle;
}

// ─── Native interruption / resume helpers ────────────────────────────────────

/**
 * Records the integration branch *before* `setupIntegration` creates it, with
 * `tip = baseRef`. Without this record-before-create, a class-B death between
 * `worktree add -B` and the end of the run would leave a branch no command
 * recognizes, and a later fresh run would delete it silently.
 */
export function recordIntegration(
  handle: RunManifestHandle,
  integration: RunManifestValue["worktrees"]["integration"],
): Promise<RunManifestHandle> {
  return updateRunManifest(handle, (current) => ({
    ...current,
    worktrees: { ...current.worktrees, integration },
  }));
}

/**
 * The durable per-task checkpoint (A1): exactly one manifest write, no
 * artifact, no hashing, no hooks, no other I/O. Invoked right after the task's
 * merge returns, inside the critical section — I0 (the manifest exactly
 * describes the branch) may not depend on the artifact directory being
 * writable, so nothing fallible is allowed to share this write.
 *
 * A task that merges nothing still checkpoints: it writes its status and
 * re-writes the current tip.
 */
export function checkpointTaskIntegration(
  handle: RunManifestHandle,
  checkpoint: { taskId: string; status: RunManifestValue["tasks"][number]["status"]; integrationTip?: string },
): Promise<RunManifestHandle> {
  return updateRunManifest(handle, (current) => ({
    ...current,
    tasks: current.tasks.map((task) => task.taskId === checkpoint.taskId
      ? { ...task, status: checkpoint.status }
      : task),
    worktrees: checkpoint.integrationTip && current.worktrees.integration
      ? {
        ...current.worktrees,
        integration: { ...current.worktrees.integration, tip: checkpoint.integrationTip },
      }
      : current.worktrees,
  }));
}

/**
 * Durably reserves one worker dispatch (A3) in a single manifest write, and
 * marks the task `running`. Called immediately before the real spawn and after
 * the task workspace is ready, so the counter is an upper bound on started
 * executions — never below, which is the dangerous direction.
 */
export function reserveTaskDispatch(
  handle: RunManifestHandle,
  reservation: { taskId: string; worktree?: string },
): Promise<RunManifestHandle> {
  return updateRunManifest(handle, (current) => ({
    ...current,
    policy: {
      strictOwnership: current.policy?.strictOwnership ?? false,
      taskDispatches: (current.policy?.taskDispatches ?? 0) + 1,
    },
    tasks: current.tasks.map((task) => task.taskId === reservation.taskId
      ? { ...task, status: "running" as const, ...(reservation.worktree ? { worktree: reservation.worktree } : {}) }
      : task),
  }));
}

/**
 * Class-A terminalization: the run ended through a caught signal, so the
 * manifest is exact by construction and the run is natively resumable.
 * Tasks still `running` never produced a checkpoint and go back on the table.
 */
export function markRunInterrupted(
  handle: RunManifestHandle,
  options: { signal: "SIGINT" | "SIGTERM"; hasIntegration: boolean },
): Promise<RunManifestHandle> {
  const completedAt = new Date().toISOString();
  return updateRunManifest(handle, (current) => ({
    ...current,
    // Nothing merged means nothing to review or resume: the run is simply
    // cancelled and its worktrees were cleaned.
    status: options.hasIntegration ? "interrupted" : "cancelled",
    completedAt,
    terminalReason: `run interrumpido por ${options.signal}`,
    recovery: options.hasIntegration
      ? { safe: true, reason: "signal" as const, signal: options.signal }
      : undefined,
    stages: current.stages.map((stage) => stage.status === "running" ? { ...stage, status: "interrupted" } : stage),
    tasks: current.tasks.map((task) => task.status === "running" ? { ...task, status: "interrupted" } : task),
  }));
}

/**
 * Class-B terminalization from inside the live process: a durable write the
 * run depends on failed, so the manifest no longer describes the branch.
 * Never `safe: true` — the class-A marker asserts exactness, and here there is
 * none.
 */
export function markRunUnrecoverable(
  handle: RunManifestHandle,
  terminalReason: string,
): Promise<RunManifestHandle> {
  const completedAt = new Date().toISOString();
  return updateRunManifest(handle, (current) => ({
    ...current,
    status: "interrupted",
    completedAt,
    terminalReason: terminalReason.slice(0, 400),
    recovery: { safe: false, reason: "uncaught" },
    stages: current.stages.map((stage) => stage.status === "running" ? { ...stage, status: "interrupted" } : stage),
    tasks: current.tasks.map((task) => task.status === "running" ? { ...task, status: "interrupted" } : task),
  }));
}

/** Statuses in which a run's outcome has already been decided by a human or by the run itself. */
const TERMINAL_STATUSES: RunManifestValue["status"][] = [
  "completed", "partial", "failed", "cancelled", "applied", "aborted",
];

export function isTerminalRunStatus(status: RunManifestValue["status"]): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Every readable manifest of a session, newest first. */
export async function listSessionRunManifests(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<RunManifestHandle[]> {
  const runsDir = path.join(cwd, ".slad-os", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const handles: RunManifestHandle[] = [];
  for (const runId of entries) {
    try {
      const handle = await readRunManifest(path.join(runsDir, runId, "manifest.json"));
      if (handle.value.sessionId === sessionId) handles.push(handle);
    } catch (error) {
      if (error instanceof ParseError) continue;
      throw error;
    }
  }
  return handles.sort((a, b) => b.value.startedAt.localeCompare(a.value.startedAt));
}

export async function interruptStaleRunManifests(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<RunManifestHandle[]> {
  const runsDir = path.join(cwd, ".slad-os", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const interrupted: RunManifestHandle[] = [];
  for (const runId of entries) {
    const manifestPath = path.join(runsDir, runId, "manifest.json");
    try {
      const handle = await readRunManifest(manifestPath);
      if (handle.value.sessionId !== sessionId || !["starting", "running"].includes(handle.value.status)) continue;
      interrupted.push(await readRunManifest(manifestPath, { markInterrupted: true }));
    } catch (error) {
      if (error instanceof ParseError && error.phase === "filesystem") continue;
      throw error;
    }
  }
  return interrupted;
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeManifestAtomic(filePath: string, value: RunManifestValue): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.manifest.${randomUUID().slice(0, 8)}.tmp`);
  try {
    const file = await open(tmp, "wx");
    try {
      await file.writeFile(JSON.stringify(value, null, 2), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, filePath);
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw new ParseError(`cannot write run manifest: ${filePath}`, {
      path: filePath,
      phase: "filesystem",
      cause: error,
    });
  }
}
