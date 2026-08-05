import { z } from "zod";
import { ExploreOutput, SnapshotOutput, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import { mergeUnansweredQuestions } from "./util.js";
import type { SladServices } from "./types.js";

const DEFAULT_SNAPSHOT = "You are a snapshot agent. Output JSON only.";

export const snapshotStage = defineStage<ExploreOutput, SnapshotOutput, SladServices>({
  id: "snapshot",
  description: "Crea una mini-spec (snapshot) a partir del análisis de exploración",
  inputSchema: ExploreOutput as z.ZodType<ExploreOutput>,
  outputSchema: SnapshotOutput as z.ZodType<SnapshotOutput>,
  permissions: ["workspace:read", "model:generate"],
  cache: { key: (input) => `snapshot:${Buffer.from(input.intent).toString('base64')}` },

  async run(input, ctx) {
    const { prompts, promptGuidance, workspace } = ctx.services;
    const baseSystem = prompts?.snapshot ?? DEFAULT_SNAPSHOT;
    const system = promptGuidance ? promptGuidance("snapshot", baseSystem) : baseSystem;
    const chosenApproach = input.approaches[0];
    const snapshotUserContent = [
      workspace ?? "",
      `Intent original:\n${input.intent}`,
      `Reframing:\n${input.reframing}`,
      chosenApproach
        ? `Enfoque elegido — ${chosenApproach.name}:\n${chosenApproach.summary}\nPros: ${chosenApproach.pros.join("; ")}\nCons: ${chosenApproach.cons.join("; ")}`
        : "",
      input.risks.length
        ? `Riesgos conocidos:\n- ${input.risks.join("\n- ")}`
        : "",
      input.openQuestions.length
        ? `Preguntas abiertas:\n- ${input.openQuestions.join("\n- ")}`
        : "",
      `Next step sugerido: ${input.recommendedNext}`,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "user", content: snapshotUserContent }];

    const output = await ctx.model.generateObject({
      schema: SnapshotOutput as z.ZodType<SnapshotOutput>,
      system,
      messages,
      temperature: 0.3,
      maxTokens: 1500,
    });

    // Sin HITL: si el modelo igual pide humano, sus preguntas quedan como assumptions
    // (el único campo del snapshot que registra lo que se resolvió sin confirmación).
    if (output.status === "awaiting_human" || output.questions.length > 0) {
      output.assumptions = mergeUnansweredQuestions(output.assumptions, output.questions);
      output.questions = [];
      output.status = "completed";
    }

    await ctx.emitArtifact("snapshot", output);
    return output;
  },
});
