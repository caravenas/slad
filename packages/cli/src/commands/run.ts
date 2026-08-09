
import ora from "ora";
import kleur from "kleur";
import { runSladPipeline } from "@slad/pipeline";
import { getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { writeArtifact, type ReadPlanResult } from "../persistence/index.js";
import { readProjectMemory } from "../persistence/global-memory.js";
import { createHitlTransport } from "@slad/hitl";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "@slad/harness";
import * as prompts from "../agents/prompts.js";
import { getActiveSession, appendArtifact, readSessionPlan, saveSession } from "../core/session.js";
import { PlanOutput, type PlanArtifactEnvelope, type RunOutput } from "../core/types.js";
import { ProviderError } from "../core/errors.js";
import { runParallel } from "./run-parallel.js";
import { gatePlanPreflight, printPlanPreflight } from "../core/plan-preflight.js";
import { completeRunManifest, createRunManifest, interruptStaleRunManifests, sha256File, updateRunManifest } from "../persistence/manifest.js";

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
}

export async function runCommand(opts: RunOpts): Promise<void> {
  const cwd = process.cwd();

  // Invalid flag combinations fail fast, before any session read or manifest.
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

  const session = opts.skipSession ? null : getActiveSession(cwd);
  const intent = session?.intent ?? "continue plan execution";

  if (!session) {
    log.error("No hay sesión activa. Ejecuta /auto o /explore primero.");
    process.exitCode = 1;
    return;
  }

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

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
  const selectedModel = opts.model ?? getModel(providerName);
  const parsedPlan = PlanOutput.parse(planInput);
  await interruptStaleRunManifests(session.id, cwd);
  const manifest = await createRunManifest({
    sessionId: session.id,
    intent,
    command: opts.parallel ? "run-parallel" : "run",
    plan: planEnvelope ? {
      planId: planEnvelope.planId,
      hash: planEnvelope.approval.planHash,
      approval: planEnvelope.approval.status,
    } : undefined,
    backend: {
      provider: providerName,
      agent: opts.agent ?? config.defaultAgent,
      model: selectedModel,
    },
    stages: [{ id: "run", status: "pending" }],
    tasks: parsedPlan.tasks.map((task) => ({ taskId: task.id, status: "pending" as const })),
    limits: {
      maxTasks: opts.maxTasks ?? 10,
      maxParallel: opts.parallel ? (opts.maxParallel ?? 3) : undefined,
    },
    worktrees: { enabled: opts.worktrees ?? false, keep: opts.keepWorktrees ?? false },
  }, cwd);
  await updateRunManifest(manifest, { status: "running" });

  try {
  if (opts.parallel) {
    // Workers read the model from env; an explicit -m must win over config.
    if (opts.model) process.env.CLI_MODEL = opts.model;

    log.title(`Run (parallel) · ${process.env.SLAD_CLI_BINARY ?? "cli"} · max ${opts.maxParallel ?? 3}`);
    let currentSession = session;
    const parallelResult = await runParallel({
      plan: parsedPlan,
      sessionId: session.id,
      cwd,
      maxParallel: opts.maxParallel ?? 3,
      maxTasks: opts.maxTasks ?? 10,
      strictOwnership: opts.strictOwnership ?? false,
      useWorktrees: opts.worktrees ?? false,
      keepWorktrees: opts.keepWorktrees ?? false,
      projectMemory: readProjectMemory(cwd),
      onTaskOutput: async (output) => {
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
      },
    });

    if (opts.json) {
      console.log(JSON.stringify(parallelResult.outputs, null, 2));
    } else {
      const color =
        parallelResult.status === "completed" ? kleur.green : parallelResult.status === "partial" ? kleur.yellow : kleur.red;
      console.log("\n" + kleur.bold("Run ") + color(parallelResult.status));
    }
    await completeRunManifest(manifest, parallelResult.status);
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
    maxTasks: opts.maxTasks ?? 10,
    hitl,
    harness,
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

  await completeRunManifest(
    manifest,
    result.status === "completed"
      ? manifest.value.tasks.some((task) => task.status === "pending") ? "partial" : "completed"
      : "failed",
    result.status === "failed" ? result.errors.join("; ") : undefined,
  );

  if (opts.json) {
    console.log(JSON.stringify(result.outputs["run"], null, 2));
  } else {
    const color = result.status === "completed" ? kleur.green : result.status === "partial" ? kleur.yellow : kleur.red;
    console.log(kleur.bold("Run ") + color(result.status));
  }
  } catch (error) {
    await completeRunManifest(
      manifest,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
