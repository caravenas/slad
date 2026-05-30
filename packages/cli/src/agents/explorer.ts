import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelProvider } from "@slad/model-providers";
import { EXPLORER_SYSTEM } from "./prompts.js";
import { withPromptGuidance } from "../core/config.js";
import { ExploreOutput, type ChatMessage } from "../core/types.js";
import { hashStructured, readOrCreateReusableValue } from "@slad/cache";

export interface ExploreInput {
  intent: string;
  wikiPath?: string;
  model?: string;
}

/**
 * Best-effort JSON extraction: strips ```json fences and anything outside the
 * outermost braces. Some providers (especially Gemini) ignore the "no markdown"
 * rule even when asked nicely.
 */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

/**
 * If the user has a wiki, include the index.md as lightweight context so the
 * Explorer can make references ("similar to X project we already documented").
 * We intentionally keep this small — we're not doing full RAG here.
 */
export function readWikiContext(wikiPath: string | undefined): string | null {
  if (!wikiPath) return null;
  const indexFile = path.join(wikiPath, "index.md");
  if (!fs.existsSync(indexFile)) return null;
  try {
    const text = fs.readFileSync(indexFile, "utf8");
    // Cap at ~6k chars to keep prompts lean.
    return text.slice(0, 6000);
  } catch {
    return null;
  }
}

export async function readWikiContextCached(
  wikiPath: string | undefined,
  options?: { cwd?: string; cacheRootDir?: string },
): Promise<{ text: string | null; cacheStatus: "hit" | "miss" }> {
  if (!wikiPath) {
    return { text: null, cacheStatus: "miss" };
  }

  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const indexFile = path.join(wikiPath, "index.md");
  if (!fs.existsSync(indexFile)) {
    return { text: null, cacheStatus: "miss" };
  }

  const relativeIndex = path.relative(cwd, indexFile);
  if (relativeIndex.startsWith("..") || path.isAbsolute(relativeIndex)) {
    return { text: readWikiContext(wikiPath), cacheStatus: "miss" };
  }

  const cached = await readOrCreateReusableValue<string | null>({
    cwd,
    rootDir: options?.cacheRootDir,
    objectType: "retrieved_context",
    snapshotHash: hashStructured({
      kind: "wiki_context",
      indexFile: relativeIndex,
    }),
    inputSignature: hashStructured({
      kind: "wiki_context",
      maxChars: 6000,
      wikiPath: path.resolve(wikiPath),
    }),
    runtimeVersion: "explorer:wiki-context:v1",
    relevantFilePaths: [relativeIndex],
    producer: () => readWikiContext(wikiPath),
  });

  return { text: cached.value, cacheStatus: cached.cacheStatus };
}

export async function runExplorer(
  provider: ModelProvider,
  input: ExploreInput,
): Promise<z.infer<typeof ExploreOutput>> {
  const wikiContext = readWikiContext(input.wikiPath);

  const userContent = [
    wikiContext
      ? `Contexto de la wiki del usuario (solo referencia):\n\n${wikiContext}\n\n---\n`
      : "",
    `Intención del usuario:\n${input.intent}`,
  ].join("");

  const messages: ChatMessage[] = [
    { role: "user", content: userContent },
  ];

  const raw = await provider.complete(messages, {
    systemPrompt: withPromptGuidance("explore", EXPLORER_SYSTEM),
    temperature: 0.5,
    maxTokens: 2048,
    model: input.model,
  });

  const jsonText = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Explorer devolvió JSON inválido. Respuesta cruda:\n${raw}\n\nError: ${
        (err as Error).message
      }`,
    );
  }

  const result = ExploreOutput.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Explorer output no pasa el schema:\n${result.error.message}\n\nJSON recibido:\n${jsonText}`,
    );
  }
  return result.data;
}
