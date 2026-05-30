import type { Permission } from "@slad/shared";

// ─── ToolContext ─────────────────────────────────────────────────────────────

export interface ToolCallFn {
  <T = unknown>(toolId: string, input: unknown): Promise<T>;
}

export interface AuditEmitter {
  emit(event: string, data: Record<string, unknown>): void;
}

export interface HarnessAssert {
  assertPermission(permission: Permission): Promise<void>;
}

export interface WorkspaceInfo {
  readonly root: string;
}

/**
 * Context injected into tool `run()` functions.
 * Provides access to other tools, audit trail, harness checks, and workspace info.
 */
export interface ToolContext {
  /** Call another tool by id */
  readonly tools: { call: ToolCallFn };
  /** Emit audit events */
  readonly audit: AuditEmitter;
  /** Check permissions at runtime */
  readonly harness: HarnessAssert;
  /** Workspace root and metadata */
  readonly workspace: WorkspaceInfo;
}

/**
 * Minimal noop context for running tools outside a pipeline.
 * Useful for tests and standalone tool usage.
 */
export function createNoopToolContext(workspaceRoot = process.cwd()): ToolContext {
  return {
    tools: {
      call: async () => { throw new Error("No tool registry available in noop context"); },
    },
    audit: {
      emit: () => {},
    },
    harness: {
      assertPermission: async () => {},
    },
    workspace: { root: workspaceRoot },
  };
}
