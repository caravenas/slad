import type { ChatMessage, ProviderName } from "@slad/shared";

export type { ChatMessage, ProviderName };

export type CompletionOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  onChunk?: (text: string) => void;
};
