import { z } from "zod";
import { LearnOutput, RunOutput } from "@slad/shared";
import { defineStage } from "../stage.js";
import type { SladServices } from "./types.js";

const DEFAULT_LEARN = "You are a learning agent. Extract insights from the run. Output JSON only.";

export type LearnInput = RunOutput[];

export const learnStage = defineStage<LearnInput, LearnOutput, SladServices>({
  id: "learn",
  description: "Extrae aprendizajes post-ejecución para evolución futura",
  inputSchema: z.array(RunOutput) as z.ZodType<LearnInput>,
  outputSchema: LearnOutput as z.ZodType<LearnOutput>,
  permissions: ["read"],
  cache: { enabled: false },

  async run(input, ctx) {
    const { prompts, promptGuidance } = ctx.services;
    const baseSystem = prompts?.builderReviewer ?? DEFAULT_LEARN;
    const system = promptGuidance ? promptGuidance("learn", baseSystem) : baseSystem;

    const output = await ctx.model.generateObject({
      schema: LearnOutput as z.ZodType<LearnOutput>,
      system,
      input: `Run results:\n${JSON.stringify(input, null, 2)}`,
      temperature: 0.2,
      maxTokens: 1500,
    });

    await ctx.emitArtifact("learn", output);
    return output;
  },
});
