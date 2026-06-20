import { z } from "zod";
import { defineTool } from "@slad/tools";

/**
 * A mock, offline "search" tool. In a real agent this would call an HTTP
 * search API or an MCP server; here it returns deterministic snippets so the
 * example runs end-to-end without network or API keys.
 *
 * Built with the public `defineTool` primitive: id, granular permissions,
 * Zod-validated input/output, risk level.
 */
export const searchTool = defineTool({
  id: "research.search",
  provider: "mock-search",
  description: "Search a knowledge source for a query (mock, offline, deterministic).",
  permissions: ["network:read"],
  input: z.object({ query: z.string().min(1) }),
  output: z.object({
    query: z.string(),
    snippets: z.array(z.string()),
  }),
  risk: "low",
  async run(_ctx, input) {
    return {
      query: input.query,
      snippets: [
        `[mock] Primary finding for "${input.query}".`,
        `[mock] Secondary finding for "${input.query}".`,
      ],
    };
  },
});
