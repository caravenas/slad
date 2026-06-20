import { z } from "zod";

/** Public input contract for the research agent. */
export const ResearchInput = z.object({
  topic: z.string().min(1),
});
export type ResearchInput = z.infer<typeof ResearchInput>;

/** Output of the `plan-queries` stage. */
export const PlanOutput = z.object({
  topic: z.string(),
  queries: z.array(z.string()).min(1),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

/** A single search result returned by the `research.search` tool. */
export const SearchResult = z.object({
  query: z.string(),
  snippets: z.array(z.string()),
});
export type SearchResult = z.infer<typeof SearchResult>;

/** Output of the `gather` stage. */
export const GatherOutput = z.object({
  topic: z.string(),
  findings: z.array(SearchResult),
});
export type GatherOutput = z.infer<typeof GatherOutput>;

/** Final output contract for the research agent. */
export const ReportOutput = z.object({
  topic: z.string(),
  report: z.string(),
  sources: z.array(z.string()),
});
export type ReportOutput = z.infer<typeof ReportOutput>;
