import { z } from "zod";

export const PermissionLevel = z.enum(["read", "workspace", "full"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const CommandClassification = z.object({
  original: z.string(),
  level: PermissionLevel,
  reason: z.string(),
  patterns: z.array(z.string()).default([]),
});
export type CommandClassification = z.infer<typeof CommandClassification>;

export const ToolParameterType = z.enum(["string", "number", "boolean", "array"]);
export type ToolParameterType = z.infer<typeof ToolParameterType>;
export const ToolParameter = z.object({
  name: z.string(),
  type: ToolParameterType,
  description: z.string(),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
});
export type ToolParameter = z.infer<typeof ToolParameter>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(ToolParameter),
  permissionLevel: PermissionLevel,
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolCall = z.object({ id: z.string(), name: z.string(), arguments: z.record(z.unknown()) });
export type ToolCall = z.infer<typeof ToolCall>;
export const ToolResult = z.object({ toolCallId: z.string(), success: z.boolean(), output: z.string(), error: z.string().optional() });
export type ToolResult = z.infer<typeof ToolResult>;

export interface ProviderToolResponse { type: "tool_use"; toolCalls: ToolCall[]; textParts: string[]; }
export interface ProviderTextResponse { type: "text"; content: string; }
export type ProviderResponse = ProviderToolResponse | ProviderTextResponse;

export interface ShellExecOptions { cwd?: string; timeoutMs?: number; maxBuffer?: number; }
export interface ShellResult { stdout: string; stderr: string; exitCode: number; }
export interface Shell { exec(command: string, options?: ShellExecOptions): Promise<ShellResult>; }
export interface DirectoryEntry { path: string; isDirectory: boolean; }
export interface FileSystem {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listDir(relativePath: string, options?: { recursive?: boolean; maxDepth?: number }): Promise<DirectoryEntry[]>;
}
export interface ApprovalGate { requiresApproval(classifications: CommandClassification[]): boolean; }
export interface ApprovalIO { requestApproval(request: { taskId: string; classifications: CommandClassification[] }): Promise<boolean>; }
