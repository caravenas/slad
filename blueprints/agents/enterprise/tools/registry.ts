import type { ToolDef } from "@slad/tools";

/**
 * Central tool registry for "{{name}}".
 * Add tool definitions (from ./definitions or ./mcp) to this array; the runtime
 * passes them to `createAgent({ tools })`.
 */
export const tools: ToolDef[] = [
  // import { myTool } from "./definitions/my-tool.js";
  // myTool,
];
