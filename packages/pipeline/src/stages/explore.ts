import { z } from "zod";
import { ExploreOutput, toCompactJson, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import type { SladServices } from "./types.js";

const DEFAULT_EXPLORER = "You are an explorer agent. Output JSON only.";

export const ExploreInputSchema = z.object({
  intent: z.string(),
  projectContext: z.string().optional(),
  wikiContext: z.string().optional(),
});

export type ExploreInput = z.infer<typeof ExploreInputSchema>;

export const exploreStage = defineStage<ExploreInput, ExploreOutput, SladServices>({
  id: "explore",
  description: "Analiza el intent del usuario, genera enfoques, riesgos y preguntas abiertas",
  inputSchema: ExploreInputSchema as z.ZodType<ExploreInput>,
  outputSchema: ExploreOutput as z.ZodType<ExploreOutput>,
  permissions: ["read"],
  cache: { key: (input) => `explore:${Buffer.from(input.intent).toString('base64')}` },

  async run(input, ctx) {
    const { prompts, promptGuidance, hitl } = ctx.services;
    const baseSystem = prompts?.explorer ?? DEFAULT_EXPLORER;
    const system = promptGuidance ? promptGuidance("explore", baseSystem) : baseSystem;

    const exploreUserContent = [
      input.wikiContext ? `Contexto de la wiki del usuario (solo referencia):\n\n${input.wikiContext}\n\n---\n` : "",
      input.projectContext ?? "",
      `Intención del usuario:\n${input.intent}`,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "user", content: exploreUserContent }];
    let output!: ExploreOutput;
    const maxRounds = 3;
    let rounds = 0;

    while (rounds <= maxRounds) {
      output = await ctx.model.generateObject({
        schema: ExploreOutput as z.ZodType<ExploreOutput>,
        system,
        messages,
        temperature: 0.5,
        maxTokens: 2048,
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

      messages.push({ role: "assistant", content: toCompactJson(output) });
      messages.push({ role: "user", content: answerContent });
      rounds++;
    }

    // El prompt ya no pide que el modelo repita la intención; se completa acá.
    if (!output.intent) output.intent = input.intent;

    await ctx.emitArtifact("explore", output);
    return output;
  },
});
