import { z } from "zod";
import type { PlanTask, RunOutput, Permission } from "@slad/shared";

export type { PlanTask, RunOutput } from "@slad/shared";

export const PermissionLevel = z.enum(["read", "workspace", "full"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const CommandClassification = z.object({
  original: z.string(),
  level: PermissionLevel,
  reason: z.string(),
  patterns: z.array(z.string()).default([]),
});
export type CommandClassification = z.infer<typeof CommandClassification>;

export type HookVerdict =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; patch: Partial<PlanTask> };

export interface PreTaskContext {
  task: PlanTask;
  sessionId: string | null;
  permissionLevel: PermissionLevel;
  sessionPermissions: PermissionLevel;
}

export interface PostTaskContext {
  task: PlanTask;
  output: RunOutput;
  classifications: CommandClassification[];
  durationMs: number;
  changedFiles: string[];
}

export interface PreTaskHook {
  name: string;
  execute(ctx: PreTaskContext): Promise<HookVerdict>;
}

export interface PostTaskHook {
  name: string;
  execute(ctx: PostTaskContext): Promise<void>;
}

export interface ApprovalRequest {
  taskId: string;
  dangerous: CommandClassification[];
  classifications: CommandClassification[];
}

export interface ApprovalIO {
  canAsk(): boolean;
  confirm(request: ApprovalRequest): Promise<boolean>;
}

export const HarnessMode = z.enum(["off", "on", "strict"]);
export type HarnessMode = z.infer<typeof HarnessMode>;

export const HarnessConfig = z.object({
  mode: HarnessMode.default("off"),
  maxPermission: PermissionLevel.default("workspace"),
  alwaysApprove: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "shutdown",
    "DROP TABLE",
    "git push --force",
    "npm publish",
  ]),
  allowedWritePaths: z.array(z.string()).default(["./src", "./tests", "./docs"]),
  auditLog: z.boolean().default(true),
  auditLogPath: z.string().default(".slad-os/audit.ldjson"),
  preTaskHooks: z.array(z.string()).default([]),
  postTaskHooks: z.array(z.string()).default([]),
  approvalIO: z.custom<ApprovalIO>().optional(),
});
export type HarnessConfig = z.infer<typeof HarnessConfig>;

export interface ExecutionHarness {
  readonly config: HarnessConfig;
  beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict>;
  classifyOutput(output: RunOutput): CommandClassification[];
  requiresApproval(classifications: CommandClassification[]): boolean;
  afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void>;
  flush(): Promise<void>;
  /** Check if a granular permission is allowed given this harness's maxPermission. Throws if denied. */
  assertPermission(permission: Permission): Promise<void>;
}
