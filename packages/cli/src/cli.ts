import { Command } from "commander";
import { loadEnv } from "./core/config.js";
import { exploreCommand } from "./commands/explore.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { planCommand } from "./commands/plan.js";
import { runCommand } from "./commands/run.js";
import { learnCommand } from "./commands/learn.js";
import { evolveCommand } from "./commands/evolve.js";
import { autoCommand } from "./commands/auto.js";
import { statsCommand } from "./commands/stats.js";
import { agentsListCommand, agentsUseCommand } from "./commands/agents.js";
import { modelCommand } from "./commands/model.js";
import {
  sessionStartCommand,
  sessionListCommand,
  sessionUseCommand,
  sessionShowCommand,
} from "./commands/session.js";
import { askCommand } from "./commands/ask.js";
import { chatCommand } from "./commands/chat.js";
import { log } from "./core/logger.js";
import { SladError } from "./core/errors.js";
import { getFormattedCliVersion } from "./cli/version.js";

loadEnv();

const cliVersion = await getFormattedCliVersion();
const program = new Command();

program
  .name("slad")
  .description("SLAD OS — CLI de agentes para explorar intención y generar Snapshots.")
  .version(cliVersion)
  .addHelpText(
    "after",
    `
Respuesta rápida (sin pipeline):

  $ slad ask "¿qué es Zod y cuándo usarlo?"
  $ slad ask "explícame el patrón Result en TypeScript" --save

Pipeline completo:

  $ slad auto "agregar autenticación"
  $ slad auto "agregar autenticación" --dry-run    # solo explore+snapshot+plan
  $ slad auto "agregar autenticación" --skip-learn  # sin retrospectiva

Pipeline por stages:

  $ slad session start "agregar autenticación"
  $ slad explore "agregar autenticación"
  $ slad snapshot && slad plan && slad run T1
  $ slad learn && slad evolve

Modo conversacional:

  $ slad chat
`,
  );

program
  .command("version")
  .description("Imprime la versión de SLAD OS.")
  .action(() => {
    process.stdout.write(`${cliVersion}\n`);
  });

program
  .command("stats")
  .description("Muestra totales de sesiones, runs y learnings del proyecto.")
  .option("--json", "Imprimir JSON plano en stdout")
  .action(async (opts) => {
    await statsCommand(opts);
  });

program
  .command("model")
  .description("Configura el proveedor CLI, binario y modelo por defecto global.")
  .action(async () => {
    await modelCommand();
  });

program
  .command("explore")
  .description("Explorer Agent: analiza una intención y devuelve enfoques, riesgos y next steps.")
  .argument("<intent...>", "La intención a explorar (entre comillas o libre)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Guardar el resultado como JSON en esta ruta")
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (intentParts: string[], opts) => {
    const intent = intentParts.join(" ");
    await exploreCommand(intent, opts);
  });

program
  .command("snapshot")
  .description("Genera un Snapshot (mini-spec) a partir de un explore.json o de una intención.")
  .option("-i, --input <path>", "Ruta a un explore.json (output de `slad explore --output`)")
  .option("--intent <text>", "Intención directa si no hay input previo")
  .option("--approach <name>", "Nombre (o substring) del approach a elegir del explore.json")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida del .md (default: ./snapshots/<fecha>-<slug>.md)")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await snapshotCommand(opts);
  });

program
  .command("plan")
  .description("Planner Agent: convierte un Snapshot en tasks.json ejecutable.")
  .option("-i, --input <path>", "Ruta a un snapshot.md (default: último snapshot de la sesión activa)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida del JSON (default: ./tasks/tasks.json)")
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await planCommand(opts);
  });

program
  .command("run")
  .description("Builder + Reviewer: ejecuta una tarea de tasks.json y guarda un reporte.")
  .argument("[task]", "Task id a ejecutar (ej. T2). Alternativa a --task")
  .option("-i, --input <path>", "Ruta a tasks.json (default: ./tasks/tasks.json)")
  .option("-t, --task <id>", "Task id a ejecutar (default: recommendedFirstTask)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "[DEPRECATED] Ignorado; los runs se guardan en <docsRoot>/log/runs/")
  .option("--max-rounds <n>", "Máximo de rounds HITL antes de marcar blocked (default: 3)", parseInt)
  .option("--auto", "Ejecutar el DAG completo de tareas automáticamente")
  .option("--max-tasks <n>", "Budget de ejecuciones en modo --auto (default: 10)", parseInt)
  .option("--parallel", "Ejecutar tareas independientes del DAG en paralelo (requiere --auto, solo con --no-tools o modo no-interactivo)")
  .option("--max-parallel <n>", "Máximo de tareas paralelas simultáneas (default: 3)", parseInt)
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .option("--harness <mode>", "Modo del arnés de seguridad (off | on | strict)", "off")
  .option("--non-interactive", "No abrir prompts interactivos; persistir/saltar bloqueos para UI/automation")
  .option("--tools", "Habilitar tool use: el agente ejecuta código real (default si el provider lo soporta)")
  .option("--no-tools", "Deshabilitar tool use: modo advisory (describe qué haría sin ejecutar)")
  .action(async (taskArg: string | undefined, opts) => {
    await runCommand({ ...opts, task: taskArg ?? opts.task });
  });

program
  .command("learn")
  .description("Learn Agent: captura decisiones, errores y patrones desde un run report.")
  .option("-i, --input <path>", "Ruta a un run report .md o JSON legacy (default: último run persistido)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida (default: ./learnings/<timestamp>-<task>.md)")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await learnCommand(opts);
  });

program
  .command("evolve")
  .description("Evolve Agent: propone actualizaciones de wiki/patrones desde artefactos recientes.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida (default: ./evolution/<timestamp>-evolve.md)")
  .option("--apply-wiki", "Append del resultado a $SLAD_WIKI_PATH/slad-os-evolution.md")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await evolveCommand(opts);
  });

function buildAutoOpts(opts: {
  provider?: string;
  agent?: string;
  model?: string;
  maxCost?: number;
  maxTasks?: number;
  harness?: string;
  dryRun?: boolean;
  skipLearn?: boolean;
  resume?: boolean;
  fresh?: boolean;
  json?: boolean;
  debate?: boolean;
  debateModels?: string;
  debateThreshold?: number;
  classify?: boolean;
}) {
  return {
    provider: opts.provider,
    agent: opts.agent,
    model: opts.model,
    maxCost: opts.maxCost,
    maxTasks: opts.maxTasks,
    harness: opts.harness as "off" | "on" | "strict" | undefined,
    dryRun: opts.dryRun,
    skipLearn: opts.skipLearn,
    resume: opts.resume,
    fresh: opts.fresh,
    json: opts.json,
    debate: opts.debate,
    debateModels: opts.debateModels,
    debateThreshold: opts.debateThreshold,
    classify: opts.classify,
  };
}

const AUTO_OPTIONS = (cmd: import("commander").Command) =>
  cmd
    .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
    .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
    .option("-m, --model <name>", "Modelo a usar")
    .option("--max-cost <usd>", "Budget máximo en USD (default: 1.0)", parseFloat)
    .option("--max-tasks <n>", "Máximo de tasks a ejecutar (default: 10)", parseInt)
    .option("--harness <mode>", "Modo del arnés de seguridad (off | on | strict)", "on")
    .option("--dry-run", "Solo explore+snapshot+plan, sin ejecutar código")
    .option("--skip-learn", "No ejecutar learn al final")
    .option("--resume", "Resumir desde el último checkpoint sin preguntar")
    .option("--fresh", "Ignorar checkpoints y empezar de cero")
    .option("--json", "Output JSON del report final")
    .option("--debate", "Ejecutar explore y plan con dos modelos en paralelo + árbitro")
    .option("--debate-models <m1,m2>", "Par de modelos para el debate (ej. claude-opus-4-7,claude-sonnet-4-6)")
    .option("--debate-threshold <n>", "Umbral de consenso para HITL automático (default: 0.7)", parseFloat)
    .option("--no-classify", "Saltar el clasificador automático de intención (Haiku)");

AUTO_OPTIONS(
  program
    .command("work")
    .description("Pipeline completo: explore → snapshot → plan → run → learn.")
    .argument("<intent...>", "La intención a implementar"),
).action(async (intentParts: string[], opts) => {
  await autoCommand(intentParts.join(" "), buildAutoOpts(opts));
});

AUTO_OPTIONS(
  program
    .command("auto")
    .description("[alias de work] Pipeline completo.")
    .argument("<intent...>", "La intención a implementar"),
).action(async (intentParts: string[], opts) => {
  await autoCommand(intentParts.join(" "), buildAutoOpts(opts));
});

program
  .command("ask")
  .description("Respuesta directa del modelo, sin pipeline. Ideal para preguntas rápidas.")
  .argument("<question...>", "Pregunta o consulta (en lenguaje natural)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli")
  .option("-m, --model <name>", "Modelo a usar")
  .option("--save", "Guardar la respuesta como nota en la sesión activa")
  .action(async (questionParts: string[], opts) => {
    await askCommand(questionParts.join(" "), opts);
  });

program
  .command("chat")
  .description("REPL conversacional: explorá, planificá y ejecutá en formato chat.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .action(async (opts) => {
    await chatCommand(opts);
  });

const sessionCmd = program
  .command("session")
  .description("Gestiona sesiones de trabajo: contexto compartido entre comandos.");

sessionCmd
  .command("start <intent...>")
  .description("Crea una nueva sesión y la marca como activa.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini) — pre-selecciona sin pasar por discovery")
  .action(async (intentParts: string[], opts) => {
    await sessionStartCommand(intentParts.join(" "), opts.agent);
  });

sessionCmd
  .command("list")
  .description("Lista todas las sesiones en el proyecto.")
  .action(async () => {
    await sessionListCommand();
  });

sessionCmd
  .command("use <id>")
  .description("Cambia la sesión activa.")
  .action(async (id: string) => {
    await sessionUseCommand(id);
  });

sessionCmd
  .command("show")
  .description("Muestra el estado de la sesión activa.")
  .action(async () => {
    await sessionShowCommand();
  });

const agentsCmd = program
  .command("agents")
  .description("Lista los agentes disponibles y muestra el activo.")
  .action(() => {
    agentsListCommand();
  });

agentsCmd
  .command("use <id>")
  .description("Cambia el agente activo (ej. slad agents use developer).")
  .action((id: string) => {
    agentsUseCommand(id);
  });

// When slad is invoked with no subcommand (or only global flags like --agent),
// open the interactive chat.  We detect this by checking whether argv contains
// any positional token that matches a known subcommand.
const knownCommands = new Set(program.commands.map((c) => c.name()));
const userArgs = process.argv.slice(2);
const hasSubcommand = userArgs.some((a) => knownCommands.has(a));
const hasRootProgramFlag = userArgs.some((a) => ["--version", "-V", "--help", "-h"].includes(a));

if (!hasSubcommand && !hasRootProgramFlag) {
  // Parse --agent / --provider / --model from argv manually so they work at the root level.
  const rootChat = new Command("slad")
    .allowUnknownOption(false)
    .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
    .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli")
    .option("-m, --model <name>", "Modelo a usar")
    .parse(process.argv);
  const opts = rootChat.opts<{ agent?: string; provider?: string; model?: string }>();
  const { chatCommand } = await import("./commands/chat.js");
  await chatCommand(opts);
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof SladError) {
    log.error(`[${err.code}] ${err.message}`, err);
    if (Object.keys(err.context).length > 0) {
      log.debug("Context", err.context);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
