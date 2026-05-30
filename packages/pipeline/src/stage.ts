import type { AnyStage, PipelineDefinition, PipelineServices, Stage, StageRef } from "./types.js";

export function defineStage<Input, Output, Services extends PipelineServices = PipelineServices>(
  stage: Stage<Input, Output, Services>,
): Stage<Input, Output, Services> {
  return stage;
}

export function definePipeline<Services extends PipelineServices = PipelineServices>(
  definition: PipelineDefinition<Services>,
): PipelineDefinition<Services> {
  return definition;
}

export function isStage<Services extends PipelineServices = PipelineServices>(value: StageRef<Services>): value is AnyStage<Services> {
  return typeof value === "object" && value !== null && "id" in value && "run" in value;
}
