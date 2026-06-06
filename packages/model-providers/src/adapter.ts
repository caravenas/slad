import type { z } from "zod";
import type { ModelProvider } from "./index.js";
import type { CompletionOptions } from "./types.js";

// ─── ModelAdapter interface ──────────────────────────────────────────────────

export interface GenerateObjectOptions<T> {
  schema: z.ZodType<T>;
  system: string;
  /** Single-turn input (converted to a user message) */
  input?: unknown;
  /** Multi-turn conversation messages. Takes precedence over `input` if both provided. */
  messages?: import("./types.js").ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

export interface GenerateTextOptions {
  system: string;
  input: unknown;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelAdapter {
  /** Generate a structured object validated against a Zod schema */
  generateObject<T>(opts: GenerateObjectOptions<T>): Promise<T>;
  /** Generate free-form text */
  generateText(opts: GenerateTextOptions): Promise<string>;
  /** Access the underlying provider for advanced use */
  readonly provider: ModelProvider;
}

// ─── JSON auto-fix pipeline ─────────────────────────────────────────────────

/** Strip markdown code fences from model output */
function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : raw;
}

/** Extract the outermost JSON object or array from a string */
function extractJsonBody(raw: string): string {
  const body = stripFences(raw);

  // Try object
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return body.slice(firstBrace, lastBrace + 1);
  }

  // Try array
  const firstBracket = body.indexOf("[");
  const lastBracket = body.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return body.slice(firstBracket, lastBracket + 1);
  }

  return body.trim();
}

/**
 * Escape raw control characters (< 0x20) inside JSON string literals.
 * The model sometimes emits literal newlines in string fields; JSON.parse rejects those.
 */
function escapeControlCharsInStrings(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    const code = raw.charCodeAt(i);
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\") {
      result += char;
      escaped = true;
    } else if (char === '"') {
      result += char;
      inString = !inString;
    } else if (inString && code < 0x20) {
      switch (char) {
        case "\n": result += "\\n"; break;
        case "\r": result += "\\r"; break;
        case "\t": result += "\\t"; break;
        default: result += `\\u${code.toString(16).padStart(4, "0")}`; break;
      }
    } else {
      result += char;
    }
  }
  return result;
}

/** Fix common JSON issues: trailing commas, unescaped control chars in strings. */
function fixJsonString(raw: string): string {
  let fixed = raw;
  // Escape raw control characters inside string literals before any other fix
  fixed = escapeControlCharsInStrings(fixed);
  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  // Remove JS-style comments
  fixed = fixed.replace(/\/\/[^\n]*/g, "");
  return fixed;
}

/** Full auto-fix pipeline: fences → extract → fix → parse */
function autoFixParse<T>(raw: string, schema: z.ZodType<T>): { success: true; data: T } | { success: false; error: string } {
  try {
    const extracted = extractJsonBody(raw);
    const fixed = fixJsonString(extracted);
    const parsed = JSON.parse(fixed);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: `Zod validation failed: ${result.error.message}` };
  } catch (err) {
    return { success: false, error: `JSON parse failed: ${(err as Error).message}` };
  }
}

// ─── ModelAdapter implementation ─────────────────────────────────────────────

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

export function createModelAdapter(provider: ModelProvider, defaults?: Partial<CompletionOptions>): ModelAdapter {
  return {
    provider,

    async generateObject<T>(opts: GenerateObjectOptions<T>): Promise<T> {
      const maxRetries = opts.maxRetries ?? 2;
      const completionOpts: CompletionOptions = {
        systemPrompt: opts.system,
        temperature: opts.temperature ?? defaults?.temperature ?? 0.3,
        maxTokens: opts.maxTokens ?? defaults?.maxTokens ?? 4096,
      };

      const baseMessages = opts.messages ?? [{ role: "user" as const, content: formatInput(opts.input) }];
      let lastError = "";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const raw = await provider.complete(
          attempt === 0
            ? baseMessages
            : [
                ...baseMessages,
                { role: "assistant" as const, content: `(previous attempt failed: ${lastError})` },
                {
                  role: "user" as const,
                  content: `Your previous response could not be parsed. Please respond with ONLY valid JSON matching the expected schema. Error: ${lastError}`,
                },
              ],
          completionOpts,
        );

        const result = autoFixParse(raw, opts.schema);
        if (result.success) {
          return result.data;
        }

        lastError = result.error;
      }

      throw new Error(`generateObject failed after ${maxRetries + 1} attempts. Last error: ${lastError}`);
    },

    async generateText(opts: GenerateTextOptions): Promise<string> {
      const completionOpts: CompletionOptions = {
        systemPrompt: opts.system,
        temperature: opts.temperature ?? defaults?.temperature ?? 0.5,
        maxTokens: opts.maxTokens ?? defaults?.maxTokens ?? 4096,
      };

      return provider.complete(
        [{ role: "user" as const, content: formatInput(opts.input) }],
        completionOpts,
      );
    },
  };
}

// ─── NoopModelAdapter ────────────────────────────────────────────────────────

export function createNoopModelAdapter(): ModelAdapter {
  const noProvider: ModelProvider = {
    name: "anthropic" as never,
    complete: () => { throw new Error("No model provider configured for this pipeline"); },
  };
  return {
    provider: noProvider,
    generateObject: () => { throw new Error("No model provider configured for this pipeline"); },
    generateText: () => { throw new Error("No model provider configured for this pipeline"); },
  };
}

// ─── Exported for testing ────────────────────────────────────────────────────

export { extractJsonBody as _extractJsonBody, fixJsonString as _fixJsonString, autoFixParse as _autoFixParse };
