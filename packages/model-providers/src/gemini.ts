import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "./types.js";
import { ProviderError } from "./errors.js";
import { retryWithBackoff } from "./retry.js";
import { withTimeout, resolveApiTimeoutMs } from "./timeout.js";
import { log } from "./logger.js";

const DEFAULT_MODEL = "gemini-1.5-pro";

export class GeminiProvider implements ModelProvider {
  readonly name: ProviderName = "gemini";
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    // Gemini expects a separate systemInstruction and user/model turns.
    const systemFromMessages = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemInstruction = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const model = this.client.getGenerativeModel({
      model: opts.model ?? DEFAULT_MODEL,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    });

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    if (opts.onChunk) {
      const streamResult = await model.generateContentStream({ contents });
      let fullText = "";
      for await (const chunk of streamResult.stream) {
        const text = chunk.text();
        if (text) {
          opts.onChunk(text);
          fullText += text;
        }
      }
      return fullText.trim();
    }

    const timeoutMs = resolveApiTimeoutMs();
    return await retryWithBackoff(async () => {
      try {
        const res = await withTimeout(
          model.generateContent({ contents }),
          timeoutMs,
          "gemini",
        );
        return res.response.text().trim();
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const apiErr = err as { status?: number; message?: string };
        const retryable = apiErr.status === 429 || apiErr.status === 500;
        throw new ProviderError(
          apiErr.message ?? "Gemini API error",
          "gemini",
          { statusCode: apiErr.status, retryable, cause: err as Error },
        );
      }
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      onRetry: (_err, attempt, delayMs) => {
        log.debug(`gemini: reintento ${attempt}/3 en ${delayMs}ms`);
      },
    });
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<string> {
    const systemFromMessages = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemInstruction = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const model = this.client.getGenerativeModel({
      model: opts.model ?? DEFAULT_MODEL,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    });

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const streamResult = await model.generateContentStream({ contents });
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }
}
