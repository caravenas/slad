import { buildResearchAgent } from "./agent.js";

/**
 * End-to-end entrypoint. Run with: `pnpm --filter research-agent start`.
 * Uses the mock provider, so it works offline with no API keys.
 */
const topic = process.argv.slice(2).join(" ").trim() || "agentic developer tooling";

const agent = await buildResearchAgent();

const result = await agent.run(
  { topic },
  {
    onStageStart: (stage) => console.log(`▶ ${stage}`),
    onStageComplete: (stage) => console.log(`✓ ${stage}`),
  },
);

console.log("\n─── status:", result.status, `(${result.durationMs}ms) ───\n`);
if (result.output) {
  console.log(result.output.report);
  console.log("\nSources:");
  for (const source of result.output.sources) console.log(`  - ${source}`);
} else {
  console.error("Pipeline produced no output.");
  process.exitCode = 1;
}
