import OpenAI from "openai";
import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "./types.js";
import type { ProviderResponse, ToolCall } from "./tool-types.js";
import { ProviderError } from "./errors.js";
import { retryWithBackoff } from "./retry.js";
import { withTimeout, resolveApiTimeoutMs } from "./timeout.js";
import { log } from "./logger.js";

const DEFAULT_MODEL = "gpt-4o";

export class OpenAIProvider implements ModelProvider {
  readonly name: ProviderName = "openai";
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    const withSystem: ChatMessage[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages.filter((m) => m.role !== "system")]
      : messages;

    const baseParams = {
      model: opts.model ?? DEFAULT_MODEL,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      messages: withSystem.map((m) => ({ role: m.role, content: m.content })),
    } as const;

    if (opts.onChunk) {
      const stream = await this.client.chat.completions.create({ ...baseParams, stream: true });
      let fullText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          opts.onChunk(delta);
          fullText += delta;
        }
      }
      return fullText.trim();
    }

    const timeoutMs = resolveApiTimeoutMs();
    const res = await retryWithBackoff(async () => {
      try {
        return await withTimeout(
          this.client.chat.completions.create(baseParams),
          timeoutMs,
          "openai",
        );
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const apiErr = err as { status?: number; message?: string };
        const retryable = apiErr.status === 429 || apiErr.status === 500;
        throw new ProviderError(
          apiErr.message ?? "OpenAI API error",
          "openai",
          { statusCode: apiErr.status, retryable, cause: err as Error },
        );
      }
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      onRetry: (_err, attempt, delayMs) => {
        log.debug(`openai: reintento ${attempt}/3 en ${delayMs}ms`);
      },
    });

    opts.onUsage?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);

    const text = res.choices[0]?.message?.content ?? "";
    return text.trim();
  }

  async completeWithTools(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse> {
    const withSystem: ChatMessage[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages.filter((m) => m.role !== "system")]
      : messages;

    // Convert ToolDefinition[] to OpenAI tools format
    const tools = opts.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              {
                type: p.type,
                description: p.description,
                ...(p.enum ? { enum: p.enum } : {}),
              },
            ]),
          ),
          required: t.parameters.filter((p) => p.required !== false).map((p) => p.name),
        },
      },
    }));

    const timeoutMs = resolveApiTimeoutMs();
    const res = await retryWithBackoff(async () => {
      try {
        return await withTimeout(
          this.client.chat.completions.create({
            model: opts.model ?? DEFAULT_MODEL,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 4096,
            messages: withSystem.map((m) => ({ role: m.role, content: m.content })),
            tools,
          }),
          timeoutMs,
          "openai",
        );
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const apiErr = err as { status?: number; message?: string };
        const retryable = apiErr.status === 429 || apiErr.status === 500;
        throw new ProviderError(
          apiErr.message ?? "OpenAI API error",
          "openai",
          { statusCode: apiErr.status, retryable, cause: err as Error },
        );
      }
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      onRetry: (_err, attempt, delayMs) => {
        log.debug(`openai: reintento ${attempt}/3 en ${delayMs}ms`);
      },
    });

    // Report token usage if callback provided
    opts.onUsage?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);

    const choice = res.choices[0];
    if (choice?.message?.tool_calls?.length) {
      const toolCalls: ToolCall[] = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
      return {
        type: "tool_use",
        toolCalls,
        textParts: choice.message.content ? [choice.message.content] : [],
      };
    }
    return { type: "text", content: choice?.message?.content?.trim() ?? "" };
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<string> {
    const withSystem: ChatMessage[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages.filter((m) => m.role !== "system")]
      : messages;

    const streamResult = await this.client.chat.completions.create({
      model: opts.model ?? DEFAULT_MODEL,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      messages: withSystem.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    for await (const chunk of streamResult) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) yield delta;
    }
  }

  get supportsToolUse(): boolean {
    return true;
  }
}
