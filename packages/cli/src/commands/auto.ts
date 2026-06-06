import ora from "ora";
import kleur from "kleur";
import { type SladPipelineStageId, buildSladPipeline, writeAutoReport } from "@slad/pipeline";
import { createAgent } from "@slad/agent";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { type ModelProvider } from "@slad/model-providers";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "../harness/config.js";

import { createHitlTransport } from "@slad/hitl";
import { getActiveAgent } from "../agents/registry.js";
import { writeArtifact, readArtifact } from "../persistence/index.js";
import { getOrCreateSession, getActiveSession, appendArtifact, saveSession, lastArtifactPath } from "../core/session.js";
import { appendBudgetHistory } from "@slad/context-budget";
import { getDocsRoot } from "../persistence/layout.js";
import { ProviderError } from "../core/errors.js";
import { classifyIntent } from "../core/classifier.js";
import { askCommand } from "./ask.js";
import { appendAgentRunLog } from "../persistence/telemetry.js";
import { select } from "@inquirer/prompts";

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
    const apiKey = getApiKey(providerName);
    if (providerName !== "cli" && !apiKey) {
      log.error(`No se encontró API key para ${providerName}.`);
      process.exit(1);
    }
    model = opts.model ?? getModel(providerName);
    provider = await getSladProvider(providerName, apiKey ?? undefined);
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
    const decision = await classifyIntent(intent, provider as any, providerName);
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

  const _hitl = createHitlTransport("tty");
  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off"
    ? undefined
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando pipeline...").start();

  // Pause spinner while HITL prompts are active to avoid visual conflicts
  const hitl = {
    kind: _hitl.kind,
    canPrompt: () => _hitl.canPrompt(),
    canInteract: () => _hitl.canInteract(),
    askQuestion: (q: Parameters<typeof _hitl.askQuestion>[0]) => _hitl.askQuestion(q),
    printHeader: _hitl.printHeader?.bind(_hitl),
    printPaused: _hitl.printPaused?.bind(_hitl),
    collectAnswers: async (questions: Parameters<typeof _hitl.collectAnswers>[0]) => {
      const prevText = spinner.text;
      if (spinner.isSpinning) spinner.stop();
      const answers = await _hitl.collectAnswers(questions);
      spinner = ora(prevText).start();
      return answers;
    },
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
  let resumeInput: unknown = undefined;
  let existingSession = opts.fresh ? null : getActiveSession();

  // Resume: if there's an active session with artifacts, offer to skip completed stages.
  if (existingSession) {
    const completedStages = pipelineStages.filter(stage =>
      existingSession!.artifacts.some(a => a.kind === stage),
    );
    const remainingStages = pipelineStages.filter(s => !completedStages.includes(s));
    const lastStage = completedStages[completedStages.length - 1];
    const nextStage = remainingStages[0];

    if (lastStage && nextStage) {
      spinner.stop();
      const doResume = await select({
        message: `Sesión con stages completados (${completedStages.join(", ")}). ¿Retomar desde ${nextStage}?`,
        choices: [
          { name: `Retomar desde ${nextStage}`, value: true },
          { name: "Empezar de nuevo (desde explore)", value: false },
        ],
      });
      if (doResume) {
        const artifactPath = lastArtifactPath(existingSession!, lastStage as any);
        if (artifactPath) {
          const { value } = await readArtifact(lastStage as any, artifactPath);
          resumeInput = value;
          pipelineStages = remainingStages;
        }
      } else {
        existingSession = null;
      }
      spinner = ora("Iniciando pipeline...").start();
    }
  }

  let activeSession = existingSession ?? getOrCreateSession(intent);

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
        if (spinner.isSpinning) spinner.stop();
        spinner = ora(kleur.dim(`${stage}...`)).start();
      },
      onArtifact: async (stage: string, artifact: unknown) => {
        if (stage !== "run") {
          const ref = await writeArtifact(stage as any, artifact as any, { sessionId: activeSession!.id });
          activeSession = appendArtifact(activeSession!, stage as any, ref.path);
          saveSession(activeSession);
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
  writeAutoReport({ status: result.status, outputs }, { docsRoot, basename: "auto" });

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
