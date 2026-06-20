import type { ModelProvider } from "@slad/model-providers";
import { createAgent } from "@slad/agent";
import { z } from "zod";
import { definePipeline, defineStage } from "@slad/pipeline";
import { tools } from "../tools/registry.js";

/**
 * Runtime entrypoint for "{{name}}". This is the seam that lets the same agent
 * run from CLI, an HTTP handler (./api), a worker, Slack, or MCP — see Principle 3.
 */

const stage = defineStage<{ intent: string }, { result: string }>({
  id: "{{id}}.main",
  inputSchema: z.object({ intent: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  async run(input, ctx) {
    const result = await ctx.model.generateText({
      system: "You are the {{name}} orchestrator.",
      input,
    });
    return { result };
  },
});

const pipeline = definePipeline({ id: "{{id}}", version: "0.1.0", stages: [stage] });

const provider: ModelProvider = {
  name: "anthropic",
  async complete() {
    return "Replace this mock provider with getProvider(...).";
  },
};

export const {{name}}Agent = createAgent<{ intent: string }, { result: string }>({
  id: "{{id}}",
  model: provider,
  tools,
  pipeline,
});

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const out = await {{name}}Agent.run({ intent: process.argv.slice(2).join(" ") || "hello" });
  console.log(out.output?.result ?? "(no output)");
}
