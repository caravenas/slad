/**
 * Canonical pipeline event names (contract §7.4 of the SLAD folder-structure plan).
 *
 * These are the stable string identifiers that audit logs, telemetry exporters,
 * dashboards and the registry key off. Centralizing them here makes the event
 * taxonomy part of the public contract instead of stringly-typed scatter.
 *
 * The runtime currently surfaces stage lifecycle through the `onStage*` callbacks
 * and telemetry spans; these constants give consumers a single, typed vocabulary
 * to align on as `ctx.audit.emit(...)` adoption grows.
 */
export const PIPELINE_EVENTS = {
  pipelineStarted: "pipeline.started",
  pipelineCompleted: "pipeline.completed",
  pipelineFailed: "pipeline.failed",
  pipelineResumed: "pipeline.resumed",

  stageStarted: "pipeline.stage.started",
  stageCompleted: "pipeline.stage.completed",
  stageFailed: "pipeline.stage.failed",

  checkpointSaved: "checkpoint.saved",
  checkpointLoaded: "checkpoint.loaded",

  toolStarted: "tool.started",
  toolCompleted: "tool.completed",
  toolFailed: "tool.failed",

  approvalRequested: "approval.requested",
  approvalGranted: "approval.granted",
  approvalRejected: "approval.rejected",

  budgetWarning: "budget.warning",
  budgetExceeded: "budget.exceeded",
} as const;

/** Union of all canonical pipeline event name strings. */
export type PipelineEventName = (typeof PIPELINE_EVENTS)[keyof typeof PIPELINE_EVENTS];
