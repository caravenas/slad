import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import kleur from "kleur";
import { RunOutput, type PlanOutput, type PlanTask } from "../core/types.js";
import { toCompactJson } from "@slad/shared";
import { launchSpecFromEnv } from "@slad/model-providers";
import { BUILDER_REVIEWER_SYSTEM } from "../agents/prompts.js";
import { getNextWave, autoSkipDependents, type TaskStatus } from "./dag.js";
import {
  addTaskWorktree,
  assertWorktreeReady,
  commitTaskWork,
  hasUncommittedChanges,
  integrationTip,
  mergeTaskBranch,
  parseGitStatusPorcelainZ,
  removeSessionWorktrees,
  setupIntegration,
  type IntegrationSetup,
} from "./worktrees.js";
import {
  removeWorkerSentinel,
  tmuxWindowName,
  writeWorkerSentinel,
} from "../core/worker-sentinels.js";

export { parseGitStatusPorcelainZ } from "./worktrees.js";

const exec = promisify(execFile);

// ─── Options and seams ────────────────────────────────────────────────────────

export interface ParallelRunOptions {
  plan: PlanOutput;
  sessionId: string;
  /** Recorded in each worker sentinel so another process can attribute it. */
  runId?: string;
  /** Workspace root where workers run (and git is checked). */
  cwd: string;
  maxParallel: number;
  maxTasks?: number;
  strictOwnership: boolean;
  /**
   * Isolate each task in its own git worktree branched from a session
   * integration branch and merge results sequentially. The main worktree is
   * never touched: when anything was merged the run ends review-pending, with
   * worktrees and branches preserved for `run --apply` / `run --abort`.
   * Requires a committed HEAD; enables per-task ownership attribution.
   */
  useWorktrees?: boolean;
  /** Keep the session worktrees/branches even when nothing was merged (debugging). */
  keepWorktrees?: boolean;
  /**
   * Continue a previous run's not-yet-applied integration (`--from-review`):
   * task worktrees branch from `ref` (the previous integration tip) and the
   * review base stays at `baseRef` (the main worktree HEAD the chain started
   * from), so a later apply squashes the whole chain exactly once.
   */
  fromIntegration?: { ref: string; baseRef: string };
  /**
   * Task ids already completed earlier in the resume chain. They are seeded as
   * done so `getNextWave` schedules their dependents, and they are never
   * re-executed: exactly-once across the chain (I2).
   */
  alreadyDone?: readonly string[];
  /**
   * Worker dispatches already consumed by the chain. `maxTasks` bounds
   * dispatches across the whole chain, not per invocation.
   */
  taskDispatches?: number;
  /**
   * Task ids whose worktrees may be recycled when setting up the integration
   * (resume / follow-up). Fresh runs pass nothing.
   */
  recycleTaskWorktrees?: readonly string[];
  /** Per-task timeout. Default: 15 minutes. */
  taskTimeoutMs?: number;
  /** Cancels scheduling and terminates active child-process workers. */
  signal?: AbortSignal;
  /**
   * Cross-agent project memory (~/.agents/memory/projects/<repo>.md) injected
   * into every handoff prompt. Callers resolve it via readProjectMemory().
   */
  projectMemory?: string | null;
  /**
   * Durable reservation of one worker dispatch, persisted immediately before
   * the real spawn and after the task workspace is ready. A throw is **fatal**:
   * spawning without a durable reservation would silently let a resume chain
   * exceed `maxTasks`.
   */
  onDispatchReserve?: (taskId: string, context: { worktree?: string }) => Promise<void>;
  /**
   * The durable per-task checkpoint, invoked inside the critical section right
   * after the task's merge returns. Implementations must be exactly one
   * manifest write and nothing else — no artifact, no hashing, no hooks. A
   * throw is **fatal**: the durable state no longer describes the branch.
   */
  onTaskIntegrated?: (taskId: string, checkpoint: {
    status: "completed" | "blocked" | "failed" | "skipped";
    integrationTip?: string;
  }) => Promise<void>;
  /**
   * Secondary, best-effort per-task work (artifact, session, post-task hook),
   * invoked after the checkpoint returned and outside the critical section.
   * The caller owns its error handling; a failure here never fails the task.
   */
  onTaskOutput?: (output: RunOutput) => Promise<void>;
  /** Called once per wave with the tasks about to be prepared. */
  onWaveStart?: (taskIds: string[]) => void;
  /** Test seam: replaces real worker execution (tmux/child process). */
  runWorker?: WorkerRunner;
  /** Test seam: replaces `git status --porcelain` parsing (shared-worktree mode only). */
  listChangedFiles?: () => Promise<Set<string>>;
  /** Test seam: silences table output. */
  print?: (line: string) => void;
}

export interface WorkerSpec {
  task: PlanTask;
  /** Directory for prompt/output/sentinel files (always under the main repo). */
  workerDir: string;
  /** Directory the agent works in: the main repo, or the task's worktree. */
  workspace: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** tmux window name, namespaced by session so cleanup is well defined (F9). */
  tmuxWindow?: string;
  /** Records the worker's pid so another process can detect it (W2). */
  onWorkerStarted?: (info: { pid: number; mode: "child" | "tmux"; tmuxWindow?: string }) => void;
}

export type WorkerRunner = (spec: WorkerSpec) => Promise<{
  exitCode: number;
  stdout: string;
}>;

export interface ParallelRunResult {
  status: "completed" | "partial" | "failed";
  outputs: RunOutput[];
  /**
   * Worktree mode only, and only when the integration branch holds merged
   * work: the pending review range. The caller records it in the manifest and
   * the run stays unapplied until `run --apply` / `run --abort`.
   */
  integration?: { branch: string; baseRef: string; tip: string };
  /** A caught signal cut the run short; the caller terminalizes as class A. */
  interrupted?: boolean;
  /** Worker dispatches consumed by the whole chain, including this run. */
  taskDispatches: number;
  /** The chain's `maxTasks` budget ran out before every task could start. */
  budgetExhausted?: boolean;
}

type LaunchedWorker = { spec: WorkerSpec; result: Promise<RunOutput> };

// ─── Handoff prompt ───────────────────────────────────────────────────────────

export function buildHandoffPrompt(
  task: PlanTask,
  plan: PlanOutput,
  projectMemory?: string | null,
): string {
  const ownership =
    task.files.length > 0
      ? `SOLO puedes crear o modificar estos archivos (otros workers editan otros archivos en paralelo — no toques nada fuera de tu lista):\n${task.files.map((f) => `- ${f}`).join("\n")}`
      : "Esta tarea no declara archivos: eres el único worker corriendo ahora.";

  return [
    `[System]\n${BUILDER_REVIEWER_SYSTEM}`,
    `Contexto adicional — ejecución paralela:\n${ownership}`,
    ...(projectMemory
      ? [`Memoria global del proyecto (~/.agents/memory/projects/):\n${projectMemory}`]
      : []),
    `Plan summary:\n${plan.summary}`,
    `Selected task:\n${toCompactJson(task)}`,
    `Al terminar, imprime como ÚLTIMO bloque de tu salida un objeto JSON válido con esta forma exacta (schema RunOutput):\n` +
      `{"taskId": "${task.id}", "status": "completed" | "blocked" | "failed", "summary": string, "changedFiles": string[], "verification": [{"command": string, "status": "passed" | "failed" | "not_run", "notes": string}], "followUps": string[], "reviewerNotes": string[]}`,
  ].join("\n\n");
}

// ─── Worker output parsing ────────────────────────────────────────────────────

/**
 * Extracts the last valid RunOutput JSON object from a worker's stdout.
 * Missing or malformed structured output is always an unverified failure,
 * regardless of the worker process exit code.
 */
export function parseWorkerOutput(task: PlanTask, stdout: string, exitCode: number): RunOutput {
  const lastClose = stdout.lastIndexOf("}");
  if (lastClose !== -1) {
    let searchFrom = lastClose;
    for (let attempts = 0; attempts < 200; attempts++) {
      const start = stdout.lastIndexOf("{", searchFrom);
      if (start === -1) break;
      try {
        const candidate = RunOutput.safeParse(JSON.parse(stdout.slice(start, lastClose + 1)));
        if (candidate.success) {
          return { ...candidate.data, taskId: task.id };
        }
      } catch {
        // keep scanning backwards for an earlier opening brace
      }
      searchFrom = start - 1;
    }
  }

  return {
    taskId: task.id,
    status: "failed",
    summary: exitCode !== 0
      ? `Worker exited with code ${exitCode} without structured output.`
      : "Worker exited successfully but did not produce a valid RunOutput; result is unverified.",
    changedFiles: [],
    decisions: [],
    questions: [],
    humanAnswers: {},
    followUps: [],
    assumptions: [],
    verification: [],
    reviewerNotes: ["missing-run-output-json"],
  };
}

// ─── Ownership check ──────────────────────────────────────────────────────────

/** SLAD's own state written during a run; never counts as a violation. */
const OWNERSHIP_EXEMPT_PREFIXES = [".slad-os/", "docs/"];

/** Files changed during the wave that no wave task declared as owned. */
export function computeOwnershipViolations(
  before: Set<string>,
  after: Set<string>,
  owned: Set<string>,
): string[] {
  return [...after]
    .filter(
      (file) =>
        !before.has(file) &&
        !owned.has(file) &&
        !OWNERSHIP_EXEMPT_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix)),
    )
    .sort();
}

/**
 * A "phantom completion": the worker reported completed and claims or owns
 * files, but none of them shows any git change. Seen with agy writing to its
 * own scratch workspace while reporting successful writes to the repo —
 * agent-reported changedFiles are never trusted without git evidence.
 */
export function isPhantomCompletion(
  task: PlanTask,
  output: RunOutput,
  gitChanges: Iterable<string>,
): boolean {
  if (output.status !== "completed") return false;
  const expected = new Set([...task.files, ...output.changedFiles]);
  if (expected.size === 0) return false;
  for (const file of gitChanges) {
    if (expected.has(file)) return false;
  }
  return true;
}

async function gitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    // -uall lists individual files inside untracked directories; without it a
    // declared file under a new directory shows up as "dir/" and strict
    // ownership flags it as a false violation.
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "-uall"], { cwd });
    return parseGitStatusPorcelainZ(stdout);
  } catch {
    return new Set(); // not a git repo — ownership check becomes a no-op
  }
}

// ─── Worker execution (tmux window or plain child process) ───────────────────

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Builds the worker shell script from the same canonical LaunchSpec as CliProvider. */
export function buildWorkerScript(workspace: string, workerDir: string): string {
  const promptToken = "__SLAD_WORKER_PROMPT__";
  const spec = launchSpecFromEnv({
    prompt: promptToken,
    workspace,
    model: process.env.CLI_MODEL?.trim(),
    permissionProfile: "workspace-write",
  });
  const promptPath = path.join(workerDir, "prompt.txt");
  const outputPath = path.join(workerDir, "output.txt");
  const exitCodePath = path.join(workerDir, "exit-code");
  const renderedArgs = spec.args.map((arg) => arg === promptToken ? `"$(cat ${shq(promptPath)})"` : shq(arg));
  const command = [shq(spec.binary), ...renderedArgs].join(" ");
  const invocation = spec.promptMode === "stdin" ? `${command} < ${shq(promptPath)}` : command;

  // The inner `echo $?` captures the agent's exit status before tee's.
  // The sentinel is moved into place only after output is fully flushed.
  return [
    "#!/bin/sh",
    `cd ${shq(workspace)} || exit 1`,
    `{ ${invocation}; echo $? > ${shq(exitCodePath + ".tmp")}; } 2>&1 | tee ${shq(outputPath)}`,
    `mv ${shq(exitCodePath + ".tmp")} ${shq(exitCodePath)}`,
  ].join("\n") + "\n";
}

function insideTmux(): boolean {
  return Boolean(process.env.TMUX?.trim());
}

async function waitForSentinel(
  exitCodePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(exitCodePath)) {
      const raw = fs.readFileSync(exitCodePath, "utf8").trim();
      return Number.parseInt(raw, 10) || 0;
    }
    // Abort-aware: without this the poll ignores the signal for up to 15
    // minutes and the tmux worker outlives the Ctrl-C that killed slad.
    if (signal?.aborted) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 500);
      const onAbort = () => finish();
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  return null;
}

const defaultRunWorker: WorkerRunner = async (
  { task, workerDir, workspace, timeoutMs, signal, tmuxWindow, onWorkerStarted },
) => {
    const scriptPath = path.join(workerDir, "worker.sh");
    const outputPath = path.join(workerDir, "output.txt");
    const exitCodePath = path.join(workerDir, "exit-code");
    // Clear leftovers from a previous run of the same task: a stale sentinel
    // would otherwise resolve this worker instantly with old results.
    for (const stale of [exitCodePath, exitCodePath + ".tmp", outputPath]) {
      fs.rmSync(stale, { force: true });
    }
    fs.writeFileSync(scriptPath, buildWorkerScript(workspace, workerDir), { mode: 0o755 });

    let exitCode: number | null;
    if (insideTmux()) {
      // Namespaced by session (F9): without it, "kill the windows that are
      // ours" is undefined and a timeout can kill another session's window.
      const windowName = tmuxWindow ?? `slad-${task.id}`;
      const { stdout: windowId } = await exec(
        "tmux",
        ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", windowName, `sh ${shq(scriptPath)}`],
      );
      const pane = await exec("tmux", ["display-message", "-p", "-t", windowId.trim(), "#{pane_pid}"])
        .then(({ stdout }) => Number.parseInt(stdout.trim(), 10))
        .catch(() => Number.NaN);
      if (Number.isFinite(pane)) onWorkerStarted?.({ pid: pane, mode: "tmux", tmuxWindow: windowName });
      exitCode = await waitForSentinel(exitCodePath, timeoutMs, signal);
      if (exitCode === null) {
        // Targets #{window_id}, which is unique: never another session's window.
        await exec("tmux", ["kill-window", "-t", windowId.trim()]).catch(() => undefined);
      }
    } else {
      const child = spawn("sh", [scriptPath], { stdio: "ignore", detached: process.platform !== "win32" });
      if (child.pid !== undefined) onWorkerStarted?.({ pid: child.pid, mode: "child" });
      const killGroup = (childSignal: NodeJS.Signals) => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, childSignal);
          else child.kill(childSignal);
        } catch {
          // Process already exited.
        }
      };
      const terminate = () => {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 2_000).unref();
      };
      const timer = setTimeout(terminate, timeoutMs);
      const onAbort = () => terminate();
      signal?.addEventListener("abort", onAbort, { once: true });
      await new Promise<void>((resolve) => { child.on("close", () => resolve()); });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      exitCode = fs.existsSync(exitCodePath)
        ? Number.parseInt(fs.readFileSync(exitCodePath, "utf8").trim(), 10) || 0
        : null;
    }

    const stdout = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
    if (exitCode === null) {
      return { exitCode: 124, stdout: stdout + "\n[slad] worker timed out" };
    }
    return { exitCode, stdout };
};

// ─── Status table ─────────────────────────────────────────────────────────────

export function renderStatusTable(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
  waveByTask: Map<string, number>,
): string {
  const icon: Record<TaskStatus | "running", string> = {
    pending: "·",
    done: "✓",
    failed: "✗",
    skipped: "⊘",
    running: "▸",
  };
  const rows = tasks.map((task) => {
    const status = state.get(task.id) ?? "pending";
    const wave = waveByTask.get(task.id);
    return [
      icon[status].padEnd(2),
      task.id.padEnd(5),
      status.padEnd(8),
      (wave === undefined ? "-" : `w${wave}`).padEnd(4),
      task.title.slice(0, 60),
    ].join(" ");
  });
  return rows.join("\n");
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/** Per-task ownership check for worktree mode (empty files = owns everything). */
function taskOwnershipViolations(changedFiles: string[], task: PlanTask): string[] {
  if (task.files.length === 0) return [];
  const owned = new Set(task.files);
  return changedFiles
    .filter(
      (file) =>
        !owned.has(file) &&
        !OWNERSHIP_EXEMPT_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix)),
    )
    .sort();
}

/**
 * Fatal failure of a durable write the run's guarantees depend on (A1.3/A3.2):
 * the checkpoint or the dispatch reservation. The loop stops immediately —
 * starting anything new would produce state that lies — and the caller
 * terminalizes the run as class B.
 */
export class DurableWriteError extends Error {
  constructor(readonly kind: "checkpoint" | "reservation", readonly taskId: string, cause: unknown) {
    super(
      `no se pudo persistir ${kind === "checkpoint" ? "el checkpoint" : "la reserva de dispatch"} de ${taskId}: ` +
      (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "DurableWriteError";
    this.cause = cause;
  }
}

function createWaveSignal(signal?: AbortSignal): { signal: AbortSignal; dispose(): void; abort(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    abort() {
      controller.abort();
    },
    dispose() {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function abortLaunchedWorkers(launched: readonly LaunchedWorker[], waveSignal: { abort(): void }): Promise<void> {
  if (launched.length === 0) return;
  waveSignal.abort();
  await Promise.allSettled(launched.map((entry) => entry.result));
}

export async function runParallel(options: ParallelRunOptions): Promise<ParallelRunResult> {
  const {
    plan,
    sessionId,
    runId = "unknown-run",
    cwd,
    maxParallel,
    maxTasks = 10,
    strictOwnership,
    useWorktrees = false,
    keepWorktrees = false,
    alreadyDone = [],
    recycleTaskWorktrees,
    taskTimeoutMs = 15 * 60_000,
    signal,
    projectMemory = null,
    onDispatchReserve,
    onTaskIntegrated,
    onTaskOutput,
    onWaveStart,
    print = console.log,
  } = options;
  const runWorker = options.runWorker ?? defaultRunWorker;
  const listChangedFiles = options.listChangedFiles ?? (() => gitChangedFiles(cwd));
  let taskDispatches = options.taskDispatches ?? 0;

  const flagPhantomCompletion = (task: PlanTask, output: RunOutput): void => {
    const note = `phantom-completion: ${task.id} reportó completed pero git no muestra cambios en sus archivos`;
    print(kleur.yellow(`⚠ ${note}`));
    output.reviewerNotes.push(note);
    if (strictOwnership) {
      output.status = "failed";
      output.summary += " [failed by --strict-ownership]";
    }
  };

  let integration: IntegrationSetup | null = null;
  if (useWorktrees) {
    await assertWorktreeReady(cwd);
    if (await hasUncommittedChanges(cwd)) {
      throw new Error(
        "El modo --worktrees requiere un worktree principal limpio: los workers parten de HEAD " +
        "y el apply posterior asume esa base. Haz commit o stash de tus cambios y reintenta.",
      );
    }
    integration = await setupIntegration(cwd, sessionId, options.fromIntegration?.ref, {
      recycleTasks: recycleTaskWorktrees,
    });
  }
  // The apply guard base: for a --from-review follow-up it stays at the
  // original main HEAD, so the whole chain squashes exactly once.
  const reviewBaseRef = options.fromIntegration?.baseRef ?? integration?.baseRef ?? null;

  const tasksRoot = path.join(cwd, ".slad-os", "sessions", sessionId, "tasks");
  const state = new Map<string, TaskStatus>(plan.tasks.map((task) => [task.id, "pending"]));
  // Seeded as done so getNextWave schedules their dependents on its own; they
  // are never re-executed and never re-merged (I2).
  for (const taskId of alreadyDone) {
    if (state.has(taskId)) state.set(taskId, "done");
  }
  const waveByTask = new Map<string, number>();
  const outputs: RunOutput[] = [];
  let waveNumber = 0;
  let interrupted = false;
  let budgetExhausted = false;

  for (;;) {
    // Abort boundary 1: top of the wave loop, where state is consistent.
    if (signal?.aborted) { interrupted = true; break; }
    const remainingBudget = maxTasks - taskDispatches;
    if (remainingBudget <= 0) { budgetExhausted = true; break; }
    const wave = getNextWave(plan.tasks, state, maxParallel).slice(0, remainingBudget);
    if (wave.length === 0) break;
    waveNumber++;

    for (const task of wave) waveByTask.set(task.id, waveNumber);
    onWaveStart?.(wave.map((task) => task.id));
    print(kleur.bold(`\nWave ${waveNumber}: `) + wave.map((task) => task.id).join(", "));

    // Per task, in this exact order (amendment 2): observe the signal, build
    // the workspace, persist one dispatch reservation, observe the signal
    // again, spawn. Nothing is launched after an observed signal, and at most
    // one reservation per wave can be left unspent.
    const baseRef = integration ? await integrationTip(integration) : null;
    // Captured before any worker starts: dirt that predates the wave must not
    // vouch for a worker that wrote nothing.
    const beforeWave = integration ? null : await listChangedFiles();
    const waveSignal = createWaveSignal(signal);
    const launched: LaunchedWorker[] = [];
    let waveOutputs: RunOutput[] = [];
    try {
      for (const task of wave) {
        if (signal?.aborted) { interrupted = true; break; }
        if (maxTasks - taskDispatches <= 0) { budgetExhausted = true; break; }

        const workerDir = path.join(tasksRoot, task.id);
        fs.mkdirSync(workerDir, { recursive: true });
        fs.writeFileSync(path.join(workerDir, "prompt.txt"), buildHandoffPrompt(task, plan, projectMemory));
        // Worktrees are created sequentially (git locks the repo per worktree
        // add), branching from the integration tip so dependents see prior waves.
        const workspace = integration
          ? await addTaskWorktree(cwd, sessionId, task.id, baseRef!)
          : cwd;

        try {
          await onDispatchReserve?.(task.id, integration ? { worktree: workspace } : {});
        } catch (error) {
          throw new DurableWriteError("reservation", task.id, error);
        }
        taskDispatches += 1;

        // The reservation is durable now; a signal here leaves it spent without
        // a spawn (never rolled back — the counter only ever grows).
        if (signal?.aborted) { interrupted = true; break; }

        const spec: WorkerSpec = {
          task,
          workerDir,
          workspace,
          timeoutMs: taskTimeoutMs,
          signal: waveSignal.signal,
          tmuxWindow: tmuxWindowName(sessionId, task.id),
          onWorkerStarted: ({ pid, mode, tmuxWindow }) => {
            writeWorkerSentinel(cwd, sessionId, { runId, taskId: task.id, pid, mode, tmuxWindow });
          },
        };
        launched.push({
          spec,
          result: (async () => {
            try {
              const { exitCode, stdout } = await runWorker(spec);
              return parseWorkerOutput(task, stdout, exitCode);
            } finally {
              removeWorkerSentinel(cwd, sessionId, task.id);
            }
          })(),
        });
      }
      waveOutputs = await Promise.all(launched.map((entry) => entry.result));
    } catch (error) {
      await abortLaunchedWorkers(launched, waveSignal);
      throw error;
    } finally {
      waveSignal.dispose();
    }

    const waveTasks = launched.map((entry) => entry.spec.task);

    // Abort boundary 2: right after the workers settled and before any commit.
    // The wave is discarded whole — no commits, no merges, no outputs, tip
    // unmoved. A worker killed mid-flight produces no valid JSON anyway, and
    // rescuing half of it would break exactly-once.
    if (signal?.aborted) {
      interrupted = true;
      print(kleur.yellow(`\n⚠ interrupción: la ola ${waveNumber} se descarta entera (nada se commitea ni mergea)`));
      break;
    }
    if (waveTasks.length === 0) break;

    if (integration) {
      // Per task: commit, attribute ownership, merge, checkpoint. Once this
      // block starts it runs to completion for every task of the wave: the
      // signal is never observed inside it (A1.4).
      for (const [index, task] of waveTasks.entries()) {
        const output = waveOutputs[index]!;
        const commit = await commitTaskWork(launched[index]!.spec.workspace, task.id, task.title);
        if (isPhantomCompletion(task, output, commit.changedFiles)) {
          flagPhantomCompletion(task, output);
        }
        if (output.changedFiles.length === 0) output.changedFiles = commit.changedFiles;

        const violations = taskOwnershipViolations(commit.changedFiles, task);
        if (violations.length > 0) {
          const note = `ownership-violation: ${task.id} touched undeclared files: ${violations.join(", ")}`;
          print(kleur.yellow(`⚠ ${note}`));
          output.reviewerNotes.push(note);
          if (strictOwnership && output.status === "completed") {
            output.status = "failed";
            output.summary += " [failed by --strict-ownership]";
          }
        }

        if (output.status === "completed" && commit.committed) {
          const merged = await mergeTaskBranch(integration, sessionId, task.id);
          if (!merged) {
            output.status = "failed";
            output.summary += " [merge conflict al integrar]";
            output.reviewerNotes.push(`merge-conflict: la rama de ${task.id} no se pudo integrar`);
          }
        }

        // ── critical section: one manifest write, nothing else ──────────
        // A task that merged nothing still checkpoints, so the manifest never
        // lags behind the branch by more than this single write.
        try {
          await onTaskIntegrated?.(task.id, {
            status: checkpointStatus(output.status),
            integrationTip: await integrationTip(integration),
          });
        } catch (error) {
          throw new DurableWriteError("checkpoint", task.id, error);
        }
      }
    } else {
      const afterWave = await listChangedFiles();
      // Only files that changed during this wave count as evidence — dirt that
      // predates the wave must not vouch for a worker that wrote nothing.
      const waveDelta = new Set([...afterWave].filter((file) => !beforeWave!.has(file)));
      for (const [index, task] of waveTasks.entries()) {
        const output = waveOutputs[index]!;
        if (isPhantomCompletion(task, output, waveDelta)) flagPhantomCompletion(task, output);
      }
      const violations = computeOwnershipViolations(
        beforeWave!, afterWave, new Set(waveTasks.flatMap((task) => task.files)),
      );
      if (violations.length > 0) {
        const note = `ownership-violation: wave ${waveNumber} touched undeclared files: ${violations.join(", ")}`;
        print(kleur.yellow(`⚠ ${note}`));
        for (const output of waveOutputs) {
          output.reviewerNotes.push(note);
          if (strictOwnership && output.status === "completed") {
            output.status = "failed";
            output.summary += " [failed by --strict-ownership]";
          }
        }
      }
      for (const [index, task] of waveTasks.entries()) {
        try {
          await onTaskIntegrated?.(task.id, { status: checkpointStatus(waveOutputs[index]!.status) });
        } catch (error) {
          throw new DurableWriteError("checkpoint", task.id, error);
        }
      }
    }

    // Secondary, best-effort work, strictly after every checkpoint returned.
    for (const [index, task] of waveTasks.entries()) {
      const output = waveOutputs[index]!;
      state.set(task.id, output.status === "completed" ? "done" : "failed");
      if (output.status !== "completed") autoSkipDependents(plan.tasks, state, task.id);
      outputs.push(output);
      await onTaskOutput?.(output);
    }

    print(renderStatusTable(plan.tasks, state, waveByTask));
    if (interrupted || budgetExhausted) break;
  }

  if (budgetExhausted) {
    print(kleur.yellow(
      `\n⚠ budget agotado: la cadena consumió ${taskDispatches}/${maxTasks} dispatches; ` +
      "las tareas restantes quedan pendientes (subí --max-tasks para continuar).",
    ));
  }

  // Tasks seeded from the parent count as done for the chain's status, but a
  // run that could not start anything of its own is not "completed".
  const scheduled = plan.tasks.filter((task) => !alreadyDone.includes(task.id));
  const statuses = scheduled.map((task) => state.get(task.id) ?? "pending");
  const status = statuses.length > 0 && statuses.every((taskStatus) => taskStatus === "done")
    ? "completed"
    : statuses.some((taskStatus) => taskStatus === "done") || (statuses.length === 0 && alreadyDone.length > 0)
      ? "partial"
      : "failed";

  if (integration) {
    const tip = await integrationTip(integration);
    if (tip === reviewBaseRef) {
      // Nothing pending review (no task merged anything in the whole chain).
      if (keepWorktrees) {
        print(kleur.dim(`  worktrees conservados en .slad-os/sessions/${sessionId}/worktrees/`));
      } else {
        await removeSessionWorktrees(cwd, sessionId);
      }
      return { status, outputs, interrupted, taskDispatches, budgetExhausted };
    }
    // Review before apply: the main worktree stays untouched and the session
    // worktrees/branches survive until `run --apply` or `run --abort`.
    return {
      status,
      outputs,
      integration: { branch: integration.integrationBranch, baseRef: reviewBaseRef!, tip },
      interrupted,
      taskDispatches,
      budgetExhausted,
    };
  }

  return { status, outputs, interrupted, taskDispatches, budgetExhausted };
}

/** RunOutput status mapped to the manifest task status the checkpoint records. */
function checkpointStatus(status: RunOutput["status"]): "completed" | "blocked" | "failed" | "skipped" {
  return status === "awaiting_human" ? "blocked" : status;
}
