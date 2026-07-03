import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import kleur from "kleur";
import { RunOutput, type PlanOutput, type PlanTask } from "../core/types.js";
import { BUILDER_REVIEWER_SYSTEM } from "../agents/prompts.js";
import { getNextWave, autoSkipDependents, type TaskStatus } from "./dag.js";
import {
  addTaskWorktree,
  assertWorktreeReady,
  commitTaskWork,
  hasUncommittedChanges,
  integrationTip,
  mergeTaskBranch,
  removeSessionWorktrees,
  setupIntegration,
  squashIntoMain,
  type IntegrationSetup,
} from "./worktrees.js";

const exec = promisify(execFile);

// ─── Options and seams ────────────────────────────────────────────────────────

export interface ParallelRunOptions {
  plan: PlanOutput;
  sessionId: string;
  /** Workspace root where workers run (and git is checked). */
  cwd: string;
  maxParallel: number;
  strictOwnership: boolean;
  /**
   * Isolate each task in its own git worktree branched from a session
   * integration branch, merge results sequentially, and squash the final
   * state into the main worktree without committing. Requires a committed
   * HEAD; enables per-task (instead of per-wave) ownership attribution.
   */
  useWorktrees?: boolean;
  /** Keep the session worktrees/branches after the run (debugging). */
  keepWorktrees?: boolean;
  /** Per-task timeout. Default: 15 minutes. */
  taskTimeoutMs?: number;
  /**
   * Cross-agent project memory (~/.agents/memory/projects/<repo>.md) injected
   * into every handoff prompt. Callers resolve it via readProjectMemory().
   */
  projectMemory?: string | null;
  /** Called with each task's RunOutput as it completes (persistence hook). */
  onTaskOutput?: (output: RunOutput) => Promise<void>;
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
}

export type WorkerRunner = (spec: WorkerSpec) => Promise<{
  exitCode: number;
  stdout: string;
}>;

export interface ParallelRunResult {
  status: "completed" | "partial" | "failed";
  outputs: RunOutput[];
}

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
    `Selected task:\n${JSON.stringify(task, null, 2)}`,
    `Al terminar, imprime como ÚLTIMO bloque de tu salida un objeto JSON válido con esta forma exacta (schema RunOutput):\n` +
      `{"taskId": "${task.id}", "status": "completed" | "blocked" | "failed", "summary": string, "changedFiles": string[], "verification": [{"command": string, "status": "passed" | "failed" | "not_run", "notes": string}], "decisions": [], "questions": [], "humanAnswers": {}, "followUps": string[], "reviewerNotes": string[]}`,
  ].join("\n\n");
}

// ─── Worker output parsing ────────────────────────────────────────────────────

/**
 * Extracts the last valid RunOutput JSON object from a worker's stdout.
 * Falls back to a synthetic RunOutput derived from the exit code when the
 * worker did not emit parseable structured output.
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

  const failed = exitCode !== 0;
  return {
    taskId: task.id,
    status: failed ? "failed" : "completed",
    summary: failed
      ? `Worker exited with code ${exitCode} without structured output.`
      : "Worker finished without structured output; result not verified.",
    changedFiles: [],
    decisions: [],
    questions: [],
    humanAnswers: {},
    followUps: [],
    verification: [],
    reviewerNotes: failed ? [] : ["missing-run-output-json"],
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

async function gitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    const files = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // porcelain: "XY path" or "XY old -> new" for renames
      const pathPart = line.slice(3);
      const renamed = pathPart.split(" -> ");
      files.add((renamed[renamed.length - 1] ?? pathPart).trim());
    }
    return files;
  } catch {
    return new Set(); // not a git repo — ownership check becomes a no-op
  }
}

// ─── Worker execution (tmux window or plain child process) ───────────────────

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Builds the worker shell script from the SLAD_CLI_* env set by resolveProvider. */
export function buildWorkerScript(workspace: string, workerDir: string): string {
  const binary = process.env.SLAD_CLI_BINARY?.trim() || "codex";
  const args = (process.env.SLAD_CLI_ARGS ?? "").split(/\s+/).filter(Boolean);
  const promptMode = process.env.SLAD_CLI_PROMPT_MODE?.trim() || "arg";
  const model = process.env.CLI_MODEL?.trim();
  const modelArg = process.env.SLAD_CLI_MODEL_ARG?.trim();
  if (model && modelArg) args.push(modelArg, model);

  const promptPath = path.join(workerDir, "prompt.txt");
  const outputPath = path.join(workerDir, "output.txt");
  const exitCodePath = path.join(workerDir, "exit-code");
  const command = [shq(binary), ...args.map(shq)].join(" ");
  const invocation =
    promptMode === "stdin"
      ? `${command} < ${shq(promptPath)}`
      : `${command} "$(cat ${shq(promptPath)})"`;

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

async function waitForSentinel(exitCodePath: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(exitCodePath)) {
      const raw = fs.readFileSync(exitCodePath, "utf8").trim();
      return Number.parseInt(raw, 10) || 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const defaultRunWorker: WorkerRunner = async ({ task, workerDir, workspace, timeoutMs }) => {
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
      const windowName = `slad-${task.id}`;
      await exec("tmux", ["new-window", "-d", "-n", windowName, `sh ${shq(scriptPath)}`]);
      exitCode = await waitForSentinel(exitCodePath, timeoutMs);
      if (exitCode === null) {
        await exec("tmux", ["kill-window", "-t", windowName]).catch(() => undefined);
      }
    } else {
      const child = spawn("sh", [scriptPath], { stdio: "ignore", detached: false });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
      clearTimeout(timer);
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

export async function runParallel(options: ParallelRunOptions): Promise<ParallelRunResult> {
  const {
    plan,
    sessionId,
    cwd,
    maxParallel,
    strictOwnership,
    useWorktrees = false,
    keepWorktrees = false,
    taskTimeoutMs = 15 * 60_000,
    projectMemory = null,
    onTaskOutput,
    print = console.log,
  } = options;
  const runWorker = options.runWorker ?? defaultRunWorker;
  const listChangedFiles = options.listChangedFiles ?? (() => gitChangedFiles(cwd));

  let integration: IntegrationSetup | null = null;
  if (useWorktrees) {
    await assertWorktreeReady(cwd);
    if (await hasUncommittedChanges(cwd)) {
      print(kleur.yellow("⚠ Hay cambios sin commitear: los workers parten de HEAD y no los verán."));
    }
    integration = await setupIntegration(cwd, sessionId);
  }

  const tasksRoot = path.join(cwd, ".slad-os", "sessions", sessionId, "tasks");
  const state = new Map<string, TaskStatus>(plan.tasks.map((task) => [task.id, "pending"]));
  const waveByTask = new Map<string, number>();
  const outputs: RunOutput[] = [];
  let waveNumber = 0;

  for (;;) {
    const wave = getNextWave(plan.tasks, state, maxParallel);
    if (wave.length === 0) break;
    waveNumber++;

    for (const task of wave) waveByTask.set(task.id, waveNumber);
    print(kleur.bold(`\nWave ${waveNumber}: `) + wave.map((task) => task.id).join(", "));

    // Worktrees are created sequentially (git locks the repo per worktree add),
    // branching from the integration tip so dependents see prior waves' work.
    const baseRef = integration ? await integrationTip(integration) : null;
    const specs: WorkerSpec[] = [];
    for (const task of wave) {
      const workerDir = path.join(tasksRoot, task.id);
      fs.mkdirSync(workerDir, { recursive: true });
      fs.writeFileSync(path.join(workerDir, "prompt.txt"), buildHandoffPrompt(task, plan, projectMemory));
      const workspace = integration
        ? await addTaskWorktree(cwd, sessionId, task.id, baseRef!)
        : cwd;
      specs.push({ task, workerDir, workspace, timeoutMs: taskTimeoutMs });
    }

    const beforeWave = integration ? null : await listChangedFiles();

    const waveOutputs = await Promise.all(
      specs.map(async (spec) => {
        const { exitCode, stdout } = await runWorker(spec);
        return parseWorkerOutput(spec.task, stdout, exitCode);
      }),
    );

    if (integration) {
      // Per-task: commit the worktree, attribute ownership, merge sequentially.
      for (const [index, task] of wave.entries()) {
        const output = waveOutputs[index]!;
        const commit = await commitTaskWork(specs[index]!.workspace, task.id, task.title);
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
      }
    } else {
      const afterWave = await listChangedFiles();
      const violations = computeOwnershipViolations(beforeWave!, afterWave, new Set(wave.flatMap((task) => task.files)));
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
    }

    for (const [index, task] of wave.entries()) {
      const output = waveOutputs[index]!;
      state.set(task.id, output.status === "completed" ? "done" : "failed");
      if (output.status !== "completed") autoSkipDependents(plan.tasks, state, task.id);
      outputs.push(output);
      await onTaskOutput?.(output);
    }

    print(renderStatusTable(plan.tasks, state, waveByTask));
  }

  if (integration) {
    const squashError = await squashIntoMain(cwd, integration);
    if (squashError) {
      print(kleur.red(
        `⚠ No se pudo aplicar el resultado al worktree principal: ${squashError}\n` +
        `  Los cambios integrados quedan en la rama ${integration.integrationBranch}.`,
      ));
    } else if (keepWorktrees) {
      print(kleur.dim(`  worktrees conservados en .slad-os/sessions/${sessionId}/worktrees/`));
    } else {
      await removeSessionWorktrees(cwd, sessionId);
    }
  }

  const statuses = [...state.values()];
  const status = statuses.every((taskStatus) => taskStatus === "done")
    ? "completed"
    : statuses.some((taskStatus) => taskStatus === "done")
      ? "partial"
      : "failed";
  return { status, outputs };
}
