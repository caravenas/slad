import type { RoutingDecision } from "@slad/shared";
import { RoutingDecision as RoutingDecisionSchema } from "@slad/shared";
import type { ModelProvider } from "@slad/model-providers";
import { CLASSIFIER_SYSTEM } from "../agents/prompts.js";

/** Returns the cheapest fast model for the given provider. */
function fastModel(providerName: string): string {
  switch (providerName) {
    case "anthropic": return "claude-haiku-4-5-20251001";
    case "openai":    return "gpt-4o-mini";
    case "gemini":    return "gemini-2.0-flash";
    default:          return "claude-haiku-4-5-20251001";
  }
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

/**
 * Classifies an intent into a routing mode using a fast model.
 * Returns null if classification fails — callers must treat null as "continue with default".
 * Never throws.
 */
export async function classifyIntent(
  intent: string,
  provider: ModelProvider,
  providerName: string,
): Promise<RoutingDecision | null> {
  if (providerName === "cli") return null; // binary provider — skip

  try {
    const raw = await provider.complete(
      [{ role: "user", content: intent }],
      {
        systemPrompt: CLASSIFIER_SYSTEM,
        temperature: 0,
        maxTokens: 128,
        model: fastModel(providerName),
      },
    );

    const parsed = JSON.parse(extractJson(raw));
    return RoutingDecisionSchema.parse(parsed);
  } catch {
    return null;
  }
}
