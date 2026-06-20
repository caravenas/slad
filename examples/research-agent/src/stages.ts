import { z } from "zod";
import { defineStage } from "@slad/pipeline";
import {
  GatherOutput,
  PlanOutput,
  ReportOutput,
  ResearchInput,
  type SearchResult,
} from "./types.js";

/**
 * Stage 1 — plan-queries.
 * Turns a free-form topic into a small set of search queries using the model
 * adapter's `generateObject` (Zod-validated structured output).
 */
export const planStage = defineStage<ResearchInput, PlanOutput>({
  id: "plan-queries",
  description: "Decompose the topic into concrete search queries.",
  inputSchema: ResearchInput,
  outputSchema: PlanOutput,
  permissions: ["network"],
  async run(input, ctx) {
    const plan = await ctx.model.generateObject({
      system:
        "RESEARCH_PLANNER. You decompose a research topic into 3 focused search queries. " +
        "Respond with ONLY JSON of shape { \"queries\": string[] }.",
      input: { topic: input.topic },
      schema: z.object({ queries: z.array(z.string()).min(1) }),
    });
    return { topic: input.topic, queries: plan.queries };
  },
});

/**
 * Stage 2 — gather.
 * Runs each query through the `research.search` tool via the registry exposed
 * on the stage context. Demonstrates tool use from inside a stage.
 */
export const gatherStage = defineStage<PlanOutput, GatherOutput>({
  id: "gather",
  description: "Execute each query against the search tool and collect findings.",
  inputSchema: PlanOutput,
  outputSchema: GatherOutput,
  permissions: ["network"],
  async run(input, ctx) {
    const findings: SearchResult[] = [];
    for (const query of input.queries) {
      const result = await ctx.tools.call<SearchResult>("research.search", { query });
      findings.push(result);
    }
    return { topic: input.topic, findings };
  },
});

/**
 * Stage 3 — synthesize.
 * Collapses the findings into a written report using `generateText`, and
 * surfaces the raw snippets as sources.
 */
export const synthesizeStage = defineStage<GatherOutput, ReportOutput>({
  id: "synthesize",
  description: "Synthesize the findings into a written report.",
  inputSchema: GatherOutput,
  outputSchema: ReportOutput,
  permissions: ["network"],
  async run(input, ctx) {
    const report = await ctx.model.generateText({
      system:
        "RESEARCH_SYNTHESIZER. Write a concise markdown briefing for the given topic " +
        "using the provided findings.",
      input: { topic: input.topic, findings: input.findings },
    });
    const sources = input.findings.flatMap((f) => f.snippets);
    return { topic: input.topic, report, sources };
  },
});
