export type ToolParameterType = "string"|"number"|"boolean"|"array";
export interface ToolParameter { name:string; type: ToolParameterType; description:string; required?: boolean; enum?: string[] }
export interface ToolDefinition { name:string; description:string; parameters: ToolParameter[]; permissionLevel?: unknown }
export interface ToolCall { id:string; name:string; arguments: Record<string, unknown> }
export interface ToolResult { toolCallId:string; success:boolean; output:string; error?:string }
export interface ProviderToolResponse { type:"tool_use"; toolCalls: ToolCall[]; textParts: string[] }
export interface ProviderTextResponse { type:"text"; content:string }
export type ProviderResponse = ProviderToolResponse | ProviderTextResponse;
export interface ToolExecutorLike { execute(call: ToolCall): Promise<ToolResult> }
export interface ScratchpadLike { processResult(call: ToolCall, result: ToolResult, round: number): string }
