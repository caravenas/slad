import { z } from "zod";
import { ExploreOutput, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import { mergeUnansweredQuestions } from "./util.js";
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
    const { prompts, promptGuidance } = ctx.services;
    const baseSystem = prompts?.explorer ?? DEFAULT_EXPLORER;
    const system = promptGuidance ? promptGuidance("explore", baseSystem) : baseSystem;

    const exploreUserContent = [
      input.wikiContext ? `Contexto de la wiki del usuario (solo referencia):\n\n${input.wikiContext}\n\n---\n` : "",
      input.projectContext ?? "",
      `Intención del usuario:\n${input.intent}`,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "user", content: exploreUserContent }];

    const output = await ctx.model.generateObject({
      schema: ExploreOutput as z.ZodType<ExploreOutput>,
      system,
      messages,
      temperature: 0.5,
      maxTokens: 2048,
    });

    // El prompt ya no pide que el modelo repita la intención; se completa acá.
    if (!output.intent) output.intent = input.intent;

    // Sin HITL: si el modelo igual pide humano, sus preguntas quedan como openQuestions.
    if (output.status === "awaiting_human" || output.questions.length > 0) {
      output.openQuestions = mergeUnansweredQuestions(output.openQuestions, output.questions);
      output.questions = [];
      output.status = "completed";
    }

    await ctx.emitArtifact("explore", output);
    return output;
  },
});
