import type { z } from "zod";
import type { Permission } from "@slad/shared";
import type { CacheStore } from "@slad/cache";
import type { ExecutionHarness } from "@slad/harness";
import type { HITLTransport } from "@slad/hitl";
import type { MemoryProvider } from "./memory/index.js";
import type { ModelAdapter, ModelProvider } from "@slad/model-providers";
import type { TelemetryProvider } from "./telemetry/index.js";
import type { ToolRegistry } from "@slad/tools";

export type StageId = string;

export type PipelineStatus = "completed" | "failed" | "cancelled";
export type StageStatus = "completed" | "failed" | "skipped" | "cached";
export type SchemaValidationMode = "enforce" | "warn";

export interface PipelineLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface PipelineArtifact<T = unknown> {
  stageId: StageId;
  name: string;
  value: T;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineServices {
  provider?: ModelProvider;
  harness?: ExecutionHarness;
  hitl?: HITLTransport;
  tools?: ToolRegistry;
  cache?: CacheStore<unknown>;
  memory?: MemoryProvider;
  telemetry?: TelemetryProvider;
  [serviceName: string]: unknown;
}

// ─── Pipeline policies ────────────────────────────────────────────────────────

export interface PipelinePolicies {
  checkpoint?: "after-each-stage" | "on-error" | "never";
  resume?: boolean;
  audit?: boolean;
  telemetry?: boolean;
  budget?: { maxUsd?: number; maxModelCalls?: number; modelId?: string };
  humanApproval?: { requiredForRisk?: ("low" | "medium" | "high")[] };
}

// ─── Audit emitter ───────────────────────────────────────────────────────────

export interface PipelineAuditEmitter {
  emit(event: string, data: Record<string, unknown>): void;
}

// ─── Stage context ───────────────────────────────────────────────────────────

export interface StageContext<Services extends PipelineServices = PipelineServices> {
  pipelineId: string;
  runId: string;
  stageId: StageId;
  services: Services;
  logger: PipelineLogger;
  signal?: AbortSignal;
  state: Map<string, unknown>;
  /** Typed model adapter — use instead of ctx.services.provider.complete() */
  model: ModelAdapter;
  /** Tool registry — call tools by id */
  tools: ToolRegistry;
  /** Audit event emitter */
  audit: PipelineAuditEmitter;
  /** Memory provider — available when wired in pipeline services */
  memory?: MemoryProvider;
  /** Telemetry provider — available when wired in pipeline services */
  telemetry?: TelemetryProvider;
  emitArtifact<T = unknown>(name: string, value: T, metadata?: Record<string, unknown>): Promise<PipelineArtifact<T>>;
}

export interface StageCacheConfig<Input> {
  enabled?: boolean;
  ttlMs?: number;
  key?: (input: Input, ctx: Omit<StageContext, "emitArtifact">) => string | Promise<string>;
}

export interface Stage<Input = unknown, Output = unknown, Services extends PipelineServices = PipelineServices> {
  readonly id: StageId;
  readonly description?: string;
  readonly inputSchema?: z.ZodType<Input>;
  readonly outputSchema?: z.ZodType<Output>;
  readonly permissions?: readonly Permission[];
  readonly cache?: boolean | StageCacheConfig<Input>;
  run(input: Input, ctx: StageContext<Services>): Promise<Output>;
}

export type AnyStage<Services extends PipelineServices = PipelineServices> = Stage<any, any, Services>;
export type StageRef<Services extends PipelineServices = PipelineServices> = AnyStage<Services> | StageId;

export interface PipelineDefinition<Services extends PipelineServices = PipelineServices> {
  readonly id?: string;
  readonly version?: string;
  readonly stages: readonly StageRef<Services>[];
  readonly services?: Services;
  readonly registry?: ReadonlyMap<StageId, AnyStage<Services>> | Record<StageId, AnyStage<Services>>;
  readonly logger?: Partial<PipelineLogger>;
  readonly cache?: CacheStore<unknown>;
  readonly signal?: AbortSignal;
  readonly policies?: PipelinePolicies;
  /** Defaults to enforce. Warn is an explicit SDK compatibility bridge only. */
  readonly schemaValidation?: SchemaValidationMode;
  onArtifact?(stageId: StageId, artifact: PipelineArtifact): Promise<void> | void;
  onStageStart?(event: StageStartEvent): Promise<void> | void;
  onStageComplete?(event: StageCompleteEvent): Promise<void> | void;
  onStageError?(event: StageErrorEvent): Promise<void> | void;
}

export interface PipelineRunOptions<Input = unknown, Services extends PipelineServices = PipelineServices>
  extends PipelineDefinition<Services> {
  input?: Input;
  runId?: string;
}

export interface StageStartEvent {
  pipelineId: string;
  runId: string;
  stageId: StageId;
  startedAt: string;
}

export interface StageCompleteEvent {
  pipelineId: string;
  runId: string;
  stageId: StageId;
  status: StageStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface StageErrorEvent {
  pipelineId: string;
  runId: string;
  stageId: StageId;
  startedAt: string;
  failedAt: string;
  durationMs: number;
  error: Error;
}

export interface StageResult<Output = unknown> {
  stageId: StageId;
  status: StageStatus;
  output?: Output;
  error?: Error;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifacts: PipelineArtifact[];
}

export interface PipelineRunResult<Output = unknown> {
  pipelineId: string;
  runId: string;
  status: PipelineStatus;
  output?: Output;
  stages: StageResult[];
  artifacts: PipelineArtifact[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
