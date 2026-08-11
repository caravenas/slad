import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Cross-process worker detection for `--resume`, `--apply` and `--abort`.
 *
 * All three are destructive over the session's worktrees and branches, so all
 * three refuse while a worker of that session might still be running. SLAD
 * never signals a pid read from disk (that is pid reuse); inside the live
 * process, identity is guaranteed by the `ChildProcess` handle instead.
 */

export interface WorkerSentinel {
  v: 1;
  runId: string;
  taskId: string;
  host: string;
  pid: number;
  startedAt: string;
  mode: "child" | "tmux";
  tmuxWindow?: string;
}

export type WorkerLiveness = "dead" | "alive" | "unknown";

export interface InspectedWorker {
  sentinel: WorkerSentinel;
  path: string;
  liveness: WorkerLiveness;
}

export interface WorkerInspection {
  dead: InspectedWorker[];
  alive: InspectedWorker[];
  unknown: InspectedWorker[];
}

/** tmux window name, namespaced by session so cleanup is well defined. */
export function tmuxWindowName(sessionId: string, taskId: string): string {
  return `slad-${sessionId}-${taskId}`;
}

/** True for windows this session owns; `slad-<otherSession>-T1` must not match. */
export function isSessionTmuxWindow(windowName: string, sessionId: string): boolean {
  return windowName.startsWith(`slad-${sessionId}-`) && windowName.length > `slad-${sessionId}-`.length;
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}

function sentinelDir(cwd: string, sessionId: string, taskId: string): string {
  return path.join(cwd, ".slad-os", "sessions", sessionId, "tasks", taskId);
}

export function workerSentinelPath(cwd: string, sessionId: string, taskId: string): string {
  return path.join(sentinelDir(cwd, sessionId, taskId), "worker.json");
}

export function writeWorkerSentinel(
  cwd: string,
  sessionId: string,
  sentinel: Omit<WorkerSentinel, "v" | "host" | "startedAt"> & { host?: string; startedAt?: string },
): void {
  const target = workerSentinelPath(cwd, sessionId, sentinel.taskId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const value: WorkerSentinel = {
    v: 1,
    runId: sentinel.runId,
    taskId: sentinel.taskId,
    host: sentinel.host ?? hostname(),
    pid: sentinel.pid,
    startedAt: sentinel.startedAt ?? new Date().toISOString(),
    mode: sentinel.mode,
    ...(sentinel.tmuxWindow ? { tmuxWindow: sentinel.tmuxWindow } : {}),
  };
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf8");
}

export function removeWorkerSentinel(cwd: string, sessionId: string, taskId: string): void {
  fs.rmSync(workerSentinelPath(cwd, sessionId, taskId), { force: true });
}

function classify(sentinel: WorkerSentinel): WorkerLiveness {
  // Only the direction that proves something is used: an absent pid proves the
  // worker died; a responding pid does not prove it is the same process.
  if (sentinel.host !== hostname()) return "unknown";
  try {
    process.kill(sentinel.pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

export function inspectWorkers(cwd: string, sessionId: string): WorkerInspection {
  const tasksRoot = path.join(cwd, ".slad-os", "sessions", sessionId, "tasks");
  const result: WorkerInspection = { dead: [], alive: [], unknown: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sentinelPath = workerSentinelPath(cwd, sessionId, entry.name);
    let sentinel: WorkerSentinel;
    try {
      sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as WorkerSentinel;
    } catch {
      continue;
    }
    if (typeof sentinel?.pid !== "number" || typeof sentinel?.taskId !== "string") continue;
    const liveness = classify(sentinel);
    result[liveness].push({ sentinel, path: sentinelPath, liveness });
  }
  return result;
}

/** Deletes sentinels of workers proven dead. Never sends a signal. */
export function clearWorkerSentinels(workers: InspectedWorker[]): void {
  for (const worker of workers) fs.rmSync(worker.path, { force: true });
}

/** Deletes every sentinel of the session without sending any signal. */
export function clearAllWorkerSentinels(cwd: string, sessionId: string): void {
  const inspection = inspectWorkers(cwd, sessionId);
  clearWorkerSentinels([...inspection.dead, ...inspection.alive, ...inspection.unknown]);
}

export function describeWorker({ sentinel }: InspectedWorker): string {
  return `${sentinel.taskId} (pid ${sentinel.pid}, host ${sentinel.host}, desde ${sentinel.startedAt})`;
}

/**
 * Refusal message for a mutating command blocked by workers that are alive or
 * whose state cannot be proven. SLAD prints how to verify them and never
 * completes the destructive action on the user's behalf.
 */
export function workerGuardMessage(
  command: string,
  sessionId: string,
  blocking: InspectedWorker[],
): string {
  const lines = [
    `No se puede ${command}: la sesión ${sessionId} tiene workers que siguen vivos o cuyo estado no se puede probar.`,
    "",
    ...blocking.map((worker) => `  ${worker.liveness.padEnd(7)} ${describeWorker(worker)}`),
    "",
    ...blocking.map((worker) => `  ps -p ${worker.sentinel.pid} -o pid,ppid,lstart,command`),
    "",
    "  --assume-workers-dead   borra los sentinels sin enviar ninguna señal (los verificaste y los mataste vos)",
  ];
  return lines.join("\n");
}

/**
 * The only active cross-process cleanup: tmux windows of this session.
 * Targets `#{window_id}` (unique) filtered by the exact session prefix, so a
 * window of another session is never killed.
 */
export async function killSessionTmuxWindows(sessionId: string): Promise<string[]> {
  let listing: string;
  try {
    const { stdout } = await exec("tmux", ["list-windows", "-a", "-F", "#{window_id}\t#{window_name}"]);
    listing = stdout;
  } catch {
    return []; // no tmux server, or tmux unavailable
  }
  const killed: string[] = [];
  for (const line of listing.split("\n")) {
    const [windowId, windowName] = line.split("\t");
    if (!windowId || !windowName || !isSessionTmuxWindow(windowName, sessionId)) continue;
    await exec("tmux", ["kill-window", "-t", windowId]).catch(() => undefined);
    killed.push(windowName);
  }
  return killed;
}
