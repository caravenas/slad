import type { ChatMessage, CompletionOptions, ProviderName } from "./types.js";
import type { ToolDefinition, ProviderResponse } from "./tool-types.js";

export type { ModelAdapter, GenerateObjectOptions, GenerateTextOptions } from "./adapter.js";
export { createModelAdapter, createNoopModelAdapter } from "./adapter.js";

export type {
  ChatMessage,
  CompletionOptions,
  ProviderName,
} from "./types.js";
export type {
  ProviderResponse,
  ToolCall,
  ToolDefinition,
  ToolParameter,
  ToolParameterType,
  ToolResult,
} from "./tool-types.js";
export { ProviderError, isRetryable } from "./errors.js";
export { retryWithBackoff } from "./retry.js";
export { withTimeout, resolveApiTimeoutMs } from "./timeout.js";
export { CliProvider, launchSpecFromEnv, runCli } from "./cli.js";
export type { LaunchSpecOptions, RunCliOptions } from "./cli.js";

export interface ToolUseOptions extends CompletionOptions {
  tools: ToolDefinition[];
}

/**
 * Minimal contract every provider must satisfy.
 * This is the seam that isolates consumers from vendor SDKs.
 */
export interface ModelProvider {
  readonly name: ProviderName;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
  stream?(messages: ChatMessage[], opts?: CompletionOptions): AsyncGenerator<string>;
  completeWithTools?(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse>;
  supportsToolUse?: boolean;
}

export async function getProvider(name: ProviderName): Promise<ModelProvider> {
  switch (name) {
    case "cli": {
      const { CliProvider } = await import("./cli.js");
      return new CliProvider();
    }
    default:
      throw new Error(`Provider no soportado: ${String(name)}`);
  }
}
