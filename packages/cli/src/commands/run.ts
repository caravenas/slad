
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import ora from "ora";
import kleur from "kleur";
import { runSladPipeline } from "@slad/pipeline";
import { applyRecordedBackendEnv, getModel, loadConfig, resolveProvider, settingsValue } from "../core/config.js";
import { resolveBackendBinary } from "../core/backend-registry.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { writeArtifact, type ReadPlanResult } from "../persistence/index.js";
import { readProjectMemory } from "../persistence/global-memory.js";
import { createHitlTransport } from "@slad/hitl";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "@slad/harness";
import * as prompts from "../agents/prompts.js";
import { getActiveSession, appendArtifact, readSessionPlan, saveSession } from "../core/session.js";
import { AgentName, PlanOutput, ProviderName, type PlanArtifactEnvelope, type RunOutput } from "../core/types.js";
import { ProviderError } from "../core/errors.js";
import { DurableWriteError, runParallel } from "./run-parallel.js";
import {
  applyIntegrationBranch,
  branchTip,
  describeIntegration,
  removeSessionWorktrees,
  sessionBranch,
  sessionRefSuffix,
  listSessionRefs,
  listSessionWorktreePaths,
  hasUncommittedChanges,
} from "./worktrees.js";
import { gatePlanPreflight, printPlanPreflight } from "../core/plan-preflight.js";
import {
  checkpointTaskIntegration,
  completeRunManifest,
  createRunManifest,
  interruptStaleRunManifests,
  markRunInterrupted,
  markRunUnrecoverable,
  readRunManifest,
  recordIntegration,
  reserveTaskDispatch,
  runManifestPath,
  sha256File,
  updateRunManifest,
  type RunManifestHandle,
} from "../persistence/manifest.js";
import { loadLifecycleHooks, runPostLifecycleHooks, runPreLifecycleHooks } from "../core/lifecycle-hooks.js";
import { createInterruptScope, INTERRUPT_EXIT_CODE } from "../core/interrupt.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  type SessionLockCommand,
  type SessionLockHandle,
} from "../core/session-lock.js";
import {
  clearWorkerSentinels,
  inspectWorkers,
  killSessionTmuxWindows,
  workerGuardMessage,
} from "../core/worker-sentinels.js";
import { collectSessionResidue, formatResidueRefusal, hasResidue } from "../core/session-residue.js";

export interface RunOpts {
  input?: string;
  task?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  maxRounds?: number;
  auto?: boolean;
  maxTasks?: number;
  skipSession?: boolean;
  harness?: "off" | "on" | "strict";
  tools?: boolean;
  nonInteractive?: boolean;
  parallel?: boolean;
  maxParallel?: number;
  strictOwnership?: boolean;
  worktrees?: boolean;
  keepWorktrees?: boolean;
  bypass?: boolean;
  /** Inspecciona un run --worktrees pendiente de review (read-only). */
  review?: string;
  /** Aplica la integración de un run review_pending como cambios staged. */
  apply?: string;
  /** Descarta la integración de un run review_pending sin tocar main. */
  abort?: string;
  /** Ejecuta el plan activo como follow-up desde el tip de integración de un run review_pending. */
  fromReview?: string;
  /** Reanuda un run interrumpido por señal controlada (recovery.safe). */
  resume?: string;
  /** Escape hatch del lock de sesión: exige copiar el runId del tenedor. */
  forceUnlock?: string;
  /** Escape hatch de los sentinels: borra sin enviar ninguna señal. */
  assumeWorkersDead?: boolean;
  /** Fuerza el gate de ownership al reanudar un padre sin `policy` registrada. */
  noStrictOwnership?: boolean;
}

// ─── Session lock / worker guards shared by the mutating commands ────────────

/** Takes the session lock, printing the refusal itself. Null means blocked. */
function takeSessionLock(
  cwd: string,
  sessionId: string,
  runId: string,
  command: SessionLockCommand,
  forceUnlock?: string,
): SessionLockHandle | null {
  const result = acquireSessionLock(cwd, sessionId, { runId, command, forceUnlock });
  if (result.ok) return result.lock;
  log.error(result.reason);
  return null;
}

/**
 * `--resume`, `--apply` and `--abort` all delete session worktrees or move a
 * branch a worker could still be writing to, so all three refuse while any
 * worker is alive or unprovable. Sentinels of workers proven dead are cleared;
 * `--assume-workers-dead` clears the rest *without sending any signal*.
 * `--review` is read-only and does not take this guard.
 */
function workerGuard(
  cwd: string,
  sessionId: string,
  command: string,
  assumeWorkersDead?: boolean,
): boolean {
  const inspection = inspectWorkers(cwd, sessionId);
  clearWorkerSentinels(inspection.dead);
  const blocking = [...inspection.alive, ...inspection.unknown];
  if (blocking.length === 0) return true;
  if (assumeWorkersDead) {
    clearWorkerSentinels(blocking);
    log.warn(`--assume-workers-dead: ${blocking.length} sentinel(s) borrados sin enviar ninguna señal.`);
    return true;
  }
  log.error(workerGuardMessage(command, sessionId, blocking));
  return false;
}

// ─── Review-before-apply actions (worktree runs) ─────────────────────────────

async function loadRunManifestById(runId: string, cwd: string): Promise<RunManifestHandle | null> {
  try {
    return await readRunManifest(runManifestPath(runId, cwd));
  } catch {
    log.error(`No se encontró el manifest del run ${runId} en .slad-os/runs/.`);
    return null;
  }
}

/**
 * Integration metadata of a run that can still be applied/aborted/continued.
 * Logs the reason and returns null when the run is not in that state.
 *
 * `interrupted` is included: an interrupted run's work must stay applicable
 * regardless of whether it is natively resumable, because the alternative is
 * that the only way out of a class-B death is manual git surgery.
 */
function pendingIntegration(handle: RunManifestHandle, allow: readonly string[] = ["review_pending", "interrupted"]) {
  const { runId, status, worktrees } = handle.value;
  if (!worktrees.enabled || !worktrees.integration) {
    log.error(`El run ${runId} no es un run --worktrees con integración registrada.`);
    return null;
  }
  if (!allow.includes(status)) {
    log.error(
      `El run ${runId} no está ${allow.join(" ni ")} (status: ${status}); no hay nada que aplicar ni abortar.`,
    );
    return null;
  }
  return worktrees.integration;
}

/**
 * Class-B diagnosis (§7.2). The run died without a signal handler, so the
 * manifest cannot be trusted to describe the branch. Nothing is executed and
 * nothing is deleted: the branch stays alive and the human decides.
 */
async function printUnrecoverableDiagnosis(handle: RunManifestHandle, cwd: string): Promise<void> {
  const { runId, worktrees, sessionId } = handle.value;
  const integration = worktrees.integration;
  log.error(
    `El run ${runId} terminó sin handler de señal (SIGKILL, crash o corte); no es reanudable de forma nativa.`,
  );
  if (integration) {
    const realTip = await branchTip(cwd, integration.branch);
    log.dim(`  rama:            ${integration.branch}`);
    log.dim(`  tip registrado:  ${integration.tip.slice(0, 12)}  (manifest)`);
    log.dim(`  tip real:        ${(realTip ?? "(la rama ya no existe)").slice(0, 12)}  (git)`);
  }
  const alive = inspectWorkers(cwd, sessionId);
  const blocking = [...alive.alive, ...alive.unknown];
  if (blocking.length > 0) {
    log.dim(`  workers vivos:   ${blocking.map((worker) => `${worker.sentinel.taskId} (pid ${worker.sentinel.pid}, host ${worker.sentinel.host})`).join(", ")}`);
  }
  console.log("");
  if (integration) {
    log.dim(`  git log --oneline ${integration.baseRef.slice(0, 12)}..${integration.branch}    ver qué quedó integrado`);
  }
  log.dim(`  slad pipeline run --review ${runId}                            ver la foto del manifest`);
  log.dim(`  slad pipeline run --apply ${runId}                             solo si el tip real coincide con el registrado`);
  log.dim(`  slad pipeline run --abort ${runId}                             descarta la integración sin tocar main`);
}

export async function reviewRunAction(runId: string, cwd: string = process.cwd()): Promise<void> {
  const handle = await loadRunManifestById(runId, cwd);
  if (!handle) {
    process.exitCode = 1;
    return;
  }
  const { value } = handle;
  const integration = value.worktrees.integration;
  if (!value.worktrees.enabled || !integration) {
    log.error(`El run ${runId} no es un run --worktrees con integración registrada.`);
    process.exitCode = 1;
    return;
  }

  log.title(`Review · ${runId} · ${value.status}`);
  log.dim(`  sesión: ${value.sessionId}`);
  log.dim(`  rama:   ${integration.branch}`);
  log.dim(`  rango:  ${integration.baseRef.slice(0, 12)} → ${integration.tip.slice(0, 12)}`);
  if (integration.fromRun) log.dim(`  continúa el run ${integration.fromRun}`);

  const summary = await describeIntegration(cwd, integration.baseRef, integration.tip);
  console.log("\n" + kleur.bold("Commits pendientes:"));
  console.log(summary.commits || "(sin commits)");
  console.log("\n" + kleur.bold("Diff:"));
  console.log(summary.diffStat || "(sin cambios)");

  console.log("\n" + kleur.bold("Tareas:"));
  for (const task of value.tasks) {
    const icon = task.status === "completed" ? kleur.green("✓") : task.status === "pending" ? "·" : kleur.red("✗");
    const artifactNote = task.artifactError ? kleur.yellow(`  artefacto no escrito: ${task.artifactError}`) : "";
    console.log(`  ${icon} ${task.taskId} ${task.status}${artifactNote}`);
  }

  if (value.policy) {
    log.dim(
      `\n  política: strict-ownership ${value.policy.strictOwnership ? "on" : "off"}` +
      `, dispatches ${value.policy.taskDispatches ?? "?"}/${value.limits.maxTasks ?? "?"}`,
    );
  }

  if (value.status === "review_pending" || value.status === "interrupted") {
    if (value.status === "interrupted") {
      log.dim(
        value.recovery?.safe
          ? `\n  interrumpido por ${value.recovery.signal ?? "señal"}; el manifest es exacto y el run es reanudable.`
          : "\n  interrumpido sin handler de señal; no es reanudable de forma nativa (solo --apply / --abort).",
      );
      if (value.recovery?.safe) log.dim(`  slad pipeline run --resume ${runId}  continúa donde se cortó`);
    }
    log.dim(`  slad pipeline run --apply ${runId}   aplica el resultado como cambios staged`);
    log.dim(`  slad pipeline run --abort ${runId}   descarta la integración sin tocar main`);
  }
}

export async function applyRunAction(
  runId: string,
  cwd: string = process.cwd(),
  opts: Pick<RunOpts, "assumeWorkersDead" | "forceUnlock"> = {},
): Promise<void> {
  const handle = await loadRunManifestById(runId, cwd);
  const integration = handle ? pendingIntegration(handle) : null;
  if (!handle || !integration) {
    process.exitCode = 1;
    return;
  }
  const sessionId = handle.value.sessionId;

  const lock = takeSessionLock(cwd, sessionId, runId, "apply", opts.forceUnlock);
  if (!lock) {
    process.exitCode = 1;
    return;
  }
  try {
    // A live worker can still move the branch being squashed, and a keep=false
    // apply then deletes the worktree underneath it.
    if (!workerGuard(cwd, sessionId, `aplicar el run ${runId}`, opts.assumeWorkersDead)) {
      process.exitCode = 1;
      return;
    }

    const hooks = loadLifecycleHooks(cwd);
    try {
      await runPreLifecycleHooks(hooks, "pre-apply", {
        event: "pre-apply",
        command: "apply",
        cwd,
        runId,
        integration,
      });
    } catch (err) {
      log.error((err as Error).message);
      process.exitCode = 1;
      return;
    }

    const error = await applyIntegrationBranch(cwd, {
      branch: integration.branch,
      baseRef: integration.baseRef,
      expectedTip: integration.tip,
    });
    if (error) {
      log.error(`No se pudo aplicar el run ${runId}: ${error}`);
      log.dim(`  La integración sigue intacta en ${integration.branch}.`);
      process.exitCode = 1;
      return;
    }

    await completeRunManifest(handle, "applied", "review applied: squash staged en el worktree principal");
    if (!handle.value.worktrees.keep) {
      await removeSessionWorktrees(cwd, sessionId);
    }
    await runPostLifecycleHooks(hooks, "post-apply", {
      event: "post-apply",
      command: "apply",
      cwd,
      runId,
      status: "applied",
    });
    log.success(`Run ${runId} aplicado: el resultado quedó staged en el worktree principal, sin commits.`);
    log.dim("  Revisá con `git diff --cached` y commiteá cuando estés conforme.");
  } finally {
    releaseSessionLock(lock);
  }
}

export async function abortRunAction(
  runId: string,
  cwd: string = process.cwd(),
  opts: Pick<RunOpts, "assumeWorkersDead" | "forceUnlock"> = {},
): Promise<void> {
  const handle = await loadRunManifestById(runId, cwd);
  const integration = handle ? pendingIntegration(handle) : null;
  if (!handle || !integration) {
    process.exitCode = 1;
    return;
  }
  const sessionId = handle.value.sessionId;

  const lock = takeSessionLock(cwd, sessionId, runId, "abort", opts.forceUnlock);
  if (!lock) {
    process.exitCode = 1;
    return;
  }
  try {
    // removeSessionWorktrees force-removes the worktree a live worker is
    // writing into; the guard refuses instead of racing it.
    if (!workerGuard(cwd, sessionId, `abortar el run ${runId}`, opts.assumeWorkersDead)) {
      process.exitCode = 1;
      return;
    }

    const tip = await branchTip(cwd, integration.branch);
    if (tip !== integration.tip) {
      log.error(
        tip === null
          ? `No se pudo abortar el run ${runId}: la rama de integración ${integration.branch} ya no existe.`
          : `No se pudo abortar el run ${runId}: la rama ${integration.branch} se movió desde el run.`,
      );
      process.exitCode = 1;
      return;
    }

    await removeSessionWorktrees(cwd, sessionId);
    await completeRunManifest(handle, "aborted", "review aborted: integración descartada sin tocar el worktree principal");
    log.success(`Run ${runId} abortado: ramas y worktrees de la sesión eliminados; el worktree principal quedó intacto.`);
  } finally {
    releaseSessionLock(lock);
  }
}

/** Everything `--resume` inherits from its parent, once every guard passed. */
interface ResumeContext {
  parent: RunManifestHandle;
  integration: NonNullable<RunManifestHandle["value"]["worktrees"]["integration"]>;
  backend: RunManifestHandle["value"]["backend"];
  /** Parent tasks already `completed`: the skip set (I2), valid by I0. */
  skipSet: string[];
  /** Parent task entries copied into the child so --review shows the chain. */
  inheritedTasks: RunManifestHandle["value"]["tasks"];
  strictOwnership: boolean;
  taskDispatches: number;
  maxTasks: number;
}

/**
 * Guards of §7.1, in order, with the session lock already held by the caller.
 * Nothing creates state before all of them pass; a rejection returns null
 * after printing the reason.
 */
async function resolveResume(
  runId: string,
  opts: RunOpts,
  sessionId: string,
  planEnvelope: PlanArtifactEnvelope,
  cwd: string,
): Promise<ResumeContext | null> {
  const parent = await loadRunManifestById(runId, cwd);
  if (!parent) return null;
  const { value } = parent;

  // 2 — a run without worktrees is not resumable: no isolation, no exactly-once.
  if (!value.worktrees.enabled || !value.worktrees.integration) {
    log.error(`El run ${runId} no es un run --worktrees con integración registrada; no se puede reanudar.`);
    return null;
  }
  const integration = value.worktrees.integration;

  // 3 — status.
  if (value.status !== "interrupted") {
    log.error(
      value.status === "review_pending"
        ? `El run ${runId} está review_pending, no interrumpido; continualo con --from-review ${runId}.`
        : `El run ${runId} no está interrupted (status: ${value.status}); no hay nada que reanudar.`,
    );
    return null;
  }

  // 4 — class A only. A missing `recovery` is a pre-change manifest and fails safe.
  if (value.recovery?.safe !== true) {
    await printUnrecoverableDiagnosis(parent, cwd);
    return null;
  }

  // 5 — same session.
  if (value.sessionId !== sessionId) {
    log.error(
      `El run ${runId} pertenece a la sesión ${value.sessionId}, no a la activa (${sessionId}). ` +
      "Reanudá esa sesión (slad pipeline session use) antes de continuar.",
    );
    return null;
  }

  // 6 — same approved plan. A parent run with --bypass never became approved,
  // so resume can never be an indirect way to inherit a bypass.
  if (value.plan?.approval !== "approved") {
    log.error(`El run ${runId} no corrió sobre un plan aprobado (approval: ${value.plan?.approval ?? "sin plan"}); no se reanuda.`);
    return null;
  }
  if (value.plan.hash !== planEnvelope.approval.planHash ||
      (value.plan.planId !== undefined && value.plan.planId !== planEnvelope.planId)) {
    log.error(
      `El plan activo cambió desde el run ${runId} (hash ${planEnvelope.approval.planHash.slice(0, 12)} ≠ ` +
      `${value.plan.hash.slice(0, 12)}); reanudar ejecutaría otro plan.`,
    );
    return null;
  }

  const resolvedProvider = ProviderName.safeParse(value.backend.provider);
  if (!resolvedProvider.success) {
    log.error(
      `El run ${runId} registró provider "${value.backend.provider}" no soportado; no se puede reanudar con seguridad.`,
    );
    return null;
  }
  if (!value.backend.agent || !value.backend.model) {
    log.error(
      `El run ${runId} no registró agent/model (manifest anterior a este cambio); ` +
      "no se puede reanudar sin saber qué backend replicar.",
    );
    return null;
  }
  const resolvedAgent = AgentName.safeParse(value.backend.agent);
  if (!resolvedAgent.success) {
    log.error(
      `El run ${runId} registró agent "${value.backend.agent}" no soportado; no se puede reanudar con seguridad.`,
    );
    return null;
  }
  try {
    const configuredBinary = settingsValue<string>(["providers", "binaries", resolvedAgent.data]);
    const binary = resolveBackendBinary(resolvedAgent.data, configuredBinary);
    if (binary.status !== "resolved" || !binary.resolvedPath) {
      log.error(
        `El run ${runId} no puede reanudar con agent ${resolvedAgent.data}: ` +
        `${binary.reason ?? "no hay binario ejecutable disponible."}`,
      );
      return null;
    }
  } catch (error) {
    log.error(
      `El run ${runId} no puede reanudar con agent ${resolvedAgent.data}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // 7 — ownership policy: absent must stay distinguishable from off.
  let strictOwnership: boolean;
  if (opts.strictOwnership || opts.noStrictOwnership) {
    strictOwnership = opts.strictOwnership === true;
  } else if (value.policy) {
    strictOwnership = value.policy.strictOwnership;
  } else {
    log.error(
      `El run ${runId} no registró su política de ownership (manifest anterior a este cambio). ` +
      "Pasá --strict-ownership o --no-strict-ownership explícitamente para reanudarlo.",
    );
    return null;
  }

  // 8 — exact tip. No reconciliation, no exceptions: I0 guarantees equality.
  const tip = await branchTip(cwd, integration.branch);
  if (tip !== integration.tip) {
    log.error(
      tip === null
        ? `La rama de integración ${integration.branch} ya no existe; no se puede reanudar el run ${runId}.`
        : `La rama ${integration.branch} se movió desde el run ${runId} ` +
          `(tip ${tip.slice(0, 12)} ≠ manifest ${integration.tip.slice(0, 12)}); no se reanuda con seguridad.`,
    );
    return null;
  }

  // 8b — every ref and worktree under the session namespace is attributable to
  // the integration or to a task of the parent manifest.
  const parentTaskIds = new Set(value.tasks.map((task) => task.taskId));
  const strayRefs = (await listSessionRefs(cwd, sessionId)).filter(({ branch }) => {
    if (branch === integration.branch) return false;
    const suffix = sessionRefSuffix(branch, sessionId);
    return suffix === null || !parentTaskIds.has(suffix);
  });
  const strayWorktrees = (await listSessionWorktreePaths(cwd, sessionId)).filter((worktreePath) => {
    const base = path.basename(worktreePath);
    return base !== "_integration" && !parentTaskIds.has(base);
  });
  if (strayRefs.length > 0 || strayWorktrees.length > 0) {
    log.error(
      `La sesión ${sessionId} tiene residuo que no pertenece a ninguna tarea del run ${runId}; no se reanuda.\n\n` +
      [
        ...strayRefs.map(({ branch, tip: refTip }) => `  ref        ${branch}  ${refTip.slice(0, 7)}`),
        ...strayWorktrees.map((worktreePath) => `  worktree   ${worktreePath}`),
        "",
        "  Residuo sin dueño (SLAD no lo toca):",
        ...strayRefs.map(({ branch }) => `    git branch -D ${branch}`),
        ...strayWorktrees.map((worktreePath) => `    git worktree remove --force ${worktreePath}`),
      ].join("\n"),
    );
    return null;
  }

  // 9 — the later squash assumes this base.
  const head = await currentHead(cwd);
  if (head !== integration.baseRef) {
    log.error(
      `El worktree principal se movió desde el run ${runId} (HEAD ${(head ?? "?").slice(0, 12)} ≠ ` +
      `base ${integration.baseRef.slice(0, 12)}); el apply posterior asumía esa base.`,
    );
    return null;
  }
  if (await hasUncommittedChanges(cwd)) {
    log.error("El worktree principal tiene cambios sin commitear; commiteá o stasheá antes de reanudar.");
    return null;
  }

  // 10 — workers.
  if (!workerGuard(cwd, sessionId, `reanudar el run ${runId}`, opts.assumeWorkersDead)) return null;

  // 11 — chain budget. --max-tasks can only go up, and strictly above what the
  // chain already spent.
  const taskDispatches = value.policy?.taskDispatches;
  if (taskDispatches === undefined) {
    log.error(
      `El run ${runId} no registró dispatches consumidos (manifest anterior a este cambio). ` +
      "Pasá --max-tasks explícitamente para reanudarlo.",
    );
    if (opts.maxTasks === undefined) return null;
  }
  const spent = taskDispatches ?? 0;
  const inheritedMax = value.limits.maxTasks ?? 10;
  let maxTasks = inheritedMax;
  if (opts.maxTasks !== undefined) {
    if (opts.maxTasks < inheritedMax) {
      log.error(
        `--max-tasks ${opts.maxTasks} es menor que el budget de la cadena (${inheritedMax}); ` +
        "bajar el budget de una cadena en curso no tiene semántica útil.",
      );
      return null;
    }
    if (opts.maxTasks <= spent) {
      log.error(`--max-tasks ${opts.maxTasks} no supera los ${spent} dispatches ya consumidos por la cadena.`);
      return null;
    }
    maxTasks = opts.maxTasks;
  } else if (maxTasks - spent <= 0) {
    log.error(
      `La cadena del run ${runId} agotó su budget (${spent}/${inheritedMax} dispatches). ` +
      `Subilo con --max-tasks <n> (> ${spent}) para continuar.`,
    );
    return null;
  }

  const skipSet = value.tasks.filter((task) => task.status === "completed").map((task) => task.taskId);
  return {
    parent,
    integration,
    backend: {
      provider: resolvedProvider.data,
      agent: resolvedAgent.data,
      model: value.backend.model,
    },
    skipSet,
    // Only the completed entries carry over: failure is never inherited (I6),
    // and a `skipped` that was mere cascade of a killed worker goes back to
    // pending on its own.
    inheritedTasks: value.tasks.filter((task) => task.status === "completed"),
    strictOwnership,
    taskDispatches: spent,
    maxTasks,
  };
}

const exec = promisify(execFile);

async function currentHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function runCommand(opts: RunOpts): Promise<void> {
  const cwd = process.cwd();

  // Invalid flag combinations fail fast, before any session read or manifest.
  const reviewActions = [opts.review, opts.apply, opts.abort].filter(Boolean);
  if (reviewActions.length > 1) {
    log.error("--review, --apply y --abort son mutuamente exclusivos.");
    process.exitCode = 1;
    return;
  }
  if (reviewActions.length === 1 &&
      (opts.parallel || opts.worktrees || opts.keepWorktrees || opts.fromReview || opts.auto || opts.task || opts.bypass || opts.resume)) {
    log.error("--review/--apply/--abort operan sobre un run ya ejecutado y no se combinan con flags de ejecución.");
    process.exitCode = 1;
    return;
  }
  if (opts.resume) {
    // --resume replays a recorded decision: every flag that would change what
    // runs, how it is isolated, or whether approval is required is refused.
    const conflicting = [
      ["--parallel", opts.parallel], ["--worktrees", opts.worktrees], ["--keep-worktrees", opts.keepWorktrees],
      ["--from-review", opts.fromReview], ["--review", opts.review], ["--apply", opts.apply],
      ["--abort", opts.abort], ["--task", opts.task], ["--auto", opts.auto], ["--bypass", opts.bypass],
      ["--agent", opts.agent], ["--provider", opts.provider], ["--model", opts.model],
    ].filter(([, value]) => Boolean(value)).map(([flag]) => flag as string);
    if (conflicting.length > 0) {
      log.error(`--resume no se combina con ${conflicting.join(", ")}: reanuda el run tal como fue configurado.`);
      process.exitCode = 1;
      return;
    }
  }
  if (opts.strictOwnership && opts.noStrictOwnership) {
    log.error("--strict-ownership y --no-strict-ownership son mutuamente exclusivos.");
    process.exitCode = 1;
    return;
  }
  if (opts.worktrees && !opts.parallel) {
    log.error("--worktrees requiere --parallel: el modo worktrees solo aplica al run paralelo.");
    process.exitCode = 1;
    return;
  }
  if (opts.keepWorktrees && !opts.worktrees) {
    log.error("--keep-worktrees requiere --worktrees: sin worktrees no hay nada que conservar.");
    process.exitCode = 1;
    return;
  }
  if (opts.fromReview && !(opts.parallel && opts.worktrees)) {
    log.error("--from-review requiere --parallel --worktrees: el follow-up continúa la integración en worktrees.");
    process.exitCode = 1;
    return;
  }

  if (opts.review) return reviewRunAction(opts.review, cwd);
  if (opts.apply) return applyRunAction(opts.apply, cwd, opts);
  if (opts.abort) return abortRunAction(opts.abort, cwd, opts);

  const session = opts.skipSession ? null : getActiveSession(cwd);
  const intent = session?.intent ?? "continue plan execution";

  if (!session) {
    log.error("No hay sesión activa. Ejecuta /auto o /explore primero.");
    process.exitCode = 1;
    return;
  }

  // §5 — the session lock is guard 1: every guard after it reads state another
  // process could be mutating. Git's own worktree lock is per-operation, not
  // per-session, so two concurrent resumes would both pass and the second one
  // would clean the worktrees the first is using.
  const runId = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const needsLock = Boolean(opts.resume) || Boolean(opts.fromReview) || Boolean(opts.parallel && opts.worktrees);
  let lock: SessionLockHandle | null = null;
  if (needsLock) {
    lock = takeSessionLock(cwd, session.id, runId, opts.resume ? "resume" : "run", opts.forceUnlock);
    if (!lock) {
      process.exitCode = 1;
      return;
    }
  }
  const releaseLock = (): void => {
    if (!lock) return;
    releaseSessionLock(lock);
    lock = null;
  };

  try {
    await runCommandLocked(opts, { cwd, session, intent, runId, releaseLock });
  } finally {
    releaseLock();
  }
}

interface LockedRunContext {
  cwd: string;
  session: NonNullable<ReturnType<typeof getActiveSession>>;
  intent: string;
  runId: string;
  releaseLock: () => void;
}

async function runCommandLocked(opts: RunOpts, ctx: LockedRunContext): Promise<void> {
  const { cwd, session, intent, runId, releaseLock } = ctx;

  // Load the normalized plan envelope — execution requires explicit approval.
  let planRead: ReadPlanResult | null;
  try {
    planRead = await readSessionPlan(session);
  } catch {
    planRead = null;
  }
  if (!planRead) {
    log.error("No se encontró un plan para esta sesión. Ejecuta /plan primero.");
    process.exitCode = 1;
    return;
  }
  const planEnvelope: PlanArtifactEnvelope = planRead.value;
  const planInput: unknown = planEnvelope.plan;

  // Preflight gates every execution path before any manifest is created.
  // --bypass only skips the missing-approval blocker; integrity blockers
  // (digest/hash, task graph, declared paths) always stop the run.
  const gate = gatePlanPreflight(planEnvelope, "run", {
    bypass: opts.bypass,
    expectedSession: { id: session.id, intent: session.intent },
    staleApproval: planRead.staleApproval,
  });
  printPlanPreflight(gate, planRead.warnings);
  if (!gate.ok) {
    if (gate.blockers.some((issue) => issue.code === "approval.status.not-approved")) {
      log.dim("  Aprobalo con `slad pipeline plan --approve` o usá --bypass bajo tu responsabilidad.");
    }
    log.error("Preflight bloqueó la ejecución; el plan no puede correr en este estado.");
    process.exitCode = 1;
    return;
  }

  const parsedPlan = PlanOutput.parse(planInput);
  const taskById = new Map(parsedPlan.tasks.map((task) => [task.id, task]));
  const hooks = loadLifecycleHooks(cwd);

  // --resume: continue a run interrupted by a caught signal. Every guard of
  // §7.1 resolves before any state is created.
  let resumeContext: ResumeContext | null = null;
  if (opts.resume) {
    resumeContext = await resolveResume(opts.resume, opts, session.id, planEnvelope, cwd);
    if (!resumeContext) {
      process.exitCode = 1;
      return;
    }
  }

  const config = loadConfig();
  const providerName = resumeContext
    ? ProviderName.parse(resumeContext.backend.provider)
    : resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
  const agentName = resumeContext ? resumeContext.backend.agent : opts.agent ?? config.defaultAgent;
  const selectedModel = resumeContext ? resumeContext.backend.model ?? "" : opts.model ?? getModel(providerName);
  if (resumeContext && agentName) {
    applyRecordedBackendEnv(AgentName.parse(agentName), selectedModel);
  }

  // --from-review: the follow-up plan runs on top of the parent run's not-yet-
  // applied integration. All guards resolve before any manifest is created.
  let parentReview: RunManifestHandle | null = null;
  let fromIntegration: { ref: string; baseRef: string } | undefined;
  if (opts.fromReview) {
    parentReview = await loadRunManifestById(opts.fromReview, cwd);
    const parentIntegration = parentReview
      ? pendingIntegration(parentReview, ["review_pending"])
      : null;
    if (!parentReview || !parentIntegration) {
      process.exitCode = 1;
      return;
    }
    if (parentReview.value.sessionId !== session.id) {
      log.error(
        `El run ${opts.fromReview} pertenece a la sesión ${parentReview.value.sessionId}, no a la activa (${session.id}). ` +
        "Reanudá esa sesión (slad pipeline session use) e importá ahí el plan de follow-up.",
      );
      process.exitCode = 1;
      return;
    }
    const tip = await branchTip(cwd, parentIntegration.branch);
    if (tip !== parentIntegration.tip) {
      log.error(
        tip === null
          ? `La rama de integración ${parentIntegration.branch} ya no existe; no se puede continuar el run ${opts.fromReview}.`
          : `La rama ${parentIntegration.branch} se movió desde el run ${opts.fromReview}; no se puede continuar con seguridad.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!workerGuard(cwd, session.id, `continuar el run ${opts.fromReview}`, opts.assumeWorkersDead)) {
      process.exitCode = 1;
      return;
    }
    fromIntegration = { ref: parentIntegration.tip, baseRef: parentIntegration.baseRef };
  }
  if (resumeContext) {
    fromIntegration = {
      ref: resumeContext.integration.tip,
      baseRef: resumeContext.integration.baseRef,
    };
  }

  // A2 — a fresh worktrees run refuses while the session holds any execution
  // residue. `setupIntegration` used to delete every slad/<session>/* branch
  // and force-remove every session worktree here (F5): the only way this
  // system could actually destroy work. SLAD never cleans ambiguous residue.
  const parentRunId = resumeContext?.parent.value.runId ?? parentReview?.value.runId;
  if (opts.parallel && opts.worktrees && !fromIntegration) {
    const residue = await collectSessionResidue(cwd, session.id);
    if (hasResidue(residue)) {
      log.error(formatResidueRefusal(session.id, residue));
      process.exitCode = 1;
      return;
    }
  }

  try {
    await runPreLifecycleHooks(hooks, "pre-run", {
      event: "pre-run",
      command: "run",
      cwd,
      runId,
      sessionId: session.id,
      intent,
      plan: parsedPlan,
      ...(parentRunId && resumeContext ? { resume: { fromRun: parentRunId } } : {}),
    });
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // A resume must not terminalize its own parent, whose `interrupted` status
  // is exactly the state it is resuming from.
  if (!resumeContext) await interruptStaleRunManifests(session.id, cwd);

  const useWorktrees = opts.worktrees ?? resumeContext !== null;
  const keepWorktrees = opts.keepWorktrees ?? resumeContext?.parent.value.worktrees.keep ?? false;
  const strictOwnership = resumeContext?.strictOwnership ?? opts.strictOwnership ?? false;
  const maxTasks = resumeContext?.maxTasks ?? opts.maxTasks ?? 10;
  const maxParallel = opts.maxParallel ?? resumeContext?.parent.value.limits.maxParallel ?? 3;
  const runsParallel = opts.parallel || resumeContext !== null;
  const inheritedTasks = new Map(
    (resumeContext?.inheritedTasks ?? []).map((task) => [task.taskId, task]),
  );

  const manifest = await createRunManifest({
    runId,
    sessionId: session.id,
    intent,
    command: runsParallel ? "run-parallel" : "run",
    plan: planEnvelope ? {
      planId: planEnvelope.planId,
      hash: planEnvelope.approval.planHash,
      approval: planEnvelope.approval.status,
    } : undefined,
    backend: {
      provider: providerName,
      agent: agentName,
      model: selectedModel,
    },
    stages: [{ id: "run", status: "pending" }],
    // Completed parent entries are copied so `--review` shows the whole chain;
    // they never feed the budget, which is its own counter.
    tasks: parsedPlan.tasks.map((task) =>
      inheritedTasks.get(task.id) ?? { taskId: task.id, status: "pending" as const }),
    limits: {
      maxTasks,
      maxParallel: runsParallel ? maxParallel : undefined,
    },
    worktrees: { enabled: useWorktrees, keep: keepWorktrees },
    ...(runsParallel
      ? { policy: { strictOwnership, taskDispatches: resumeContext?.taskDispatches ?? 0 } }
      : {}),
  }, cwd);

  // §7.3 — record-before-create: the integration is written to the manifest
  // *before* setupIntegration creates the branch, so a class-B death in that
  // window still leaves a branch every command recognizes.
  if (runsParallel && useWorktrees) {
    const chainBase = fromIntegration?.baseRef ?? await currentHead(cwd);
    if (chainBase) {
      await recordIntegration(manifest, {
        branch: sessionBranch(session.id, "integration"),
        baseRef: chainBase,
        tip: fromIntegration?.ref ?? chainBase,
        ...(parentRunId ? { fromRun: parentRunId } : {}),
      });
    }
  }
  await updateRunManifest(manifest, { status: "running" });

  // Class A: the first signal aborts and notifies; it never calls
  // process.exit, so the loop unwinds on its own and every durable write in
  // flight completes. The second one exits hard with 130.
  const interrupt = createInterruptScope();
  interrupt.onInterrupt((received) => {
    log.warn(`\n${received} recibido: terminando la ola en curso y guardando el estado (otro ${received} corta en seco).`);
  });

  try {
  if (runsParallel) {
    // Workers read the model from env; an explicit -m must win over config.
    if (opts.model) process.env.CLI_MODEL = opts.model;

    log.title(`Run (parallel) · ${process.env.SLAD_CLI_BINARY ?? "cli"} · max ${maxParallel}`);
    if (resumeContext) {
      log.dim(
        `  resume de ${resumeContext.parent.value.runId}: ${resumeContext.skipSet.length} tarea(s) ya completada(s), ` +
        `${resumeContext.taskDispatches}/${maxTasks} dispatches consumidos`,
      );
    }
    let currentSession = session;
    const parallelResult = await runParallel({
      plan: parsedPlan,
      sessionId: session.id,
      runId,
      cwd,
      maxParallel,
      maxTasks,
      strictOwnership,
      useWorktrees,
      keepWorktrees,
      fromIntegration,
      alreadyDone: resumeContext?.skipSet,
      taskDispatches: resumeContext?.taskDispatches ?? 0,
      recycleTaskWorktrees: fromIntegration
        ? (resumeContext?.parent ?? parentReview)?.value.tasks.map((task) => task.taskId)
        : undefined,
      signal: interrupt.signal,
      projectMemory: readProjectMemory(cwd),
      // A3 — one durable reservation per dispatch, right before the spawn.
      onDispatchReserve: async (taskId, { worktree }) => {
        await reserveTaskDispatch(manifest, { taskId, worktree });
      },
      // A1 — the checkpoint: exactly one manifest write, nothing else.
      onTaskIntegrated: async (taskId, checkpoint) => {
        await checkpointTaskIntegration(manifest, { taskId, ...checkpoint });
      },
      // Secondary work: never fails the task. Completion is defined by the
      // merge, not by the evidence file (I9).
      onTaskOutput: async (output) => {
        try {
          const ref = await writeArtifact("run", output, { sessionId: currentSession?.id ?? "adhoc" });
          const sha256 = await sha256File(ref.path);
          await updateRunManifest(manifest, (current) => ({
            ...current,
            tasks: current.tasks.map((task) => task.taskId === output.taskId
              ? { ...task, artifact: ref.path }
              : task),
            artifacts: [...current.artifacts, { kind: "run", path: ref.path, sha256 }],
          }));
          if (currentSession) {
            currentSession = appendArtifact(currentSession, "run", ref.path);
            saveSession(currentSession);
          }
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).slice(0, 400);
          log.warn(`No se pudo escribir el artefacto de ${output.taskId}: ${reason}`);
          await updateRunManifest(manifest, (current) => ({
            ...current,
            tasks: current.tasks.map((task) => task.taskId === output.taskId
              ? { ...task, artifactError: reason }
              : task),
          })).catch(() => undefined);
        }
        const task = taskById.get(output.taskId);
        if (task) {
          await runPostLifecycleHooks(hooks, "post-task", {
            event: "post-task",
            command: "run",
            cwd,
            sessionId: session.id,
            task,
            output,
          });
        }
      },
    });

    // Class A terminalization, in order: durable manifest write, then the
    // lock, then the hook. Durable state may not depend on an external
    // process, and a hung hook may not hold the session.
    if (parallelResult.interrupted) {
      if (parallelResult.integration) {
        await recordIntegration(manifest, {
          ...parallelResult.integration,
          ...(parentRunId ? { fromRun: parentRunId } : {}),
        });
      }
      await markRunInterrupted(manifest, {
        signal: interrupt.interruptedBy() ?? "SIGINT",
        hasIntegration: Boolean(parallelResult.integration),
      });
      await killSessionTmuxWindows(session.id);
      releaseLock();
      await runPostLifecycleHooks(hooks, "post-run", {
        event: "post-run",
        command: "run",
        cwd,
        runId,
        sessionId: session.id,
        status: "interrupted",
      });
      if (parallelResult.integration) {
        log.info(`Run ${runId} interrumpido; el trabajo integrado sigue en ${parallelResult.integration.branch}.`);
        log.dim(`  slad pipeline run --review ${runId}   ver qué quedó`);
        log.dim(`  slad pipeline run --resume ${runId}   continuar donde se cortó`);
        log.dim(`  slad pipeline run --apply ${runId}    aplicar lo integrado`);
        log.dim(`  slad pipeline run --abort ${runId}    descartar la integración`);
      } else {
        log.info(`Run ${runId} cancelado antes de integrar nada; la sesión quedó limpia.`);
      }
      process.exitCode = INTERRUPT_EXIT_CODE;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(parallelResult.outputs, null, 2));
    } else {
      const color =
        parallelResult.status === "completed" ? kleur.green : parallelResult.status === "partial" ? kleur.yellow : kleur.red;
      console.log("\n" + kleur.bold("Run ") + color(parallelResult.status));
    }

    if (parallelResult.integration) {
      // Review before apply: the merged result stays on the integration
      // branch; the main worktree receives nothing until --apply.
      await updateRunManifest(manifest, (current) => ({
        ...current,
        status: "review_pending",
        worktrees: {
          ...current.worktrees,
          integration: {
            ...parallelResult.integration!,
            ...(parentRunId ? { fromRun: parentRunId } : {}),
          },
        },
      }));
      if (!opts.json) {
        log.info(`Resultado pendiente de review en ${parallelResult.integration.branch}; el worktree principal quedó intacto.`);
        log.dim(`  slad pipeline run --review ${runId}   inspecciona el resultado`);
        log.dim(`  slad pipeline run --apply ${runId}    lo aplica como cambios staged`);
        log.dim(`  slad pipeline run --abort ${runId}    lo descarta sin tocar main`);
      }
    } else {
      await completeRunManifest(manifest, parallelResult.status);
    }
    releaseLock();
    await runPostLifecycleHooks(hooks, "post-run", {
      event: "post-run",
      command: "run",
      cwd,
      runId,
      sessionId: session.id,
      status: parallelResult.status,
    });
    if (parallelResult.status === "failed") process.exitCode = 1;
    return;
  }

  const model = selectedModel;
  const provider = await getSladProvider(providerName);

  if (opts.tools !== false && providerName !== "cli" && !provider.supportsToolUse) {
    throw new ProviderError(
      `El provider "${providerName}" no soporta tool use. No puede ejecutar el run stage.`,
      providerName,
      { retryable: false }
    );
  }

  log.title(`Run · ${providerName}${model ? ` · ${model}` : ""}`);
  console.log("");

  const _hitl = createHitlTransport("tty", opts.nonInteractive ? { isTTY: () => false } : undefined);
  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off"
    ? undefined
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando ejecución...").start();

  // Pause the spinner while HITL prompts are active to avoid visual conflicts
  const hitl = {
    kind: _hitl.kind,
    canPrompt: () => _hitl.canPrompt(),
    canInteract: () => _hitl.canInteract(),
    askQuestion: (q: Parameters<typeof _hitl.askQuestion>[0]) => _hitl.askQuestion(q),
    printHeader: _hitl.printHeader?.bind(_hitl),
    printPaused: _hitl.printPaused?.bind(_hitl),
    collectAnswers: async (questions: Parameters<typeof _hitl.collectAnswers>[0]) => {
      if (spinner.isSpinning) spinner.stop();
      const answers = await _hitl.collectAnswers(questions);
      return answers;
    },
  };

  const result = await runSladPipeline({
    intent,
    initialInput: planInput,
    provider,
    model,
    stages: ["run"],
    maxTasks,
    hitl,
    harness,
    signal: interrupt.signal,
    prompts: {
      explorer: prompts.EXPLORER_SYSTEM,
      snapshot: prompts.SNAPSHOT_SYSTEM,
      planner: prompts.PLANNER_SYSTEM,
      builderReviewer: prompts.BUILDER_REVIEWER_SYSTEM
    },
    onStageStart: async (stage) => {
      if (spinner.isSpinning) spinner.stop();
      spinner = ora(`Ejecutando ${stage}...`).start();
      await updateRunManifest(manifest, (current) => ({
        ...current,
        stages: current.stages.map((item) => item.id === stage
          ? { ...item, status: "running", startedAt: new Date().toISOString() }
          : item),
      }));
    },
    onArtifact: async (stage, artifact) => {
      if (stage === "run") {
        // run stage emits RunOutput[] — write each task output individually
        const outputs = Array.isArray(artifact) ? (artifact as RunOutput[]) : [artifact as RunOutput];
        let currentSession = session;
        for (const output of outputs) {
          const ref = await writeArtifact("run", output, { sessionId: currentSession?.id ?? "adhoc" });
          const sha256 = await sha256File(ref.path);
          await updateRunManifest(manifest, (current) => ({
            ...current,
            tasks: current.tasks.map((task) => task.taskId === output.taskId
              ? { ...task, status: output.status === "awaiting_human" ? "blocked" : output.status, artifact: ref.path }
              : task),
            artifacts: [...current.artifacts, { kind: "run", path: ref.path, sha256 }],
          }));
          if (currentSession) {
            currentSession = appendArtifact(currentSession, "run", ref.path);
            saveSession(currentSession);
          }
          const task = taskById.get(output.taskId);
          if (task) {
            await runPostLifecycleHooks(hooks, "post-task", {
              event: "post-task",
              command: "run",
              cwd,
              sessionId: session.id,
              task,
              output,
            });
          }
        }
      } else {
        const ref = await writeArtifact(stage as any, artifact as any, { sessionId: session?.id ?? "adhoc" });
        if (session) {
          saveSession(appendArtifact(session, stage as any, ref.path));
        }
      }
    },
    onStageComplete: async (stage) => {
      if (spinner.isSpinning) spinner.succeed(`${stage} completado`);
      await updateRunManifest(manifest, (current) => ({
        ...current,
        stages: current.stages.map((item) => item.id === stage
          ? { ...item, status: "completed", completedAt: new Date().toISOString() }
          : item),
      }));
    },
    onTaskStart: (taskId, title) => {
      const text = kleur.dim(taskId) + " " + title;
      if (!spinner.isSpinning) {
        spinner = ora(text).start();
      } else {
        spinner.text = text;
      }
    },
    onTaskComplete: (taskId, status) => {
      const icon = status === "completed" ? kleur.green("✓") : kleur.red("✗");
      spinner.stopAndPersist({ symbol: icon, text: kleur.dim(taskId) + " " + status });
      spinner = ora("").start();
    },
  });

  if (result.status === "failed") {
    if (spinner.isSpinning) spinner.stop();
    spinner.fail("Ejecución falló");
    for (const error of result.errors) log.error(`  ${error}`);
  } else if (spinner.isSpinning) {
    spinner.succeed("Ejecución completada");
  }

  if (interrupt.interrupted()) {
    // No worktrees on this path, so there is no integration to review: the
    // run is simply cancelled with its state recorded exactly.
    await markRunInterrupted(manifest, {
      signal: interrupt.interruptedBy() ?? "SIGINT",
      hasIntegration: false,
    });
    releaseLock();
    await runPostLifecycleHooks(hooks, "post-run", {
      event: "post-run",
      command: "run",
      cwd,
      runId,
      sessionId: session.id,
      status: "interrupted",
    });
    process.exitCode = INTERRUPT_EXIT_CODE;
    return;
  }

  await completeRunManifest(
    manifest,
    result.status === "completed"
      ? manifest.value.tasks.some((task) => task.status === "pending") ? "partial" : "completed"
      : "failed",
    result.status === "failed" ? result.errors.join("; ") : undefined,
  );
  releaseLock();
  await runPostLifecycleHooks(hooks, "post-run", {
    event: "post-run",
    command: "run",
    cwd,
    runId,
    sessionId: session.id,
    status: result.status,
  });

  if (opts.json) {
    console.log(JSON.stringify(result.outputs["run"], null, 2));
  } else {
    const color = result.status === "completed" ? kleur.green : result.status === "partial" ? kleur.yellow : kleur.red;
    console.log(kleur.bold("Run ") + color(result.status));
  }
  } catch (error) {
    // A1.3/A3.2 — a durable write the run depends on failed. The manifest no
    // longer describes the branch, so the run is class B: diagnosed, never
    // marked resumable, and nothing of its work is deleted.
    if (error instanceof DurableWriteError) {
      await markRunUnrecoverable(manifest, error.message).catch(() => undefined);
      log.error(error.message);
      await printUnrecoverableDiagnosis(manifest, cwd);
      releaseLock();
      await runPostLifecycleHooks(hooks, "post-run", {
        event: "post-run",
        command: "run",
        cwd,
        runId,
        sessionId: session.id,
        status: "interrupted",
      });
      process.exitCode = 1;
      return;
    }
    await completeRunManifest(
      manifest,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    releaseLock();
    await runPostLifecycleHooks(hooks, "post-run", {
      event: "post-run",
      command: "run",
      cwd,
      runId,
      sessionId: session.id,
      status: "failed",
    });
    throw error;
  } finally {
    interrupt.dispose();
  }
}
