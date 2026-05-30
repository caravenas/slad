import type { ToolDef } from "./define-tool.js";
import type { ToolContext } from "./context.js";
import { createNoopToolContext } from "./context.js";
import type { ToolDefinition } from "./types.js";
import type { FileSystem, Shell } from "./io.js";
import { granularToLegacy } from "@slad/shared";

// ─── Legacy types (kept for CLI backward compat) ────────────────────────────

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

export interface DefaultRegistryOptions {
  fileSystem?: FileSystem;
  shell?: Shell;
}

// ─── ToolRegistry v2 ─────────────────────────────────────────────────────────

/**
 * Unified tool registry that accepts both:
 * - New `ToolDef` objects (from `defineTool()`)
 * - Legacy `RegisteredTool` objects (backward compat)
 */
export class ToolRegistry {
  private toolDefs = new Map<string, ToolDef>();
  private legacyTools = new Map<string, RegisteredTool>();

  /** Register a new-style ToolDef */
  registerDef(tool: ToolDef): void {
    this.toolDefs.set(tool.id, tool);
  }

  /** Register multiple ToolDefs at once */
  registerDefs(tools: readonly ToolDef[]): void {
    for (const t of tools) this.registerDef(t);
  }

  /** Register a legacy-style RegisteredTool (backward compat) */
  register(tool: RegisteredTool): void {
    this.legacyTools.set(tool.definition.name, tool);
  }

  /** Get a ToolDef by id (new-style tools only) */
  getDef(id: string): ToolDef | undefined {
    return this.toolDefs.get(id);
  }

  /** Get a legacy RegisteredTool by name */
  get(name: string): RegisteredTool | undefined {
    // Check legacy first
    const legacy = this.legacyTools.get(name);
    if (legacy) return legacy;

    // Wrap ToolDef as RegisteredTool for backward compat
    const toolDef = this.toolDefs.get(name);
    if (toolDef) return wrapToolDefAsRegistered(toolDef);

    return undefined;
  }

  /** Call a tool by id with typed input. Returns typed output. */
  async call<T = unknown>(id: string, input: unknown, ctx?: ToolContext): Promise<T> {
    const toolDef = this.toolDefs.get(id);
    if (toolDef) {
      const parsed = toolDef.input.parse(input);
      const result = await toolDef.run(ctx ?? createNoopToolContext(), parsed);
      return toolDef.output.parse(result) as T;
    }

    // Fallback to legacy
    const legacy = this.legacyTools.get(id);
    if (legacy) {
      const output = await legacy.execute(input as Record<string, unknown>, ctx?.workspace.root ?? process.cwd());
      return output as T;
    }

    throw new Error(`Tool not found: ${id}`);
  }

  /** Get all tool definitions (legacy format for model providers) */
  definitions(): ToolDefinition[] {
    const legacyDefs = [...this.legacyTools.values()].map((t) => t.definition);
    const newDefs = [...this.toolDefs.values()].map(toolDefToDefinition);
    return [...legacyDefs, ...newDefs];
  }

  /** Get all ToolDef instances */
  allDefs(): ToolDef[] {
    return [...this.toolDefs.values()];
  }

  has(name: string): boolean {
    return this.toolDefs.has(name) || this.legacyTools.has(name);
  }

  names(): string[] {
    return [...new Set([...this.legacyTools.keys(), ...this.toolDefs.keys()])];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a ToolDef to legacy ToolDefinition (for model provider tool descriptions) */
function toolDefToDefinition(tool: ToolDef): ToolDefinition {
  // Extract parameter info from Zod schema
  const shape = getZodShape(tool.input);
  const parameters = shape
    ? Object.entries(shape).map(([name, schema]) => ({
        name,
        type: inferZodType(schema),
        description: getZodDescription(schema) ?? name,
        required: !isZodOptional(schema),
      }))
    : [];

  return {
    name: tool.id,
    description: tool.description ?? tool.id,
    parameters,
    permissionLevel: granularToLegacy(tool.permissions),
  };
}

/** Wrap a ToolDef as a RegisteredTool for backward compat */
function wrapToolDefAsRegistered(tool: ToolDef): RegisteredTool {
  return {
    definition: toolDefToDefinition(tool),
    execute: async (args: Record<string, unknown>, cwd: string) => {
      const parsed = tool.input.parse(args);
      const ctx = createNoopToolContext(cwd);
      const result = await tool.run(ctx, parsed);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
}

/** Create a registry pre-loaded with ToolDefs */
export function createToolRegistry(tools: readonly ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerDefs(tools);
  return registry;
}

// ─── Zod introspection helpers ───────────────────────────────────────────────

function getZodShape(schema: unknown): Record<string, unknown> | null {
  const s = schema as { _def?: { shape?: () => Record<string, unknown>; typeName?: string } };
  if (s?._def?.typeName === "ZodObject" && typeof s._def.shape === "function") {
    return s._def.shape();
  }
  return null;
}

function inferZodType(schema: unknown): "string" | "number" | "boolean" | "array" {
  const s = schema as { _def?: { typeName?: string; innerType?: unknown } };
  const typeName = s?._def?.typeName;
  if (typeName === "ZodOptional" || typeName === "ZodDefault") return inferZodType(s._def?.innerType);
  if (typeName === "ZodNumber") return "number";
  if (typeName === "ZodBoolean") return "boolean";
  if (typeName === "ZodArray") return "array";
  return "string";
}

function getZodDescription(schema: unknown): string | undefined {
  const s = schema as { _def?: { description?: string; innerType?: unknown; typeName?: string } };
  if (s?._def?.description) return s._def.description;
  if (s?._def?.typeName === "ZodOptional" || s?._def?.typeName === "ZodDefault") {
    return getZodDescription(s._def?.innerType);
  }
  return undefined;
}

function isZodOptional(schema: unknown): boolean {
  const s = schema as { _def?: { typeName?: string; innerType?: unknown } };
  if (s?._def?.typeName === "ZodOptional") return true;
  if (s?._def?.typeName === "ZodDefault") return true;
  return false;
}
