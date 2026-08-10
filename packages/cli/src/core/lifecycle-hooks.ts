import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LifecycleHooksSettings,
  LifecyclePreHookResult,
  type LifecycleHooksSettings as LifecycleHooksSettingsType,
} from "@slad/shared";
import { settingsValue } from "./config.js";
import { SladError } from "./errors.js";
import { log } from "./logger.js";
import type { PlanOutput, PlanTask, RunOutput } from "./types.js";

type LifecyclePreEvent = "pre-plan" | "pre-run" | "pre-apply";
type LifecyclePostEvent = "post-task" | "post-run" | "post-apply";

type BaseContext = {
  cwd: string;
  event: LifecyclePreEvent | LifecyclePostEvent;
};

export type LifecycleHookContext =
  | (BaseContext & { event: "pre-plan"; command: "plan"; input?: string; importPath?: string; sessionId?: string; intent?: string })
  | (BaseContext & { event: "pre-run"; command: "run"; sessionId: string; intent: string; plan: PlanOutput })
  | (BaseContext & { event: "post-task"; command: "run"; sessionId: string; task: PlanTask; output: RunOutput })
  | (BaseContext & { event: "post-run"; command: "run"; sessionId: string; status: string })
  | (BaseContext & { event: "pre-apply"; command: "apply"; runId: string; integration: { branch: string; baseRef: string; tip: string } })
  | (BaseContext & { event: "post-apply"; command: "apply"; runId: string; status: "applied" });

type LifecycleHook = (context: LifecycleHookContext) => unknown | Promise<unknown>;

const HOOK_KEYS = {
  "pre-plan": "prePlan",
  "pre-run": "preRun",
  "post-task": "postTask",
  "post-run": "postRun",
  "pre-apply": "preApply",
  "post-apply": "postApply",
} as const;

export class LifecycleHookError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "LIFECYCLE_HOOK_ERROR", context);
    this.name = "LifecycleHookError";
  }
}

export function loadLifecycleHooks(cwd = process.cwd()): LifecycleHooksSettingsType {
  return LifecycleHooksSettings.parse(settingsValue(["lifecycleHooks"], cwd) ?? {});
}

function readonlyClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function hookPath(spec: string, cwd: string): string {
  if (/^[a-z]+:/i.test(spec)) {
    throw new LifecycleHookError(`Lifecycle hook must be a local file path: ${spec}`, { hook: spec });
  }
  return path.resolve(cwd, spec);
}

async function loadHook(spec: string, cwd: string): Promise<LifecycleHook> {
  const modulePath = hookPath(spec, cwd);
  const mod = await import(pathToFileURL(modulePath).href);
  const hook = (mod.default ?? mod.hook) as unknown;
  if (typeof hook !== "function") {
    throw new LifecycleHookError(`Lifecycle hook ${spec} must export default or hook function.`, { hook: spec });
  }
  return hook as LifecycleHook;
}

export async function runPreLifecycleHooks(
  hooks: LifecycleHooksSettingsType,
  event: LifecyclePreEvent,
  context: Extract<LifecycleHookContext, { event: LifecyclePreEvent }>,
): Promise<void> {
  for (const spec of hooks[HOOK_KEYS[event]]) {
    let result: unknown;
    try {
      result = await (await loadHook(spec, context.cwd))(readonlyClone(context));
    } catch (error) {
      if (error instanceof LifecycleHookError) throw error;
      throw new LifecycleHookError(`Lifecycle hook ${spec} failed before ${event}.`, {
        event,
        hook: spec,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const decision = LifecyclePreHookResult.parse(result ?? { allow: true });
    if (!decision.allow) {
      throw new LifecycleHookError(`Lifecycle hook denied ${event}: ${decision.reason}`, {
        event,
        hook: spec,
        note: decision.note,
      });
    }
  }
}

export async function runPostLifecycleHooks(
  hooks: LifecycleHooksSettingsType,
  event: LifecyclePostEvent,
  context: Extract<LifecycleHookContext, { event: LifecyclePostEvent }>,
): Promise<void> {
  for (const spec of hooks[HOOK_KEYS[event]]) {
    try {
      await (await loadHook(spec, context.cwd))(readonlyClone(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Lifecycle hook ${spec} failed after ${event}: ${message}`);
    }
  }
}
