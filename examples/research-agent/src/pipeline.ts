import { definePipeline } from "@slad/pipeline";
import { gatherStage, planStage, synthesizeStage } from "./stages.js";

/**
 * The research pipeline: plan-queries → gather → synthesize.
 * Each stage's output is validated and fed as the next stage's input.
 */
export const researchPipeline = definePipeline({
  id: "research",
  version: "0.1.0",
  stages: [planStage, gatherStage, synthesizeStage],
});
