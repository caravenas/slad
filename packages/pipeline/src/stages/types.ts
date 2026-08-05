import type { ModelProvider } from "@slad/model-providers";
import type { ExecutionHarness } from "@slad/harness";
import type { ToolRegistry } from "@slad/tools";
import type { CacheStore } from "@slad/cache";
import type { PipelineServices } from "../types.js";
import type { DecisionRecord } from "@slad/shared";

/**
 * Services bag que los SLAD stages requieren.
 *
 * Los stages no usan HITL: deciden de forma autónoma y registran assumptions /
 * openQuestions. `hitl` sigue disponible vía PipelineServices para consumidores
 * externos al pipeline (comandos del CLI), pero ningún stage lo lee.
 */
export interface SladServices extends PipelineServices {
  provider: ModelProvider;       // required
  /** Default model id passed to every provider call (providers may override per call). */
  model?: string;
  harness?: ExecutionHarness;
  tools?: ToolRegistry;
  cache?: CacheStore<unknown>;
  /** System prompts inyectables — el CLI pasa los suyos, Hermes puede sustituirlos */
  prompts?: SladPrompts;
  /** Prompt guidance wrapper (e.g. profile-based) */
  promptGuidance?: (stage: string, system: string) => string;
  /** Working directory for project context */
  workspace?: string;
  /** Hard cap on task executions for the run stage. */
  maxTasks?: number;
  /** Per-task progress callbacks (used by run stage) */
  onTaskStart?: (taskId: string, title: string) => void;
  onTaskComplete?: (taskId: string, status: string) => void;
}

/** Prompts inyectables */
export interface SladPrompts {
  explorer: string;
  snapshot: string;
  planner: string;
  builderReviewer: string;
  arbiterExplore?: string;
  arbiterPlan?: string;
}

export interface SladStageCallbacks {
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  onDecisions?: (decisions: DecisionRecord[]) => Promise<void>;
}
