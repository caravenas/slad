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
import * as prompts from "../agents/prompts.js";
import { writeArtifact } from "../persistence/index.js";
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

  log.title(`Auto · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`  intent: ${intent}`);
  if (opts.dryRun) log.dim("  modo: dry-run (solo explore+snapshot+plan)");
  if (opts.maxCost !== undefined) log.dim(`  budget: $${opts.maxCost}`);
  console.log("");

  const hitl = createHitlTransport("tty");
  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off"
    ? undefined
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando pipeline...").start();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const pipelineStages: SladPipelineStageId[] = opts.dryRun
    ? ["explore", "snapshot", "plan"]
    : (opts.skipLearn ? ["explore", "snapshot", "plan", "run"] : ["explore", "snapshot", "plan", "run", "learn"]);

  const pipeline = buildSladPipeline({
    stages: pipelineStages,
    prompts: {
      explorer: prompts.EXPLORER_SYSTEM,
      snapshot: prompts.SNAPSHOT_SYSTEM,
      planner: prompts.PLANNER_SYSTEM,
      builderReviewer: prompts.BUILDER_REVIEWER_SYSTEM,
    },
    ...(opts.maxCost !== undefined ? { policies: { budget: { maxUsd: opts.maxCost } } } : {}),
  });

  const agent = createAgent({
    model: provider,
    safety: harness,
    hitl,
    pipeline,
  });

  const result = await agent.run(
    { intent },
    {
      onStageStart: (stage: string) => {
        if (spinner.isSpinning) spinner.stop();
        spinner = ora(`Ejecutando ${stage}...`).start();
      },
      onArtifact: async (stage: string, artifact: unknown) => {
        if (stage !== "run") {
          await writeArtifact(stage as any, artifact as any, { sessionId: "auto" });
        }
      },
      onStageComplete: (stage: string) => {
        if (spinner.isSpinning) spinner.succeed(`${stage} completado`);
      },
    },
  );

  if (spinner.isSpinning) {
    if (result.status === "failed") spinner.fail("Pipeline falló");
    else spinner.succeed("Pipeline completado");
  }

  const outputs = Object.fromEntries(result.stages.map((s) => [s.stageId, s.output]));
  const stagesCompleted = result.stages.filter((s) => s.status === "completed").map((s) => s.stageId);

  const docsRoot = await getDocsRoot();
  writeAutoReport({ status: result.status, outputs }, { docsRoot, basename: "auto" });

  appendBudgetHistory({
    sessionId: "auto",
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
    sessionId: "auto",
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
