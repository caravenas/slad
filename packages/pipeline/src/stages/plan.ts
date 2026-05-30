import { z } from "zod";
import { PlanOutput, SnapshotOutput, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import type { SladServices } from "./types.js";

const DEFAULT_PLANNER = "You are a planner agent. Output JSON only.";

export const planStage = defineStage<SnapshotOutput, PlanOutput, SladServices>({
  id: "plan",
  description: "Crea el plan de ejecución a partir del snapshot",
  inputSchema: SnapshotOutput as z.ZodType<SnapshotOutput>,
  outputSchema: PlanOutput as z.ZodType<PlanOutput>,
  permissions: ["read"],
  cache: { key: (input) => `plan:${Buffer.from(input.content).toString('base64').substring(0, 64)}` },

  async run(input, ctx) {
    const { prompts, promptGuidance, hitl, workspace } = ctx.services;
    const baseSystem = prompts?.planner ?? DEFAULT_PLANNER;
    const system = promptGuidance ? promptGuidance("plan", baseSystem) : baseSystem;

    const planUserContent = [
      workspace ?? "",
      `Snapshot:\n\n${input.content}`,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "user", content: planUserContent }];
    let output!: PlanOutput;
    const maxRounds = 3;
    let rounds = 0;

    while (rounds <= maxRounds) {
      output = await ctx.model.generateObject({
        schema: PlanOutput as z.ZodType<PlanOutput>,
        system,
        messages,
        temperature: 0.2,
        maxTokens: 2500,
      });

      if (output.status !== "awaiting_human" || output.questions.length === 0 || !hitl) {
        break;
      }

      if (rounds >= maxRounds || !hitl.canPrompt()) {
        break;
      }

      const answers = await hitl.collectAnswers(output.questions);
      const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value}`);
      const answerContent = `Respuestas del humano:\n${lines.join("\n")}\n\nContinuá la tarea con esta información. Respondé ÚNICAMENTE con el JSON de output según el schema esperado, sin texto adicional.`;

      messages.push({ role: "assistant", content: JSON.stringify(output) });
      messages.push({ role: "user", content: answerContent });
      rounds++;
    }

    await ctx.emitArtifact("plan", output);
    return output;
  },
});
