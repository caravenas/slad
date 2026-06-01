import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "./types.js";
import type { ProviderResponse, ToolCall } from "./tool-types.js";
import { ProviderError } from "./errors.js";
import { retryWithBackoff } from "./retry.js";
import { withTimeout, resolveApiTimeoutMs } from "./timeout.js";
import { log } from "./logger.js";

const DEFAULT_MODEL = "MiniMax-M2.7";

export class AnthropicProvider implements ModelProvider {
  readonly name: ProviderName = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    // Anthropic takes `system` separately from the message list.
    const systemFromMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const system = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const chat = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const params = {
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.4,
      ...(system ? { system } : {}),
      messages: chat,
    } as const;

    if (opts.onChunk) {
      const stream = this.client.messages.stream(params);
      let fullText = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          opts.onChunk(event.delta.text);
          fullText += event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      opts.onUsage?.(final.usage.input_tokens, final.usage.output_tokens);
      return fullText.trim();
    }

    const timeoutMs = resolveApiTimeoutMs();
    const res = await retryWithBackoff(async () => {
      try {
        return await withTimeout(
          this.client.messages.create(params),
          timeoutMs,
          "anthropic",
        );
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const apiErr = err as { status?: number; message?: string };
        const retryable = apiErr.status === 429 || apiErr.status === 529 || apiErr.status === 500;
        throw new ProviderError(
          apiErr.message ?? "Anthropic API error",
          "anthropic",
          { statusCode: apiErr.status, retryable, cause: err as Error },
        );
      }
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      onRetry: (_err, attempt, delayMs) => {
        log.debug(`anthropic: reintento ${attempt}/3 en ${delayMs}ms`);
      },
    });

    opts.onUsage?.(res.usage.input_tokens, res.usage.output_tokens);

    const text = res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return text.trim();
  }

  async completeWithTools(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse> {
    const timeoutMs = resolveApiTimeoutMs();
    const systemFromMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const system = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const chat = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Convert ToolDefinition[] to Anthropic tools format
    const tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
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
    }));

    const res = await retryWithBackoff(async () => {
      try {
        return await withTimeout(
          this.client.messages.create({
            model: opts.model ?? DEFAULT_MODEL,
            max_tokens: opts.maxTokens ?? 4096,
            temperature: opts.temperature ?? 0.2,
            ...(system ? { system } : {}),
            messages: chat,
            tools,
          }),
          timeoutMs,
          "anthropic",
        );
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const apiErr = err as { status?: number; message?: string };
        const retryable = apiErr.status === 429 || apiErr.status === 529 || apiErr.status === 500;
        throw new ProviderError(
          apiErr.message ?? "Anthropic API error",
          "anthropic",
          { statusCode: apiErr.status, retryable, cause: err as Error },
        );
      }
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      onRetry: (_err, attempt, delayMs) => {
        log.debug(`anthropic: reintento ${attempt}/3 en ${delayMs}ms`);
      },
    });

    // Report token usage if callback provided
    opts.onUsage?.(res.usage.input_tokens, res.usage.output_tokens);

    // Parse response: may be text, tool_use, or a mix
    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];

    for (const block of res.content) {
      if (block.type === "text") textParts.push(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    if (toolCalls.length > 0) {
      return { type: "tool_use", toolCalls, textParts };
    }
    return { type: "text", content: textParts.join("\n").trim() };
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<string> {
    const systemFromMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const system = opts.systemPrompt ?? systemFromMessages ?? undefined;
    const chat = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const streamResult = this.client.messages.stream({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.4,
      ...(system ? { system } : {}),
      messages: chat,
    });

    for await (const event of streamResult) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }

    const final = await streamResult.finalMessage();
    opts.onUsage?.(final.usage.input_tokens, final.usage.output_tokens);
  }

  get supportsToolUse(): boolean {
    return true;
  }
}
