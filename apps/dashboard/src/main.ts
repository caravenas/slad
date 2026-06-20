import { z } from "zod";
import {
  defineStage,
  definePipeline,
  runPipeline,
  PIPELINE_EVENTS,
  type PipelineRunResult,
} from "@slad/pipeline";

/**
 * SLAD dashboard (app). Demonstrates Principle 3: the pipeline runtime runs from a
 * non-CLI host. This app consumes `@slad/pipeline` directly — it does NOT
 * re-implement the runtime — to execute a run and render a runs/traces summary,
 * keyed off the canonical `PIPELINE_EVENTS` vocabulary.
 *
 * A production dashboard would read persisted runs/traces; here we execute a demo
 * pipeline inline so the app is runnable offline.
 */

const ingest = defineStage<{ source: string }, { items: number }>({
  id: "ingest",
  inputSchema: z.object({ source: z.string() }),
  outputSchema: z.object({ items: z.number() }),
  async run(input) {
    return { items: input.source.length };
  },
});

const transform = defineStage<{ items: number }, { processed: number }>({
  id: "transform",
  inputSchema: z.object({ items: z.number() }),
  outputSchema: z.object({ processed: z.number() }),
  async run(input) {
    return { processed: input.items * 2 };
  },
});

const pipeline = definePipeline({
  id: "demo-runs",
  version: "0.1.0",
  stages: [ingest, transform],
  services: {},
});

function renderDashboard(result: PipelineRunResult): void {
  const badge =
    result.status === "completed" ? "🟢" : result.status === "failed" ? "🔴" : "🟡";

  console.log("\n┌─ SLAD runs dashboard ─────────────────────────────");
  console.log(`│ pipeline  ${result.pipelineId}`);
  console.log(`│ run       ${result.runId}`);
  console.log(`│ status    ${badge} ${result.status}  (${result.durationMs}ms)`);
  console.log("├─ stages ──────────────────────────────────────────");
  for (const stage of result.stages) {
    const mark = stage.status === "completed" ? "✓" : stage.status === "failed" ? "✗" : "•";
    console.log(
      `│ ${mark} ${stage.stageId.padEnd(14)} ${stage.status.padEnd(10)} ${stage.durationMs}ms`,
    );
  }
  console.log("└───────────────────────────────────────────────────");

  console.log("\nSubscribed event vocabulary (PIPELINE_EVENTS):");
  for (const name of Object.values(PIPELINE_EVENTS)) console.log(`  · ${name}`);
}

const result = await runPipeline<{ source: string }, { processed: number }>({
  ...pipeline,
  input: { source: "events.log" },
});

renderDashboard(result);
