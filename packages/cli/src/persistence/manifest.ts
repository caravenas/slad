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
      stages: current.stages.map((stage) => stage.status === "running" ? { ...stage, status: "interrupted" } : stage),
      tasks: current.tasks.map((task) => task.status === "running" ? { ...task, status: "interrupted" } : task),
    }));
  }
  return handle;
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
