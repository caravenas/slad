import { createAgent, type Agent } from "@slad/pipeline";
import { createHarness, HarnessConfig } from "@slad/harness";
import { researchPipeline } from "./pipeline.js";
import { createMockResearchProvider } from "./mock-provider.js";
import { searchTool } from "./tools.js";
import type { ReportOutput, ResearchInput } from "./types.js";

/**
 * Assemble the research agent from public SDK primitives:
 *   model provider + tools + safety harness + pipeline → createAgent.
 *
 * The harness is wired here as an opt-in safety layer (mode "off" so the
 * offline example never blocks; audit logging disabled to avoid disk writes).
 */
export async function buildResearchAgent(): Promise<Agent<ResearchInput, ReportOutput>> {
  const model = createMockResearchProvider();
  const safety = await createHarness(
    HarnessConfig.parse({ mode: "off", auditLog: false }),
  );

  return createAgent<ResearchInput, ReportOutput>({
    id: "research-agent",
    model,
    tools: [searchTool],
    safety,
    pipeline: researchPipeline,
  });
}
