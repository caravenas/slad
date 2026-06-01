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
export { AnthropicProvider } from "./anthropic.js";
export { OpenAIProvider } from "./openai.js";
export { GeminiProvider } from "./gemini.js";

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

export async function getProvider(name: ProviderName, apiKey?: string): Promise<ModelProvider> {
  switch (name) {
    case "anthropic": {
      if (!apiKey) throw new Error("Anthropic provider requiere ANTHROPIC_API_KEY.");
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider(apiKey);
    }
    case "openai": {
      if (!apiKey) throw new Error("OpenAI provider requiere OPENAI_API_KEY.");
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider(apiKey);
    }
    case "gemini": {
      if (!apiKey) throw new Error("Gemini provider requiere GEMINI_API_KEY o GOOGLE_API_KEY.");
      const { GeminiProvider } = await import("./gemini.js");
      return new GeminiProvider(apiKey);
    }
    case "cli":
      throw new Error('El provider "cli" permanece en @slad/cli y no forma parte de @slad/model-providers.');
    default:
      throw new Error(`Provider no soportado: ${String(name)}`);
  }
}
