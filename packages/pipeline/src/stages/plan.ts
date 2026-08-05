import { z } from "zod";
import { PlanOutput, SnapshotOutput, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import { mergeUnansweredQuestions } from "./util.js";
import type { SladServices } from "./types.js";

const DEFAULT_PLANNER = "You are a planner agent. Output JSON only.";

export const planStage = defineStage<SnapshotOutput, PlanOutput, SladServices>({
  id: "plan",
  description: "Crea el plan de ejecución a partir del snapshot",
  inputSchema: SnapshotOutput as z.ZodType<SnapshotOutput>,
  outputSchema: PlanOutput as z.ZodType<PlanOutput>,
  permissions: ["workspace:read", "model:generate"],
  cache: { key: (input) => `plan:${Buffer.from(input.content).toString('base64').substring(0, 64)}` },

  async run(input, ctx) {
    const { prompts, promptGuidance, workspace } = ctx.services;
    const baseSystem = prompts?.planner ?? DEFAULT_PLANNER;
    const system = promptGuidance ? promptGuidance("plan", baseSystem) : baseSystem;

    const planUserContent = [
      workspace ?? "",
      `Snapshot:\n\n${input.content}`,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "user", content: planUserContent }];

    const output = await ctx.model.generateObject({
      schema: PlanOutput as z.ZodType<PlanOutput>,
      system,
      messages,
      temperature: 0.2,
      maxTokens: 2500,
    });

    // Sin HITL: si el modelo igual pide humano, sus preguntas quedan como openQuestions.
    if (output.status === "awaiting_human" || output.questions.length > 0) {
      output.openQuestions = mergeUnansweredQuestions(output.openQuestions, output.questions);
      output.questions = [];
      output.status = "completed";
    }

    await ctx.emitArtifact("plan", output);
    return output;
  },
});
