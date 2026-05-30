import type { ModelProvider } from "@slad/model-providers";
import type { ExecutionHarness } from "@slad/harness";
import type { HITLTransport } from "@slad/hitl";
import type { MemoryProvider } from "@slad/memory";
import type { TelemetryProvider } from "@slad/telemetry";
import type { ToolDef } from "@slad/tools";
import { ToolRegistry } from "@slad/tools";
import type { PipelineDefinition, PipelineRunResult } from "@slad/pipeline";
import { runPipeline } from "@slad/pipeline";

// ─── Agent config ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Optional identifier for logging */
  id?: string;
  /** The model provider — injected into pipeline services as `provider` */
  model: ModelProvider;
  /** Tools available to the agent — registered in a ToolRegistry and injected into pipeline services */
  tools?: readonly ToolDef[];
  /** Execution harness (permission checking, audit) — injected as `harness` */
  safety?: ExecutionHarness;
  /** Human-in-the-loop transport — injected as `hitl` */
  hitl?: HITLTransport;
  /** Memory provider — injected into pipeline services as `memory` */
  memory?: MemoryProvider;
  /** Telemetry provider — injected into pipeline services as `telemetry` */
  telemetry?: TelemetryProvider;
  /** The pipeline definition to run */
  pipeline: PipelineDefinition;
}

// ─── Run options ──────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  onStageStart?: (stage: string) => void;
  onStageComplete?: (stage: string) => void;
  onArtifact?: (stage: string, artifact: unknown) => void | Promise<void>;
  signal?: AbortSignal;
}

// ─── Agent interface ──────────────────────────────────────────────────────────

export interface Agent<I = unknown, O = unknown> {
  run(input: I, options?: AgentRunOptions): Promise<PipelineRunResult<O>>;
}

// ─── createAgent ──────────────────────────────────────────────────────────────

export function createAgent<I = unknown, O = unknown>(config: AgentConfig): Agent<I, O> {
  return {
    run: async (input: I, options?: AgentRunOptions): Promise<PipelineRunResult<O>> => {
      const toolRegistry = config.tools && config.tools.length > 0
        ? buildRegistry(config.tools)
        : (config.pipeline.services as Record<string, unknown>)?.tools instanceof ToolRegistry
          ? (config.pipeline.services as Record<string, unknown>).tools as ToolRegistry
          : new ToolRegistry();

      const mergedServices = {
        ...config.pipeline.services,
        provider: config.model,
        ...(config.safety !== undefined ? { harness: config.safety } : {}),
        ...(config.hitl !== undefined ? { hitl: config.hitl } : {}),
        ...(config.memory !== undefined ? { memory: config.memory } : {}),
        ...(config.telemetry !== undefined ? { telemetry: config.telemetry } : {}),
        tools: toolRegistry,
      };

      return runPipeline<I, O>({
        ...config.pipeline,
        input,
        services: mergedServices as PipelineDefinition["services"],
        signal: options?.signal,
        onStageStart: compose(
          config.pipeline.onStageStart,
          options?.onStageStart ? (e) => options.onStageStart!(e.stageId) : undefined,
        ),
        onStageComplete: compose(
          config.pipeline.onStageComplete,
          options?.onStageComplete ? (e) => options.onStageComplete!(e.stageId) : undefined,
        ),
        onArtifact: compose(
          config.pipeline.onArtifact,
          options?.onArtifact ? (stageId, artifact) => options.onArtifact!(stageId, artifact.value) : undefined,
        ),
      });
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRegistry(tools: readonly ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerDefs(tools);
  return registry;
}

function compose<T extends (...args: any[]) => any>(
  a: T | undefined,
  b: T | undefined,
): T | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return (async (...args: Parameters<T>) => {
    await a(...args);
    await b(...args);
  }) as T;
}
