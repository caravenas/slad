import type { RoutingDecision } from "@slad/shared";
import { RoutingDecision as RoutingDecisionSchema } from "@slad/shared";
import type { ModelProvider } from "@slad/model-providers";
import { CLASSIFIER_SYSTEM } from "../agents/prompts.js";

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

/**
 * Classifies an intent into a routing mode using the configured agent CLI
 * backend (whichever model CLI_MODEL / the backend default selects).
 * Returns null if classification fails — callers must treat null as
 * "continue with default". Never throws.
 */
export async function classifyIntent(
  intent: string,
  provider: ModelProvider,
): Promise<RoutingDecision | null> {
  try {
    const raw = await provider.complete(
      [{ role: "user", content: intent }],
      {
        systemPrompt: CLASSIFIER_SYSTEM,
        temperature: 0,
        maxTokens: 128,
      },
    );

    const parsed = JSON.parse(extractJson(raw));
    return RoutingDecisionSchema.parse(parsed);
  } catch {
    return null;
  }
}
