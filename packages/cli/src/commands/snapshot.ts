import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import { getApiKey, getModel, loadConfig, resolveProvider, withPromptGuidance } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { ExploreOutput, SnapshotOutput, type ChatMessage } from "../core/types.js";
import { SNAPSHOT_SYSTEM } from "../agents/prompts.js";
import {
  canUseInteractiveHitl,
  collectAnswers,
  formatAnswersForPrompt,
  printHitlHeader,
  printHitlPaused,
} from "../core/hitl.js";
import { projectContextBlock } from "../core/context.js";
import { log } from "../core/logger.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";
import { readArtifact, writeArtifact } from "../persistence/index.js";

export interface SnapshotOpts {
  input?: string;
  intent?: string;
  approach?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
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

// ─── Pure generator (sin UI) ──────────────────────────────────────────────────

export interface GenerateSnapshotOpts {
  /** ExploreOutput completo (output del stage anterior) */
  exploreOutput: ReturnType<typeof ExploreOutput.parse>;
  /** Nombre (o substring) del approach a usar. Si undefined, usa el primero. */
  approach?: string;
  provider: import("@slad/model-providers").ModelProvider;
  model?: string;
  cwd?: string;
  /** Token usage callback */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/**
 * Genera un SnapshotOutput a partir de un ExploreOutput.
 * Función pura: sin spinners ni console.log, sin HITL interactivo.
 * Si el LLM retorna awaiting_human, retorna el output tal cual (el caller decide).
 */
export async function generateSnapshotOutput(opts: GenerateSnapshotOpts): Promise<ReturnType<typeof SnapshotOutput.parse>> {
  const exp = opts.exploreOutput;
  const chosen = opts.approach
    ? exp.approaches.find((a) => a.name.toLowerCase().includes(opts.approach!.toLowerCase()))
    : exp.approaches[0];

  const projectCtx = projectContextBlock(opts.cwd);

  const parts = [
    projectCtx,
    `Intent original:\n${exp.intent}`,
    `Reframing:\n${exp.reframing}`,
    chosen
      ? `Enfoque elegido — ${chosen.name}:\n${chosen.summary}\nPros: ${chosen.pros.join("; ")}\nCons: ${chosen.cons.join("; ")}`
      : "",
    exp.risks.length ? `Riesgos conocidos:\n- ${exp.risks.join("\n- ")}` : "",
    exp.openQuestions.length ? `Preguntas abiertas:\n- ${exp.openQuestions.join("\n- ")}` : "",
    `Next step sugerido: ${exp.recommendedNext}`,
  ].filter(Boolean).join("\n\n");

  const raw = await opts.provider.complete(
    [{ role: "user", content: parts }],
    {
      systemPrompt: withPromptGuidance("snapshot", SNAPSHOT_SYSTEM),
      temperature: 0.3,
      maxTokens: 1500,
      model: opts.model,
      onUsage: opts.onUsage,
    },
  );

  return parseSnapshotOutput(raw);
}


function parseSnapshotOutput(raw: string): ReturnType<typeof SnapshotOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = SnapshotOutput.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
    throw new Error(`Snapshot output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
  }
  return result.data;
}

async function readExploreInput(input: string): Promise<ReturnType<typeof ExploreOutput.parse>> {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error(`No existe el archivo: ${abs}`);
  if (abs.endsWith(".json")) return (await readArtifact("explore", abs)).value;

  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  const parsed = ExploreOutput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`El archivo no sigue el schema de ExploreOutput:\n${parsed.error.message}`);
  }
  return parsed.data;
}

async function buildUserContent(opts: SnapshotOpts, sessionCtx: string): Promise<{ content: string; title: string }> {
  if (opts.input) {
    const exp = await readExploreInput(opts.input);

    const chosen = opts.approach
      ? exp.approaches.find((a) => a.name.toLowerCase().includes(opts.approach!.toLowerCase()))
      : exp.approaches[0];

    const parts = [
      `Intent original:\n${exp.intent}`,
      `Reframing:\n${exp.reframing}`,
      chosen
        ? `Enfoque elegido — ${chosen.name}:\n${chosen.summary}\nPros: ${chosen.pros.join("; ")}\nCons: ${chosen.cons.join("; ")}`
        : "",
      exp.risks.length ? `Riesgos conocidos:\n- ${exp.risks.join("\n- ")}` : "",
      exp.openQuestions.length ? `Preguntas abiertas:\n- ${exp.openQuestions.join("\n- ")}` : "",
      `Next step sugerido: ${exp.recommendedNext}`,
      sessionCtx,
    ].filter(Boolean);

    return { content: parts.join("\n\n"), title: exp.intent };
  }

  if (opts.intent) {
    const content = sessionCtx
      ? `Intención: ${opts.intent}\n\n${sessionCtx}`
      : `Intención: ${opts.intent}`;
    return { content, title: opts.intent };
  }

  throw new Error(
    "Necesitas --input <explore.md|explore.json>, --intent \"<texto>\", o una sesión activa con explore completado.",
  );
}

export async function snapshotCommand(opts: SnapshotOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();

  if (!opts.input && !opts.intent && session) {
    const explorePath = lastArtifactPath(session, "explore");
    if (explorePath) {
      opts = { ...opts, input: explorePath };
      log.dim(`  sesión: usando explore en ${explorePath}`);
    }
  }

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
  const apiKey = getApiKey(providerName);
  if (providerName !== "cli" && !apiKey) {
    log.error(
      `No se encontró API key para ${providerName}. Define la variable de entorno correspondiente.`,
    );
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName, apiKey ?? undefined);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const projectCtx = projectContextBlock();
  let userPayload: { content: string; title: string };
  try {
    userPayload = await buildUserContent(opts, sessionCtx);
    if (projectCtx) {
      userPayload = { ...userPayload, content: `${projectCtx}\n\n${userPayload.content}` };
    }
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  log.title(`Snapshot · ${providerName}${model ? ` · ${model}` : ""}`);

  const messages: ChatMessage[] = [{ role: "user", content: userPayload.content }];
  const maxRounds = 3;
  let output!: ReturnType<typeof SnapshotOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Generando snapshot...").start();

  while (rounds <= maxRounds) {
    try {
      raw = await provider.complete(messages, {
        systemPrompt: withPromptGuidance("snapshot", SNAPSHOT_SYSTEM),
        temperature: 0.3,
        maxTokens: 1500,
        model,
      });
    } catch (err) {
      spinner.fail("Falló la generación del snapshot");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      output = parseSnapshotOutput(raw);
    } catch (err) {
      spinner.fail("Output del snapshot inválido");
      log.error((err as Error).message);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Snapshot listo");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Snapshot · max rounds HITL alcanzado");
      break;
    }

    if (!canUseInteractiveHitl()) {
      spinner.stop();
      printHitlPaused("Snapshot", output.questions.length);
      break;
    }

    spinner.stop();
    printHitlHeader("Snapshot", "", rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  output = {
    ...output,
    content: output.content.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim(),
  };

  if (session) {
    const ref = await writeArtifact("snapshot", output, { sessionId: session.id });
    saveSession(appendArtifact(session, "snapshot", ref.path));
    log.success(`Guardado en ${ref.path}`);
    log.dim(`  sesión: ${session.id}`);
  } else {
    const ref = await writeArtifact("snapshot", output, { sessionId: "adhoc" });
    if (opts.output) log.warn("--output para snapshot está deprecado; se escribió en la persistencia MD+YAML.");
    log.success(`Guardado en ${ref.path}`);
  }
}
