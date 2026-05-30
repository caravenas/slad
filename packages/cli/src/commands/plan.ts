import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider, withPromptGuidance } from "../core/config.js";
import { PlanOutput, type ChatMessage } from "../core/types.js";
import { getSladProvider } from "../core/providers.js";
import { PLANNER_SYSTEM } from "../agents/prompts.js";
import {
  canUseInteractiveHitl,
  collectAnswers,
  formatAnswersForPrompt,
  printHitlHeader,
  printHitlPaused,
} from "../core/hitl.js";
import { log } from "../core/logger.js";
import { hashStructured, hashText, readOrCreateReusableValue } from "@slad/cache";
import { projectContextBlock } from "../core/context.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";
import { readArtifact, writeArtifact } from "../persistence/index.js";

export interface PlanOpts {
  input?: string;
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

async function readSnapshot(input: string): Promise<{ content: string; title: string }> {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new Error(`No existe el archivo: ${abs}`);
  }

  if (abs.endsWith(".json")) {
    const parsed = await readArtifact("snapshot", abs);
    const title = parsed.value.content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(input);
    return { content: parsed.value.content, title };
  }

  const content = fs.readFileSync(abs, "utf8");
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(input);
  return { content, title };
}

function parsePlanOutput(raw: string): ReturnType<typeof PlanOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = PlanOutput.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
    throw new Error(`Planner output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
  }
  return result.data;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isDocumentationPlan(output: ReturnType<typeof PlanOutput.parse>, snapshotContent: string): boolean {
  const text = [
    snapshotContent,
    output.snapshot,
    output.summary,
    ...output.tasks.flatMap((task) => [task.title, task.description, ...task.files]),
  ].join("\n").toLowerCase();
  const docIntent = /\breadme\b|documentaci[oó]n|docs?\b|changelog|gu[ií]a/.test(text);
  if (!docIntent) return false;
  const nonDocTasks = output.tasks.filter((task) => !["docs", "review", "research"].includes(task.type));
  return nonDocTasks.length === 0;
}

function primaryDocFiles(output: ReturnType<typeof PlanOutput.parse>): string[] {
  const files = uniqueStrings(output.tasks.flatMap((task) => task.files));
  const primary = files.filter((file) => /\.(md|mdx|txt|rst)$/i.test(file) || /readme|changelog|docs?\//i.test(file));
  return primary.length ? primary : files.slice(0, 3);
}

export function normalizePlanOutput(
  output: ReturnType<typeof PlanOutput.parse>,
  snapshotContent: string,
): ReturnType<typeof PlanOutput.parse> {
  if (output.status !== "completed") return output;
  if (output.tasks.length <= 3) return output;
  if (!isDocumentationPlan(output, snapshotContent)) return output;

  const files = uniqueStrings(output.tasks.flatMap((task) => task.files)).slice(0, 12);
  const docFiles = primaryDocFiles(output);
  const criteria = uniqueStrings(output.tasks.flatMap((task) => task.acceptanceCriteria)).slice(0, 8);
  const editTask = {
    id: "T1" as const,
    title: docFiles.length === 1 ? `Actualizar ${docFiles[0]}` : "Actualizar documentación",
    description:
      "Aplicar en una sola edición coherente los cambios documentales solicitados, usando el inventario del repo como fuente y evitando secciones inventadas.",
    type: "docs" as const,
    priority: "high" as const,
    dependsOn: [],
    files,
    acceptanceCriteria: criteria.length
      ? criteria
      : ["La documentación refleja el estado real del proyecto sin inventar comandos, providers ni variables."],
  };
  const reviewTask = {
    id: "T2" as const,
    title: "Revisar documentación actualizada",
    description:
      "Revisar consistencia, ejemplos, alcance y comandos documentados contra el inventario real antes de cerrar.",
    type: "review" as const,
    priority: "medium" as const,
    dependsOn: ["T1" as const],
    files: docFiles,
    acceptanceCriteria: [
      "Los comandos, providers y variables mencionados existen en el repo o en la configuración documentada.",
      "La documentación queda orientada a usuario/contribuidor sin convertirse en referencia exhaustiva interna.",
      "No quedan follow-ups documentales obvios para completar el mismo cambio.",
    ],
  };

  return {
    ...output,
    summary: `${output.summary} Plan compactado para evitar fragmentar una edición documental en tareas artificiales.`,
    tasks: [editTask, reviewTask],
    recommendedFirstTask: "T1",
  };
}

export async function generatePlanOutput(options: {
  snapshotContent: string;
  provider: import("@slad/model-providers").ModelProvider;
  providerName: string;
  model?: string;
  sessionContext?: string;
  cwd?: string;
  cacheRootDir?: string;
  /** Token usage callback — llamado después de cada API call */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}): Promise<{
  value: ReturnType<typeof PlanOutput.parse>;
  cacheStatus: "hit" | "miss";
  userContent: string;
}> {
  const projectCtx = projectContextBlock(options.cwd);
  const userContent = [
    projectCtx,
    `Snapshot:\n\n${options.snapshotContent}`,
    options.sessionContext,
  ].filter(Boolean).join("\n\n");

  const result = await readOrCreateReusableValue({
    cwd: options.cwd,
    rootDir: options.cacheRootDir,
    objectType: "planner",
    snapshotHash: hashText(options.snapshotContent),
    inputSignature: hashStructured({
      command: "plan",
      sessionContext: options.sessionContext ?? "",
    }),
    runtimeVersion: hashStructured({
      command: "plan",
      model: options.model ?? "",
      prompt: withPromptGuidance("plan", PLANNER_SYSTEM),
      provider: options.providerName,
    }),
    producer: async () => {
      const raw = await options.provider.complete([{ role: "user", content: userContent }], {
        systemPrompt: withPromptGuidance("plan", PLANNER_SYSTEM),
        temperature: 0.2,
        maxTokens: 2500,
        model: options.model,
        onUsage: options.onUsage,
      });
      return normalizePlanOutput(parsePlanOutput(raw), options.snapshotContent);
    },
    isCacheable: (output) => output.status === "completed",
  });

  return { ...result, userContent };
}

export async function planCommand(opts: PlanOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();

  // Resolve input from session if not explicit
  const inputPath =
    opts.input ??
    (session ? lastArtifactPath(session, "snapshot") : undefined);

  if (!inputPath) {
    log.error(
      session
        ? "No hay snapshot en la sesión activa. Corré `slad snapshot` primero."
        : "Necesitas --input <snapshot.md>",
    );
    process.exit(1);
  }

  if (!opts.input && session) {
    log.dim(`  sesión: usando snapshot en ${inputPath}`);
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

  let snapshot: { content: string; title: string };
  try {
    snapshot = await readSnapshot(inputPath);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName, apiKey ?? undefined);

  log.title(`Planner · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`snapshot: ${snapshot.title}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const messages: ChatMessage[] = [];
  const maxRounds = 3;
  let output!: ReturnType<typeof PlanOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Generando plan de tareas...").start();

  while (rounds <= maxRounds) {
    try {
      if (rounds === 0) {
        const result = await generatePlanOutput({
          snapshotContent: snapshot.content,
          provider,
          providerName,
          model,
          sessionContext: sessionCtx,
        });
        output = result.value;
        raw = JSON.stringify(output);
        messages.push({ role: "user", content: result.userContent });
      } else {
        raw = await provider.complete(messages, {
          systemPrompt: withPromptGuidance("plan", PLANNER_SYSTEM),
          temperature: 0.2,
          maxTokens: 2500,
          model,
        });
      }
    } catch (err) {
      spinner.fail("Falló la generación del plan");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      output = normalizePlanOutput(parsePlanOutput(raw), snapshot.content);
    } catch (err) {
      spinner.fail("Falló la validación del plan");
      log.error((err as Error).message);
      log.dim(`Respuesta cruda:\n${raw}`);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Plan listo");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Planner · max rounds HITL alcanzado");
      break;
    }

    if (!canUseInteractiveHitl()) {
      spinner.stop();
      printHitlPaused("Planner", output.questions.length);
      break;
    }

    spinner.stop();
    printHitlHeader("Planner", output.summary, rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  const json = JSON.stringify(output, null, 2);
  if (opts.json && !opts.output) {
    console.log(json);
    return;
  }

  if (!opts.json) {
    console.log("");
    console.log(kleur.bold("Summary"));
    console.log("  " + output.summary);

    console.log("\n" + kleur.bold("Tasks"));
    output.tasks.forEach((task) => {
      const deps = task.dependsOn.length ? ` deps: ${task.dependsOn.join(", ")}` : "";
      console.log(kleur.cyan(`\n  ${task.id}. ${task.title}`) + kleur.gray(deps));
      console.log("     " + task.description);
      task.acceptanceCriteria.forEach((criterion) => {
        console.log(kleur.green("     ✓ ") + criterion);
      });
    });

    if (output.verification.length) {
      console.log("\n" + kleur.bold("Verification"));
      output.verification.forEach((check) => console.log("  · " + check));
    }

    console.log("\n" + kleur.bold("Recommended First Task"));
    console.log("  → " + output.recommendedFirstTask);
  }

  if (session) {
    const ref = await writeArtifact("plan", output, { sessionId: session.id });
    saveSession(appendArtifact(session, "plan", ref.path));
    log.success(`Guardado en ${ref.path}`);
    log.dim(`  sesión: ${session.id}`);
  } else {
    const ref = await writeArtifact("plan", output, { sessionId: "adhoc" });
    if (opts.output) log.warn("--output para plan está deprecado; se escribió en la persistencia MD+YAML.");
    log.success(`Guardado en ${ref.path}`);
  }
}
