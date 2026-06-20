import type { ChatMessage, CompletionOptions, ModelProvider } from "@slad/model-providers";

/**
 * A deterministic, offline ModelProvider so the example runs end-to-end with
 * no API keys or network. It branches on the system prompt set by each stage:
 *  - RESEARCH_PLANNER     → returns JSON parsed by `generateObject`
 *  - RESEARCH_SYNTHESIZER → returns a markdown report for `generateText`
 *
 * Swap this for `getProvider("anthropic", apiKey)` to run against a real model.
 */
export function createMockResearchProvider(): ModelProvider {
  return {
    name: "anthropic",
    async complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string> {
      const system = opts?.systemPrompt ?? "";
      const userContent = messages.map((m) => m.content).join("\n");

      if (system.includes("RESEARCH_PLANNER")) {
        const topic = readTopic(userContent);
        return JSON.stringify({
          queries: [
            `${topic} — overview and definitions`,
            `${topic} — key challenges and trade-offs`,
            `${topic} — recent advances and tooling`,
          ],
        });
      }

      if (system.includes("RESEARCH_SYNTHESIZER")) {
        const topic = readTopic(userContent);
        return [
          `# Research briefing: ${topic}`,
          "",
          "## Summary",
          `A synthesized overview of ${topic}, assembled from the gathered findings.`,
          "",
          "## Key points",
          "- The topic was decomposed into focused queries.",
          "- Each query was executed through the search tool.",
          "- Findings were collapsed into this briefing.",
        ].join("\n");
      }

      return "";
    },
  };
}

/** Best-effort extraction of the `topic` field from a stage's JSON input. */
function readTopic(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { topic?: unknown };
    if (typeof parsed.topic === "string") return parsed.topic;
  } catch {
    // input was not JSON; fall through
  }
  return "the requested topic";
}
