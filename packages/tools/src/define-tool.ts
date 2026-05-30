import type { z } from "zod";
import type { Permission, ToolRisk } from "@slad/shared";
import type { ToolContext } from "./context.js";

// ─── ToolDef type ────────────────────────────────────────────────────────────

/**
 * A fully-typed tool definition created by `defineTool()`.
 *
 * This is the primitive building block for SLAD agents:
 * - Zod schemas for input/output validation
 * - Granular permission declarations
 * - Risk level + approval flag for harness integration
 * - `run(ctx, input)` receives a rich context
 */
export interface ToolDef<I = unknown, O = unknown> {
  readonly id: string;
  readonly provider?: string;
  readonly permissions: readonly Permission[];
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly risk: ToolRisk;
  readonly requiresApproval: boolean;
  readonly description?: string;
  run(ctx: ToolContext, input: I): Promise<O>;
}

// ─── defineTool() ────────────────────────────────────────────────────────────

export interface DefineToolOptions<I extends z.ZodType, O extends z.ZodType> {
  id: string;
  provider?: string;
  description?: string;
  permissions: Permission[];
  input: I;
  output: O;
  risk: ToolRisk;
  requiresApproval?: boolean;
  run(ctx: ToolContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/**
 * Define a typed, validated, context-aware tool.
 *
 * ```ts
 * export const shellTool = defineTool({
 *   id: "shell.exec",
 *   provider: "local-shell",
 *   permissions: ["process:exec", "workspace:write"],
 *   input: z.object({ command: z.string(), cwd: z.string().optional() }),
 *   output: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
 *   risk: "high",
 *   requiresApproval: true,
 *   async run(ctx, input) {
 *     // ...
 *   },
 * });
 * ```
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  options: DefineToolOptions<I, O>,
): ToolDef<z.infer<I>, z.infer<O>> {
  return {
    id: options.id,
    provider: options.provider,
    description: options.description,
    permissions: Object.freeze([...options.permissions]),
    input: options.input,
    output: options.output,
    risk: options.risk,
    requiresApproval: options.requiresApproval ?? false,
    run: options.run,
  };
}

/** Type guard to check if a value is a ToolDef */
export function isToolDef(value: unknown): value is ToolDef {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "input" in value &&
    "output" in value &&
    "permissions" in value &&
    "run" in value &&
    typeof (value as ToolDef).run === "function"
  );
}
