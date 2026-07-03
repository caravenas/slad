import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getModel, loadConfig, resolveProvider, withPromptGuidance } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { EXPLORER_SYSTEM } from "../agents/prompts.js";
import { ExploreOutput, type ChatMessage } from "../core/types.js";
import {
  canUseInteractiveHitl,
  collectAnswers,
  formatAnswersForPrompt,
  printHitlHeader,
  printHitlPaused,
} from "../core/hitl.js";
import { log } from "../core/logger.js";
import { SchemaError } from "../core/errors.js";
import { getOrCreateSession, appendArtifact, saveSession, sessionContextBlock, lastArtifactPath } from "../core/session.js";
import { writeArtifact, readArtifact } from "../persistence/index.js";
import { readWikiContextCached } from "../agents/explorer.js";
import { hashStructured, hashText, readOrCreateReusableValue } from "@slad/cache";
import { projectContextBlock } from "../core/context.js";

export interface ExploreOpts {
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  skipSession?: boolean;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

function parseExploreOutput(raw: string): ReturnType<typeof ExploreOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = ExploreOutput.safeParse(parsed);
  if (!result.success) {
    throw new SchemaError(
      "Explorer output no pasa el schema",
      jsonText,
      result.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`),
      "explore",
    );
  }
  return result.data;
}

export async function generateExploreOutput(options: {
  intent: string;
  provider: import("@slad/model-providers").ModelProvider;
  providerName: string;
  model?: string;
  wikiPath?: string;
  cwd?: string;
  cacheRootDir?: string;
  sessionContext?: string;
  /** Token usage callback — llamado después de cada API call */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}): Promise<{
  value: ReturnType<typeof ExploreOutput.parse>;
  cacheStatus: "hit" | "miss";
  userContent: string;
}> {
  const wikiContext = await readWikiContextCached(options.wikiPath, {
    cwd: options.cwd,
    cacheRootDir: options.cacheRootDir,
  });
  const projectCtx = projectContextBlock(options.cwd);
  const userContent = [
    wikiContext.text ? `Contexto de la wiki del usuario (solo referencia):\n\n${wikiContext.text}\n\n---\n` : "",
    projectCtx,
    options.sessionContext,
    `Intención del usuario:\n${options.intent}`,
  ].filter(Boolean).join("\n\n");

  const result = await readOrCreateReusableValue({
    cwd: options.cwd,
    rootDir: options.cacheRootDir,
    objectType: "agent_outputs",
    snapshotHash: hashText(userContent),
    inputSignature: hashStructured({
      command: "explore",
      intent: options.intent,
      sessionContext: options.sessionContext ?? "",
      wikiPath: options.wikiPath ? path.resolve(options.wikiPath) : null,
    }),
    runtimeVersion: hashStructured({
      command: "explore",
      model: options.model ?? "",
      prompt: withPromptGuidance("explore", EXPLORER_SYSTEM),
      provider: options.providerName,
    }),
    producer: async () => {
      const raw = await options.provider.complete(
        [{ role: "user", content: userContent }],
        {
          systemPrompt: withPromptGuidance("explore", EXPLORER_SYSTEM),
          temperature: 0.5,
          maxTokens: 2048,
          model: options.model,
          onUsage: options.onUsage,
        },
      );
      return parseExploreOutput(raw);
    },
    isCacheable: (output) => output.status === "completed",
  });

  return { ...result, userContent };
}

export async function exploreCommand(intent: string, opts: ExploreOpts): Promise<void> {
  if (!intent || intent.trim().length < 3) {
    log.error('Intención vacía. Uso: slad explore "<tu intención>"');
    process.exit(1);
  }

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);


  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName);

  log.title(`Explorer · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`intent: ${intent}`);
  const session = opts.skipSession ? null : getOrCreateSession(intent);
  const sessionCtx = session ? sessionContextBlock(session) : "";
  const messages: ChatMessage[] = [];
  const maxRounds = 3;
  let output!: ReturnType<typeof ExploreOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Explorando el espacio de soluciones...").start();

  // Resume from UI HITL: if there's a previous awaiting_human artifact + saved answers
  const exploreAnswers = session
    ? session.humanAnswers.filter((a) => a.taskId === "explore")
    : [];
  const prevExplorePath = session ? lastArtifactPath(session, "explore") : undefined;
  if (exploreAnswers.length > 0 && prevExplorePath) {
    try {
      const { value: prevOutput } = await readArtifact("explore", prevExplorePath);
      if (prevOutput.status === "awaiting_human") {
        spinner.text = "Retomando con respuestas humanas...";
        // Reconstruct the conversation history exactly as interactive mode would
        const sessionCtxClean = sessionContextBlock({
          ...session!,
          humanAnswers: session!.humanAnswers.filter((a) => a.taskId !== "explore"),
        });
        const wikiContext = await readWikiContextCached(config.wikiPath);
        const projectCtx = projectContextBlock();
        const originalUserContent = [
          wikiContext.text ? `Contexto de la wiki del usuario (solo referencia):\n\n${wikiContext.text}\n\n---\n` : "",
          projectCtx,
          sessionCtxClean,
          `Intención del usuario:\n${intent}`,
        ].filter(Boolean).join("\n\n");
        const answersMap: Record<string, string> = {};
        for (const a of exploreAnswers) answersMap[a.questionId] = a.answer;
        output = prevOutput;
        raw = JSON.stringify(prevOutput);
        messages.push({ role: "user", content: originalUserContent });
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: formatAnswersForPrompt(answersMap) });
        rounds = 1;
      }
    } catch {
      // Previous artifact unreadable — fall through to fresh explore
    }
  }

  while (rounds <= maxRounds) {
    try {
      if (rounds === 0) {
        const result = await generateExploreOutput({
          intent,
          provider,
          providerName,
          model,
          wikiPath: config.wikiPath,
          sessionContext: sessionCtx,
        });
        output = result.value;
        raw = JSON.stringify(output);
        messages.push({
          role: "user",
          content: result.userContent,
        });
      } else {
        raw = await provider.complete(messages, {
          systemPrompt: withPromptGuidance("explore", EXPLORER_SYSTEM),
          temperature: 0.5,
          maxTokens: 2048,
          model,
        });
        output = parseExploreOutput(raw);
      }
    } catch (err) {
      spinner.fail("Falló la exploración");
      log.error((err as Error).message);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Exploración completada");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Explorer · max rounds HITL alcanzado");
      break;
    }

    if (!canUseInteractiveHitl()) {
      spinner.stop();
      printHitlPaused("Explorer", output.questions.length);
      break;
    }

    spinner.stop();
    printHitlHeader("Explorer", "", rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  console.log("");
  console.log(kleur.bold("Reframing"));
  console.log("  " + output.reframing);

  console.log("\n" + kleur.bold("Approaches"));
  output.approaches.forEach((a, i) => {
    console.log(kleur.cyan(`\n  ${i + 1}. ${a.name}`));
    console.log("     " + a.summary);
    a.pros.forEach((p) => console.log(kleur.green("     + ") + p));
    a.cons.forEach((c) => console.log(kleur.red("     − ") + c));
  });

  if (output.risks.length) {
    console.log("\n" + kleur.bold("Risks"));
    output.risks.forEach((r) => console.log("  · " + r));
  }

  if (output.openQuestions.length) {
    console.log("\n" + kleur.bold("Open Questions"));
    output.openQuestions.forEach((q) => console.log("  ? " + q));
  }

  console.log("\n" + kleur.bold("Recommended Next"));
  console.log("  → " + output.recommendedNext);

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (session) {
    const ref = await writeArtifact("explore", output, { sessionId: session.id });
    saveSession(appendArtifact(session, "explore", ref.path));
    log.success(`Guardado en ${ref.path}`);
    log.dim(`  sesión: ${session.id}`);
  }
}
