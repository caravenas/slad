import type {
  PipelineArtifact,
  PipelineDefinition,
  PipelineLogger,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineServices,
  Stage,
  StageCacheConfig,
  StageContext,
  StageId,
  StageResult,
} from "./types.js";
import { isStage } from "./stage.js";
import { createModelAdapter, createNoopModelAdapter } from "@slad/model-providers";
import type { ChatMessage, CompletionOptions } from "@slad/model-providers";
import { NoopTelemetry } from "@slad/telemetry";
import { ToolRegistry } from "@slad/tools";
import { BudgetTracker } from "@slad/context-budget";

const noopLogger: PipelineLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export async function runPipeline<Input = unknown, Output = unknown, Services extends PipelineServices = PipelineServices>(
  options: PipelineRunOptions<Input, Services>,
): Promise<PipelineRunResult<Output>> {
  const pipelineId = options.id ?? "pipeline";
  const runId = options.runId ?? createRunId();
  const startedAt = now();
  const logger = { ...noopLogger, ...options.logger };
  const services = {
    ...(options.services ?? {}),
    ...(options.cache ? { cache: options.cache } : {}),
  } as Services;
  const state = new Map<string, unknown>();
  const stages: Stage<unknown, unknown, Services>[] = options.stages.map((stage) => resolveStage(stage, options));
  const stageResults: StageResult[] = [];
  const artifacts: PipelineArtifact[] = [];

  // Build shared context helpers
  const budget = options.policies?.budget;
  let modelCallCount = 0;
  const stageIdRef = { current: "" };
  const rawProvider = services.provider;
  const budgetTracker = rawProvider && budget?.maxUsd != null
    ? new BudgetTracker(budget.modelId ?? "_default", budget.maxUsd, 0)
    : null;
  const needsWrap = rawProvider && (budget?.maxModelCalls != null || budgetTracker != null);
  const wrappedProvider = needsWrap
    ? {
        ...rawProvider!,
        complete: (messages: ChatMessage[], opts?: CompletionOptions) => {
          modelCallCount++;
          if (budget?.maxModelCalls != null && modelCallCount > budget.maxModelCalls) {
            throw new Error(`Pipeline budget exceeded: maxModelCalls (${budget.maxModelCalls}) reached`);
          }
          if (budgetTracker?.isExceeded()) {
            throw new Error(`Pipeline budget exceeded: maxUsd ($${budget!.maxUsd}) reached`);
          }
          const wrappedOpts = budgetTracker
            ? {
                ...opts,
                onUsage: (inputTokens: number, outputTokens: number) => {
                  opts?.onUsage?.(inputTokens, outputTokens);
                  budgetTracker.record(stageIdRef.current, inputTokens, outputTokens);
                },
              }
            : opts;
          return rawProvider!.complete(messages, wrappedOpts);
        },
      }
    : rawProvider;

  const model = wrappedProvider
    ? createModelAdapter(wrappedProvider)
    : createNoopModelAdapter();
  const tools = services.tools instanceof ToolRegistry ? services.tools : new ToolRegistry();
  const telemetry = services.telemetry ?? NoopTelemetry;
  const memory = services.memory;
  const audit = {
    emit: (event: string, data: Record<string, unknown>) => {
      logger.debug(`audit:${event}`, data);
      telemetry.emit(event, data);
    },
  };

  let current: unknown = options.input;

  for (const stage of stages) {
    if (options.signal?.aborted) {
      return finish("cancelled", current as Output | undefined);
    }

    stageIdRef.current = stage.id;
    const stageStartedAt = now();
    const startMs = Date.now();
    const stageArtifacts: PipelineArtifact[] = [];
    await options.onStageStart?.({ pipelineId, runId, stageId: stage.id, startedAt: stageStartedAt });

    const emitArtifact: StageContext<Services>["emitArtifact"] = async (name, value, metadata) => {
      const artifact = { stageId: stage.id, name, value, metadata, createdAt: now() };
      stageArtifacts.push(artifact);
      artifacts.push(artifact);
      await options.onArtifact?.(stage.id, artifact);
      return artifact;
    };

    const ctx: StageContext<Services> = {
      pipelineId,
      runId,
      stageId: stage.id,
      services,
      logger,
      signal: options.signal,
      state,
      model,
      tools,
      audit,
      memory,
      telemetry,
      emitArtifact,
    };

    try {
      const cacheEntry = await readCached(stage, current, ctx);
      if (cacheEntry.hit) {
        current = cacheEntry.value;
        const completedAt = now();
        const result = makeStageResult(stage.id, "cached", stageStartedAt, completedAt, startMs, current, stageArtifacts);
        stageResults.push(result);
        await options.onStageComplete?.({ ...toCompleteEvent(pipelineId, runId, result), status: "cached" });
        continue;
      }

      const span = telemetry.startSpan(`stage.${stage.id}`, { pipelineId, runId });
      current = await stage.run(current, ctx);
      span.end({ status: "completed" });

      if (stage.outputSchema) {
        const validation = stage.outputSchema.safeParse(current);
        if (!validation.success) {
          logger.warn("Stage output schema validation failed", {
            stageId: stage.id,
            issues: validation.error.issues,
          });
        }
      }

      await writeCached(cacheEntry.key, stage, current, ctx);

      const completedAt = now();
      const result = makeStageResult(stage.id, "completed", stageStartedAt, completedAt, startMs, current, stageArtifacts);
      stageResults.push(result);
      await options.onStageComplete?.(toCompleteEvent(pipelineId, runId, result));
    } catch (err) {
      const failedAt = now();
      const error = err instanceof Error ? err : new Error(String(err));
      telemetry.emit(`stage.${stage.id}.failed`, { pipelineId, runId, error: error.message });
      const result: StageResult = {
        stageId: stage.id,
        status: "failed",
        error,
        startedAt: stageStartedAt,
        completedAt: failedAt,
        durationMs: Date.now() - startMs,
        artifacts: stageArtifacts,
      };
      stageResults.push(result);
      await options.onStageError?.({
        pipelineId,
        runId,
        stageId: stage.id,
        startedAt: stageStartedAt,
        failedAt,
        durationMs: result.durationMs,
        error,
      });
      return finish("failed", current as Output | undefined);
    }
  }

  return finish("completed", current as Output | undefined);

  function finish(status: PipelineRunResult["status"], output: Output | undefined): PipelineRunResult<Output> {
    const completedAt = now();
    return {
      pipelineId,
      runId,
      status,
      output,
      stages: stageResults,
      artifacts,
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    };
  }
}

function resolveStage<Services extends PipelineServices>(
  stage: PipelineDefinition<Services>["stages"][number],
  options: PipelineDefinition<Services>,
): Stage<unknown, unknown, Services> {
  if (isStage(stage)) return stage as Stage<unknown, unknown, Services>;
  const registry = options.registry;
  const stageId = String(stage);
  const resolved = registry instanceof Map
    ? registry.get(stageId)
    : (registry as Record<StageId, Stage<unknown, unknown, Services>> | undefined)?.[stageId];
  if (!resolved) throw new Error(`Unknown pipeline stage: ${stageId}`);
  return resolved;
}

async function readCached(
  stage: Stage<unknown, unknown>,
  input: unknown,
  ctx: StageContext,
): Promise<{ hit: true; key: string; value: unknown } | { hit: false; key?: string }> {
  const config = cacheConfig(stage);
  if (!config.enabled || !ctx.services.cache) return { hit: false };
  const key = await cacheKey(stage.id, input, ctx, config);
  const value = ctx.services.cache.get(key);
  return value === undefined ? { hit: false, key } : { hit: true, key, value };
}

function writeCached(key: string | undefined, stage: Stage<unknown, unknown>, output: unknown, ctx: StageContext): void {
  const config = cacheConfig(stage);
  if (!key || !config.enabled || !ctx.services.cache) return;
  ctx.services.cache.set(key, output, config.ttlMs);
}

function cacheConfig(stage: Stage<unknown, unknown>): Required<Pick<StageCacheConfig<unknown>, "enabled">> & StageCacheConfig<unknown> {
  if (stage.cache === true) return { enabled: true };
  if (!stage.cache) return { enabled: false };
  return { enabled: stage.cache.enabled ?? true, ttlMs: stage.cache.ttlMs, key: stage.cache.key };
}

async function cacheKey(
  stageId: StageId,
  input: unknown,
  ctx: StageContext,
  config: StageCacheConfig<unknown>,
): Promise<string> {
  if (config.key) {
    return config.key(input, {
      pipelineId: ctx.pipelineId,
      runId: ctx.runId,
      stageId: ctx.stageId,
      services: ctx.services,
      logger: ctx.logger,
      signal: ctx.signal,
      state: ctx.state,
      model: ctx.model,
      tools: ctx.tools,
      audit: ctx.audit,
      memory: ctx.memory,
      telemetry: ctx.telemetry,
    });
  }
  return `${stageId}:${stableStringify(input)}`;
}

function makeStageResult(
  stageId: StageId,
  status: "completed" | "cached",
  startedAt: string,
  completedAt: string,
  startMs: number,
  output: unknown,
  artifacts: PipelineArtifact[],
): StageResult {
  return { stageId, status, output, startedAt, completedAt, durationMs: Date.now() - startMs, artifacts };
}

function toCompleteEvent(pipelineId: string, runId: string, result: StageResult) {
  return {
    pipelineId,
    runId,
    stageId: result.stageId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}
