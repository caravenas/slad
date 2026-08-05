import { runPipeline } from "./runner.js";
import { definePipeline } from "./stage.js";
import { exploreStage } from "./stages/explore.js";
import { snapshotStage } from "./stages/snapshot.js";
import { planStage } from "./stages/plan.js";
import { runStage } from "./stages/run.js";
import { learnStage } from "./stages/learn.js";
import type { SladServices, SladPrompts } from "./stages/types.js";
import type { PipelineDefinition, PipelinePolicies } from "./types.js";
import type { ModelProvider } from "@slad/model-providers";
import type { ExecutionHarness } from "@slad/harness";
import type { HITLTransport } from "@slad/hitl";
import type { CacheStore } from "@slad/cache";
import type { ToolRegistry } from "@slad/tools";

export type SladPipelineStageId = "explore" | "snapshot" | "plan" | "run" | "learn";

export interface SladPipelineOptions {
  intent?: string;
  initialInput?: unknown;
  provider: ModelProvider;
  stages?: SladPipelineStageId[];      // default: ["explore","snapshot","plan","run","learn"]
  model?: string;
  harness?: ExecutionHarness;
  hitl?: HITLTransport;
  cache?: CacheStore<unknown>;
  prompts?: SladPrompts;
  tools?: ToolRegistry;
  budget?: { maxCostUsd?: number };
  workspace?: string;
  signal?: AbortSignal;
  onArtifact?: (stage: string, artifact: unknown) => Promise<void> | void;
  onStageStart?: (stage: string) => void;
  onStageComplete?: (stage: string, output: unknown) => void;
  onUsage?: (stage: string, inputTokens: number, outputTokens: number) => void;
  maxTasks?: number;
  onTaskStart?: (taskId: string, title: string) => void;
  onTaskComplete?: (taskId: string, status: string) => void;
}

export interface SladPipelineResult {
  status: "completed" | "partial" | "failed";
  stagesCompleted: string[];
  outputs: Record<string, unknown>;
  artifacts: Record<string, string>;
  /** "stageId: message" for each failed stage. */
  errors: string[];
  durationMs: number;
}

const STAGE_MAP = {
  explore: exploreStage,
  snapshot: snapshotStage,
  plan: planStage,
  run: runStage,
  learn: learnStage,
} as const;

/**
 * Build a SLAD pipeline definition for use with createAgent().
 * Accepts pipeline configuration (prompts, stages, workspace, policies).
 * Runtime dependencies (model, harness, hitl) are injected by createAgent.
 */
export function buildSladPipeline(options: {
  stages?: SladPipelineStageId[];
  prompts?: SladPrompts;
  workspace?: string;
  cache?: CacheStore<unknown>;
  policies?: PipelinePolicies;
}): PipelineDefinition {
  const stageIds = options.stages ?? ["explore", "snapshot", "plan", "run", "learn"];
  // Cast stages to AnyStage<PipelineServices> so services don't need provider at build time.
  // The provider (and harness/hitl) are injected by createAgent() at run time.
  const stages = stageIds.map((id) => STAGE_MAP[id]) as import("./types.js").AnyStage<import("./types.js").PipelineServices>[];
  return definePipeline({
    id: "slad-software-dev",
    stages,
    services: {
      ...(options.prompts ? { prompts: options.prompts } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.cache ? { cache: options.cache } : {}),
    },
    policies: options.policies,
  });
}

export async function runSladPipeline(options: SladPipelineOptions): Promise<SladPipelineResult> {
  const stageIds = options.stages ?? ["explore", "snapshot", "plan", "run", "learn"];
  const stages = stageIds.map(id => STAGE_MAP[id]);
  
  const services: SladServices = {
    provider: options.provider,
    model: options.model,
    harness: options.harness,
    hitl: options.hitl,
    cache: options.cache,
    tools: options.tools,
    prompts: options.prompts,
    workspace: options.workspace,
    maxTasks: options.maxTasks,
    onTaskStart: options.onTaskStart,
    onTaskComplete: options.onTaskComplete,
  };

  const result = await runPipeline({
    id: "slad-software-dev",
    stages,
    services,
    input: options.initialInput ?? { intent: options.intent ?? "auto" },
    signal: options.signal,
    onStageStart: (e) => options.onStageStart?.(e.stageId),
    onStageComplete: (e) => options.onStageComplete?.(e.stageId, undefined),
    onArtifact: (stageId, artifact) => options.onArtifact?.(stageId, artifact.value),
  });

  return {
    status: result.status === "completed" ? "completed" : result.status === "failed" ? "failed" : "partial",
    stagesCompleted: result.stages.filter(s => s.status === "completed").map(s => s.stageId),
    outputs: Object.fromEntries(result.stages.map(s => [s.stageId, s.output])),
    artifacts: Object.fromEntries(result.artifacts.map(a => [a.stageId, a.name])),
    errors: result.stages.filter(s => s.error).map(s => `${s.stageId}: ${s.error!.message}`),
    durationMs: result.durationMs,
  };
}
