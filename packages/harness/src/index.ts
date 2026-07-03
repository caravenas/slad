import path from "node:path";
import { AuditLogger } from "./audit.js";
import type { PlanTask, RunOutput, Permission } from "@slad/shared";
import { granularToLegacy } from "@slad/shared";
import { classifyRunOutput, highestLevel } from "./classifier.js";
import type {
  CommandClassification,
  ExecutionHarness,
  HarnessConfig,
  HookVerdict,
  PostTaskHook,
  PreTaskHook,
} from "./types.js";

export async function createHarness(config: HarnessConfig): Promise<ExecutionHarness> {
  const audit = config.auditLog ? new AuditLogger(config.auditLogPath) : null;
  const preHooks = await loadHooks<PreTaskHook>(config.preTaskHooks);
  const postHooks = await loadHooks<PostTaskHook>(config.postTaskHooks);

  return {
    config,

    async beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict> {
      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId,
        taskId: task.id,
        kind: "task_start",
        data: { title: task.title, files: task.files },
      });

      for (const hook of preHooks) {
        const verdict = await hook.execute({
          task,
          sessionId,
          permissionLevel: config.maxPermission,
          sessionPermissions: config.maxPermission,
        });

        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId,
          taskId: task.id,
          kind: "hook_verdict",
          data: { hook: hook.name, verdict },
        });

        if (verdict.action !== "allow") return verdict;
      }

      return { action: "allow" };
    },

    classifyOutput(output: RunOutput): CommandClassification[] {
      return classifyRunOutput(output);
    },

    requiresApproval(classifications: CommandClassification[]): boolean {
      if (config.mode === "off") return false;
      const highest = highestLevel(classifications);
      if (config.mode === "strict") return highest !== "read";
      return highest === "full";
    },

    async afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void> {
      const classifications = classifyRunOutput(output);

      for (const c of classifications) {
        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId: null,
          taskId: task.id,
          kind: "command_classified",
          data: c,
        });
      }

      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId: null,
        taskId: task.id,
        kind: "task_end",
        data: {
          status: output.status,
          durationMs,
          changedFiles: output.changedFiles,
        },
      });

      for (const hook of postHooks) {
        await hook.execute({
          task,
          output,
          classifications,
          durationMs,
          changedFiles: output.changedFiles,
        });
      }
    },

    async flush(): Promise<void> {
      await audit?.flush();
    },

    async assertPermission(permission: Permission): Promise<void> {
      if (config.mode === "off") return;
      const required = granularToLegacy([permission]);
      const max = config.maxPermission;
      const levels = ["read", "workspace", "full"] as const;
      const requiredIdx = levels.indexOf(required);
      const maxIdx = levels.indexOf(max);
      if (requiredIdx > maxIdx) {
        throw new Error(
          `Permission denied: "${permission}" requires harness level "${required}" but maxPermission is "${max}"`,
        );
      }
    },
  };
}

async function loadHooks<T>(paths: string[]): Promise<T[]> {
  const hooks: T[] = [];
  for (const p of paths) {
    try {
      const mod = await import(path.resolve(p));
      hooks.push(mod.default as T);
    } catch (err) {
      console.warn(`Warning: no se pudo cargar hook ${p}: ${(err as Error).message}`);
    }
  }
  return hooks;
}

export type { ExecutionHarness };
export * from "./types.js";
export * from "./classifier.js";
export * from "./approval.js";
export * from "./config.js";
