import ora from "ora";
import kleur from "kleur";
import { type SladPipelineStageId, buildSladPipeline, writeAutoReport } from "@slad/pipeline";
import { createAgent } from "@slad/pipeline";
import { getModel, loadConfig, resolveProvider } from "../core/config.js";
import { type ModelProvider } from "@slad/model-providers";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "@slad/harness";

import {
  autoResolveExplore,
  autoResolveGeneric,
  autoResolvePlan,
  type HITLTransport,
} from "@slad/hitl";
import { getActiveAgent } from "../agents/registry.js";
import { writeArtifact, readArtifact } from "../persistence/index.js";
import { getOrCreateSession, getActiveSession, appendArtifact, saveSession } from "../core/session.js";
import { appendBudgetHistory } from "@slad/pipeline";
import { getDocsRoot } from "../persistence/layout.js";
import { ProviderError } from "../core/errors.js";
import { classifyIntent } from "../core/classifier.js";
import { askCommand } from "./ask.js";
import { appendAgentRunLog } from "../persistence/telemetry.js";
import { select } from "@inquirer/prompts";
import type { PlanOutput, Question, RunOutput, SessionState } from "../core/types.js";

export interface AutoOpts {
  provider?: string;
  agent?: string;
  model?: string;
  maxCost?: number;
  maxTasks?: number;
  skipLearn?: boolean;
  harness?: "off" | "on" | "strict";
  dryRun?: boolean;
  json?: boolean;
  resume?: boolean;
  fresh?: boolean;
  _provider?: ModelProvider;
  classify?: boolean;
  debate?: boolean;
  debateModels?: string;
  debateThreshold?: number;
}

const AUTO_STAGE_ORDER = ["explore", "snapshot", "plan", "run", "learn"] as const satisfies readonly SladPipelineStageId[];

type AutoStageOutput = {
  status?: string;
  taskId?: string;
};

type AutoHitlStageId = SladPipelineStageId | "unknown";

type AutoHitlQuestionMetadata = {
  id: string;
  prompt: string;
  kind: string;
  blocking: boolean;
  choices?: string[];
  default?: string;
  context?: string;
};

type AutoHitlRequestMetadata = {
  stage: AutoHitlStageId;
  taskId?: string;
  status: "resolved" | "blocked" | "awaiting_human";
  questions: AutoHitlQuestionMetadata[];
  answers: Record<string, string>;
  unresolved: string[];
  createdAt: string;
};

export type AutoHitlResolution = {
  answers: Record<string, string>;
  unresolved: Question[];
};

/**
 * Models sometimes emit status "awaiting_human" with no blocking questions —
 * there is nothing for a human to answer, so failing the pipeline is wrong.
 * Normalized to "completed" before persisting (seen with claude on explore).
 * Run outputs are excluded: a blocked worker is a real failure signal.
 */
export function normalizeSpuriousAwaitingHuman(stage: SladPipelineStageId, output: unknown): unknown {
  if (stage === "run" || !isRecord(output) || output.status !== "awaiting_human") return output;
  const questions = Array.isArray(output.questions) ? output.questions.filter(isQuestion) : [];
  if (questions.some((question) => question.blocking !== false)) return output;
  return { ...output, status: "completed" };
}

export function isCompleteAutoStageOutput(stage: SladPipelineStageId, output: unknown): boolean {
  if (stage === "run") {
    const outputs = Array.isArray(output) ? output : [output];
    return outputs.length > 0 && outputs.every((item) => isRecord(item) && item.status === "completed");
  }
  return isRecord(output) && output.status === "completed";
}

export function completedRunTaskIds(plan: PlanOutput, outputs: readonly RunOutput[]): Set<string> {
  const planTaskIds = new Set(plan.tasks.map((task) => task.id));
  return new Set(
    outputs
      .filter((output) => output.status === "completed" && planTaskIds.has(output.taskId))
      .map((output) => output.taskId),
  );
}

export function planPendingRunTasks(plan: PlanOutput, outputs: readonly RunOutput[]): PlanOutput {
  const completed = completedRunTaskIds(plan, outputs);
  const pendingTasks = plan.tasks.filter((task) => !completed.has(task.id));
  const pendingTaskIds = new Set(pendingTasks.map((task) => task.id));
  const recommendedFirstTask = plan.recommendedFirstTask && pendingTaskIds.has(plan.recommendedFirstTask)
    ? plan.recommendedFirstTask
    : pendingTasks[0]?.id;

  return {
    ...plan,
    tasks: pendingTasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dep) => pendingTaskIds.has(dep)),
    })),
    ...(recommendedFirstTask ? { recommendedFirstTask } : {}),
  };
}

function isRecord(value: unknown): value is AutoStageOutput & Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class AutoStageIncompleteError extends Error {
  constructor(stage: SladPipelineStageId, status: string) {
    super(
      `Stage '${stage}' no completó de forma verificable (status: ${status}). `
        + "El estado previo quedó intacto para reintentar /auto después de resolver el bloqueo.",
    );
    this.name = "AutoStageIncompleteError";
  }
}

export class AutoHitlBlockedError extends Error {
  constructor(stage: AutoHitlStageId, questions: readonly Question[]) {
    super(formatAutoHitlBlockedMessage(stage, questions));
    this.name = "AutoHitlBlockedError";
  }
}

export function resolveAutoHitlQuestions(
  stage: AutoHitlStageId,
  questions: readonly Question[],
): AutoHitlResolution {
  const output = { status: "awaiting_human", questions: [...questions] };
  const answers = stage === "explore"
    ? autoResolveExplore(output)
    : stage === "plan"
      ? autoResolvePlan(output)
      : autoResolveGeneric(output);
  const unresolved = questions.filter((question) => answers[question.id] === undefined);
  return { answers, unresolved };
}

export function formatAutoHitlBlockedMessage(stage: AutoHitlStageId, questions: readonly Question[]): string {
  const details = questions
    .map((question) => {
      const choices = question.choices?.length ? ` choices=${question.choices.join("|")}` : "";
      const defaultValue = question.default !== undefined ? ` default=${question.default}` : " sin default";
      return `${question.id} (${question.kind}, ${question.blocking ? "blocking" : "non-blocking"}): ${question.prompt}${choices}${defaultValue}`;
    })
    .join("; ");
  return [
    `HITL automático bloqueado en '${stage}'.`,
    "No hay default ni política automática segura para continuar sin intervención humana.",
    `Preguntas pendientes: ${details || "sin detalle"}.`,
    "Acción: agregá un default seguro, reducí las opciones a una sola alternativa segura o ejecutá el stage interactivo para responder y luego reintentá /auto.",
  ].join(" ");
}

function collectAutoHitlAnswers(
  stage: AutoHitlStageId,
  questions: readonly Question[],
  metadata: AutoHitlRequestMetadata[],
): Record<string, string> {
  const { answers, unresolved } = resolveAutoHitlQuestions(stage, questions);
  metadata.push({
    stage,
    status: unresolved.length > 0 ? "blocked" : "resolved",
    questions: questions.map(serializeQuestion),
    answers,
    unresolved: unresolved.map((question) => question.id),
    createdAt: new Date().toISOString(),
  });
  if (unresolved.length > 0) {
    throw new AutoHitlBlockedError(stage, unresolved);
  }
  return answers;
}

function recordAwaitingHumanMetadata(
  stage: SladPipelineStageId,
  output: unknown,
  metadata: AutoHitlRequestMetadata[],
): void {
  for (const item of awaitingHumanItems(output)) {
    metadata.push({
      stage,
      ...(item.taskId ? { taskId: item.taskId } : {}),
      status: "awaiting_human",
      questions: item.questions.map(serializeQuestion),
      answers: {},
      unresolved: item.questions.map((question) => question.id),
      createdAt: new Date().toISOString(),
    });
  }
}

function awaitingHumanItems(output: unknown): { taskId?: string; questions: Question[] }[] {
  const values = Array.isArray(output) ? output : [output];
  return values.flatMap((value) => {
    if (!isRecord(value) || value.status !== "awaiting_human") return [];
    const questions = Array.isArray(value.questions)
      ? value.questions.filter(isQuestion)
      : [];
    if (questions.length === 0) return [];
    const taskId = typeof value.taskId === "string" ? value.taskId : undefined;
    return [{ ...(taskId ? { taskId } : {}), questions }];
  });
}

function isQuestion(value: unknown): value is Question {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.prompt === "string"
    && typeof value.kind === "string";
}

function serializeQuestion(question: Question): AutoHitlQuestionMetadata {
  return {
    id: question.id,
    prompt: question.prompt,
    kind: question.kind,
    blocking: question.blocking,
    ...(question.choices ? { choices: [...question.choices] } : {}),
    ...(question.default !== undefined ? { default: question.default } : {}),
    ...(question.context ? { context: question.context } : {}),
  };
}

function outputStatus(output: unknown): string {
  if (Array.isArray(output)) {
    const statuses = output.map((item) => isRecord(item) ? String(item.status ?? "unknown") : "unknown");
    return statuses.length ? statuses.join(",") : "empty";
  }
  return isRecord(output) ? String(output.status ?? "unknown") : "unknown";
}

async function readLatestCompleteStageArtifact(
  session: SessionState,
  stage: Exclude<SladPipelineStageId, "run">,
): Promise<unknown | undefined> {
  const refs = [...session.artifacts].reverse().filter((artifact) => artifact.kind === stage);
  for (const ref of refs) {
    try {
      const { value } = await readArtifact(stage, ref.path);
      if (isCompleteAutoStageOutput(stage, value)) return value;
    } catch {
      // Ignore stale or invalid artifacts and continue toward the last reliable state.
    }
  }
  return undefined;
}

async function readCompleteRunOutputs(session: SessionState): Promise<RunOutput[]> {
  const outputs: RunOutput[] = [];
  const seen = new Set<string>();
  const refs = [...session.artifacts].reverse().filter((artifact) => artifact.kind === "run");

  for (const ref of refs) {
    try {
      const { value } = await readArtifact("run", ref.path);
      const values = Array.isArray(value) ? value : [value];
      for (const output of values) {
        if (output.status !== "completed" || seen.has(output.taskId)) continue;
        seen.add(output.taskId);
        outputs.push(output);
      }
    } catch {
      // Invalid run artifacts are not a reliable resume point.
    }
  }

  return outputs.reverse();
}

async function resolveAutoResume(
  session: SessionState | null,
  stages: readonly SladPipelineStageId[],
  intent: string,
): Promise<{ stages: SladPipelineStageId[]; input: unknown; note?: string }> {
  if (!session) return { stages: [...stages], input: { intent } };

  const targetStages = stages.filter((stage) => AUTO_STAGE_ORDER.includes(stage));
  const hasTarget = (stage: SladPipelineStageId) => targetStages.includes(stage);
  const firstTargetAt = (stage: SladPipelineStageId) => {
    const index = targetStages.indexOf(stage);
    return index === -1 ? [] : targetStages.slice(index);
  };

  const snapshot = await readLatestCompleteStageArtifact(session, "snapshot");
  const plan = snapshot ? await readLatestCompleteStageArtifact(session, "plan") as PlanOutput | undefined : undefined;
  if (snapshot && plan) {
    const runOutputs = await readCompleteRunOutputs(session);
    const completedTasks = completedRunTaskIds(plan, runOutputs);
    const allPlanTasksCompleted = plan.tasks.length > 0 && plan.tasks.every((task) => completedTasks.has(task.id));

    if (allPlanTasksCompleted) {
      const learn = await readLatestCompleteStageArtifact(session, "learn");
      if (learn || !hasTarget("learn")) {
        return { stages: [], input: learn ?? runOutputs, note: "pipeline ya estaba completo" };
      }
      return { stages: firstTargetAt("learn"), input: runOutputs, note: "retomando desde learn" };
    }

    if (hasTarget("run")) {
      const pendingPlan = planPendingRunTasks(plan, runOutputs);
      return {
        stages: firstTargetAt("run"),
        input: pendingPlan,
        note: completedTasks.size > 0
          ? `retomando run con ${pendingPlan.tasks.length} tarea(s) pendiente(s)`
          : "retomando desde run",
      };
    }
  }

  if (snapshot && hasTarget("plan")) {
    return { stages: firstTargetAt("plan"), input: snapshot, note: "retomando desde plan" };
  }

  const explore = await readLatestCompleteStageArtifact(session, "explore");
  if (explore && hasTarget("snapshot")) {
    return { stages: firstTargetAt("snapshot"), input: explore, note: "retomando desde snapshot" };
  }

  return { stages: [...targetStages], input: { intent } };
}

export async function autoCommand(intent: string, opts: AutoOpts): Promise<void> {
  if (!intent || intent.trim().length < 3) {
    log.error('Intención vacía. Uso: slad auto "<tu intención>"');
    process.exit(1);
  }

  const startMs = Date.now();
  const startedAt = new Date().toISOString();

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);

  let provider: ModelProvider;
  let model: string | undefined;
  if (opts._provider) {
    provider = opts._provider;
    model = opts.model;
  } else {
    model = opts.model ?? getModel(providerName);
    provider = await getSladProvider(providerName);
  }

  if (!opts.dryRun && !opts._provider && providerName !== "cli" && !provider.supportsToolUse) {
    throw new ProviderError(
      `El provider "${providerName}" no soporta tool use. Usá anthropic, openai o un agente local. O agregá --dry-run.`,
      providerName,
      { retryable: false },
    );
  }

  const runClassifier = opts.classify !== false && !opts.debate && !opts.fresh;
  if (runClassifier) {
    const decision = await classifyIntent(intent, provider as any);
    if (decision && decision.confidence >= 0.8 && decision.mode !== "work") {
      const pct = Math.round(decision.confidence * 100);
      console.log(kleur.dim(`  ⚡ Clasificador → "${decision.mode}" (${pct}%): ${decision.rationale}`));
      const modeChoice = await select({
        message: "¿Cómo querés continuar?",
        choices: [
          decision.mode === "ask"
            ? { name: `Respuesta directa (ask) — sin pipeline`, value: "ask" as const }
            : { name: `Debate multi-modelo (work-debate)`, value: "work-debate" as const },
          { name: "Pipeline completo (work)", value: "work" as const },
        ],
        default: decision.mode === "work-debate" ? "work-debate" : "ask",
      });

      if (modeChoice === "ask") {
        await appendAgentRunLog({
          sessionId: "",
          intent,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          commandUsed: "ask",
          model,
          provider: providerName,
          pipelineStatus: "completed",
          stagesCompleted: [],
          classifierResult: {
            suggestedMode: decision.mode,
            confidence: decision.confidence,
            rationale: decision.rationale,
            shownToUser: true,
            userAccepted: true,
          },
          debateUsed: false,
        });
        await askCommand(intent, { provider: opts.provider, agent: opts.agent, model: opts.model });
        return;
      }
      if (modeChoice === "work-debate") {
        opts = { ...opts, debate: true };
      }
    }
  }

  const activeAgent = getActiveAgent();

  log.title(`Auto · ${activeAgent.descriptor.label} · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`  intent: ${intent}`);
  if (opts.dryRun) log.dim("  modo: dry-run (solo explore+snapshot+plan)");
  if (opts.maxCost !== undefined) log.dim(`  budget: $${opts.maxCost}`);
  console.log("");

  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off"
    ? undefined
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando pipeline...").start();

  let currentStage: AutoHitlStageId = "unknown";
  const hitlMetadata: AutoHitlRequestMetadata[] = [];
  const hitl: HITLTransport = {
    kind: "tty",
    canPrompt: () => true,
    canInteract: () => false,
    askQuestion: async (question) => {
      const answers = collectAutoHitlAnswers(currentStage, [question], hitlMetadata);
      return answers[question.id] ?? "";
    },
    collectAnswers: async (questions) => collectAutoHitlAnswers(currentStage, questions, hitlMetadata),
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Stages come from the active agent; dry-run / skip-learn subset them
  // (intersecting, so we never assume a fixed stage order).
  const dropStages = new Set<SladPipelineStageId>([
    ...(opts.dryRun ? (["run", "learn"] as SladPipelineStageId[]) : []),
    ...(opts.skipLearn ? (["learn"] as SladPipelineStageId[]) : []),
  ]);
  let pipelineStages = activeAgent.descriptor.stages.filter(
    (stage): stage is SladPipelineStageId => stage !== "evolve" && !dropStages.has(stage as SladPipelineStageId),
  );
  let existingSession = opts.fresh ? null : getActiveSession();
  let activeSession = existingSession ?? getOrCreateSession(intent);
  const resume = await resolveAutoResume(existingSession, pipelineStages, intent);
  pipelineStages = resume.stages;
  const resumeInput = resume.input;
  if (resume.note) {
    spinner.text = resume.note;
  }

  const pipeline = buildSladPipeline({
    stages: pipelineStages,
    prompts: activeAgent.prompts,
    ...(opts.maxCost !== undefined ? { policies: { budget: { maxUsd: opts.maxCost } } } : {}),
  });

  // Inject per-task progress callbacks into pipeline services for the run stage
  Object.assign(pipeline.services as Record<string, unknown>, {
    onTaskStart: (taskId: string, title: string) => {
      const text = kleur.dim(taskId) + " " + title;
      if (!spinner.isSpinning) spinner = ora(text).start();
      else spinner.text = text;
    },
    onTaskComplete: (taskId: string, status: string) => {
      const icon = status === "completed" ? kleur.green("✓") : kleur.red("✗");
      spinner.stopAndPersist({ symbol: icon, text: kleur.dim(taskId) + " " + status });
      spinner = ora("").start();
    },
  });

  const agent = createAgent({
    model: provider,
    safety: harness,
    hitl,
    pipeline,
  });

  const result = await agent.run(
    resumeInput ?? { intent },
    {
      onStageStart: (stage: string) => {
        currentStage = AUTO_STAGE_ORDER.includes(stage as SladPipelineStageId)
          ? stage as SladPipelineStageId
          : "unknown";
        if (spinner.isSpinning) spinner.stop();
        spinner = ora(kleur.dim(`${stage}...`)).start();
      },
      onArtifact: async (stage: string, artifact: unknown) => {
        const stageId = stage as SladPipelineStageId;
        const normalized = normalizeSpuriousAwaitingHuman(stageId, artifact);
        if (normalized !== artifact) {
          process.stdout.write(kleur.yellow(`  ⚠ ${stageId}: awaiting_human sin preguntas bloqueantes — tratado como completed\n`));
          artifact = normalized;
        }
        if (stageId === "run") {
          const outputs = Array.isArray(artifact) ? (artifact as RunOutput[]) : [artifact as RunOutput];
          for (const output of outputs) {
            const ref = await writeArtifact("run", output, { sessionId: activeSession!.id });
            activeSession = appendArtifact(activeSession!, "run", ref.path, output.taskId);
            saveSession(activeSession);
          }
        } else {
          const ref = await writeArtifact(stageId as any, artifact as any, { sessionId: activeSession!.id });
          activeSession = appendArtifact(activeSession!, stageId as any, ref.path);
          saveSession(activeSession);
        }

        if (!isCompleteAutoStageOutput(stageId, artifact)) {
          recordAwaitingHumanMetadata(stageId, artifact, hitlMetadata);
          throw new AutoStageIncompleteError(stageId, outputStatus(artifact));
        }
      },
      onStageComplete: (stage: string) => {
        // Always persist the completion line, regardless of spinner state
        if (spinner.isSpinning) {
          spinner.stopAndPersist({ symbol: kleur.green("✓"), text: kleur.dim(stage) });
        } else {
          process.stdout.write(kleur.green("✓") + " " + kleur.dim(stage) + "\n");
        }
      },
    },
  );

  if (spinner.isSpinning) spinner.stop();
  if (result.status === "failed") process.stdout.write(kleur.red("✗") + " Pipeline falló\n");
  else process.stdout.write(kleur.green("✓") + " Pipeline completado\n");

  if (result.status === "failed") {
    const failedStage = result.stages.find((s) => s.status === "failed");
    if (failedStage?.error) {
      log.error(`Stage '${failedStage.stageId}': ${failedStage.error.message}`);
    }
  }

  const outputs = Object.fromEntries(result.stages.map((s) => [s.stageId, s.output]));
  const stagesCompleted = result.stages.filter((s) => s.status === "completed").map((s) => s.stageId);

  const docsRoot = await getDocsRoot();
  writeAutoReport({
    status: result.status,
    outputs,
    metadata: {
      hitl: hitlMetadata,
    },
  }, { docsRoot, basename: "auto" });

  appendBudgetHistory({
    sessionId: activeSession!.id,
    intent,
    model: model ?? "unknown",
    provider: providerName,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    startedAt,
    completedAt: new Date().toISOString(),
    estimatedCostUsd: 0,
    stagesCompleted: stagesCompleted as any,
  });

  await appendAgentRunLog({
    sessionId: activeSession!.id,
    intent,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    commandUsed: "work",
    model: model ?? "unknown",
    provider: providerName,
    pipelineStatus: result.status === "cancelled" ? "partial" : result.status,
    stagesCompleted: stagesCompleted as any,
    debateUsed: opts.debate ?? false,
  });

  const durationSecs = ((Date.now() - startMs) / 1000).toFixed(1);
  const color = result.status === "completed" ? kleur.green : result.status === "failed" ? kleur.red : kleur.yellow;
  console.log(kleur.bold("Pipeline ") + color(result.status) + kleur.dim(` · ${durationSecs}s`));
}
