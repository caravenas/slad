import type { ModelProvider } from "@slad/model-providers";
import type { ExecutionHarness } from "@slad/harness";
import type { HITLTransport } from "@slad/hitl";
import type { ToolRegistry } from "@slad/tools";
import type { CacheStore } from "@slad/cache";
import type { PipelineServices } from "../types.js";
import type { DecisionRecord } from "@slad/shared";

/** Services bag que los SLAD stages requieren */
export interface SladServices extends PipelineServices {
  provider: ModelProvider;       // required
  harness?: ExecutionHarness;
  hitl?: HITLTransport;
  tools?: ToolRegistry;
  cache?: CacheStore<unknown>;
  /** System prompts inyectables — el CLI pasa los suyos, Hermes puede sustituirlos */
  prompts?: SladPrompts;
  /** Prompt guidance wrapper (e.g. profile-based) */
  promptGuidance?: (stage: string, system: string) => string;
  /** Working directory for project context */
  workspace?: string;
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
