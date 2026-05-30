import ora from "ora";
import kleur from "kleur";
import { input, select } from "@inquirer/prompts";
import { loadConfig, resolveProvider, getApiKey, getModel } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import {
  createSession,
  getActiveSession,
  getActiveSessionId,
  sessionContextBlock,
} from "../core/session.js";
import type { SessionState } from "../core/types.js";
import { exploreCommand } from "./explore.js";
import { snapshotCommand } from "./snapshot.js";
import { planCommand } from "./plan.js";
import { runCommand } from "./run.js";
import { learnCommand } from "./learn.js";
import { evolveCommand } from "./evolve.js";
import { autoCommand } from "./auto.js";
import { sessionShowCommand } from "./session.js";
import { makeHeader } from "../cli/ui.js";
import { getFormattedCliVersion } from "../cli/version.js";
import { runSetupIfNeeded } from "../core/setup.js";

const CHAT_SYSTEM = `Eres un asistente técnico experto en desarrollo de software.
Responde de forma directa, concisa y útil en el idioma del usuario.
Si el usuario quiere implementar algo concreto, sugerile usar /auto "<intención>" para ejecutar el pipeline completo.`;

/**
 * Reference to the real process.exit captured at module load.
 * safeCall swaps process.exit for a throwing stub; the SIGINT handler must
 * always use the real one.
 */
const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);

export interface ChatOpts {
  provider?: string;
  agent?: string;
  model?: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function line(char = "─", color: (s: string) => string = kleur.dim): string {
  const width = process.stdout.columns || 80;
  return color(char.repeat(width));
}

// ─── routing ──────────────────────────────────────────────────────────────────

type ChatAction =
  | { type: "chat"; message: string }
  | { type: "explore"; intent: string }
  | { type: "snapshot" }
  | { type: "plan" }
  | { type: "run-auto" }
  | { type: "run-task"; taskId: string }
  | { type: "run-next" }
  | { type: "learn" }
  | { type: "evolve" }
  | { type: "auto"; intent: string }
  | { type: "status" }
  | { type: "new" }
  | { type: "help" }
  | { type: "exit" }
  | { type: "unknown"; input: string };

function hasArtifact(session: SessionState | null, kind: string): boolean {
  return session?.artifacts.some((a: { kind: string }) => a.kind === kind) ?? false;
}

export function parseAction(raw: string, _session: SessionState | null): ChatAction {
  const trimmed = raw.trim();
  if (!trimmed) return { type: "chat", message: "" };

  // Slash commands — pipeline stages and meta commands
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.slice(1).trim();
    const lower = cmd.toLowerCase();

    if (/^(exit|quit|salir|bye|chau|q)$/i.test(lower)) return { type: "exit" };
    if (/^(help|ayuda|\?|h)$/i.test(lower)) return { type: "help" };
    if (/^(status|estado|show|sesion|sesión)$/i.test(lower)) return { type: "status" };
    if (/^(new|nuevo|nueva|reset)$/i.test(lower)) return { type: "new" };
    if (/^(evolve|evolucionar?)$/i.test(lower)) return { type: "evolve" };
    if (/^(learn|aprender?)$/i.test(lower)) return { type: "learn" };
    if (/^(plan|planificar?)$/i.test(lower)) return { type: "plan" };
    if (/^snapshot$/i.test(lower)) return { type: "snapshot" };
    if (/^(run\s+--auto|run\s+auto|run\s+todo)$/i.test(lower)) return { type: "run-auto" };

    const autoMatch = cmd.match(/^(?:auto|work|pipeline)\s+(.+)/i);
    if (autoMatch) return { type: "auto", intent: autoMatch[1]! };
    if (/^auto$/i.test(lower)) return { type: "run-auto" };

    const taskMatch = cmd.match(/^(?:run\s+)?(T\d+)$/i);
    if (taskMatch) return { type: "run-task", taskId: taskMatch[1]!.toUpperCase() };
    if (/^(run|ejecutar?)$/i.test(lower)) return { type: "run-next" };

    const exploreMatch = cmd.match(/^(?:explore?|explorar?)\s+(.+)/i);
    if (exploreMatch) return { type: "explore", intent: exploreMatch[1]! };

    return { type: "unknown", input: trimmed };
  }

  // Plain text → direct model chat (default mode)
  return { type: "chat", message: trimmed };
}

export function suggestNext(session: SessionState | null): string {
  if (!session || !hasArtifact(session, "explore")) {
    return (
      kleur.dim("Escribe cualquier cosa para chatear, o usa ") +
      kleur.cyan("/auto \"<intención>\"") +
      kleur.dim(" para ejecutar el pipeline completo.")
    );
  }
  if (!hasArtifact(session, "snapshot")) return kleur.dim("Pipeline → ") + kleur.cyan("/snapshot");
  if (!hasArtifact(session, "plan")) return kleur.dim("Pipeline → ") + kleur.cyan("/plan");
  if (!hasArtifact(session, "run")) return kleur.dim("Pipeline → ") + kleur.cyan("/run") + kleur.dim(" o ") + kleur.cyan("/run T1");
  if (!hasArtifact(session, "learn")) return kleur.dim("Pipeline → ") + kleur.cyan("/learn");
  return kleur.dim("Pipeline → ") + kleur.cyan("/evolve") + kleur.dim(" o escribe para seguir chateando.");
}

// ─── safe command wrapper ─────────────────────────────────────────────────────

export async function safeCall(fn: () => Promise<void>): Promise<boolean> {
  const originalExit = process.exit.bind(process);
  let didExit = false;
  (process as NodeJS.Process).exit = ((code?: number | string | null) => {
    didExit = true;
    throw Object.assign(new Error(`process.exit(${code ?? 0})`), { isProcessExit: true });
  }) as typeof process.exit;

  try {
    await fn();
    return true;
  } catch (err) {
    if (didExit || (err as { isProcessExit?: boolean }).isProcessExit) return false;
    log.error((err as Error).message);
    return false;
  } finally {
    process.exit = originalExit;
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const w = 22;
  const cmds: [string, string][] = [
    ["<mensaje>", "Chat directo con el modelo (modo por defecto)"],
    ["/auto <intención>", "Pipeline completo: explore → snapshot → plan → run → learn"],
    ["/explore <texto>", "Solo el stage explore"],
    ["/snapshot", "Generar el mini-spec del último explore"],
    ["/plan", "Generar las tareas del snapshot"],
    ["/run [T1]", "Ejecutar la siguiente tarea (o una específica)"],
    ["/learn", "Capturar aprendizajes del último run"],
    ["/evolve", "Proponer actualizaciones a la wiki"],
    ["/status", "Ver estado de la sesión activa"],
    ["/new", "Empezar una nueva sesión"],
    ["/help", "Ver esta ayuda"],
    ["/exit", "Salir"],
  ];
  console.log("");
  console.log(kleur.bold("  Comandos disponibles:"));
  console.log("");
  cmds.forEach(([cmd, desc]) => {
    console.log("  " + kleur.cyan(cmd.padEnd(w)) + kleur.dim(desc));
  });
  console.log(kleur.dim("\n  Los comandos también funcionan sin el / (ej. auto, explore, plan...)"));
}

// ─── session header ───────────────────────────────────────────────────────────

function printSessionInfo(session: SessionState | null): void {
  if (session) {
    const count = session.artifacts.length;
    console.log(
      "  " +
      kleur.dim("sesión ") +
      kleur.cyan(session.id) +
      kleur.dim(" · ") +
      kleur.white(session.intent) +
      kleur.dim(` · ${count} artefacto${count !== 1 ? "s" : ""}`)
    );
    const answers = sessionContextBlock(session);
    if (answers) {
      console.log(kleur.dim(`\n  ${answers.split("\n").join("\n  ")}`));
    }
  } else {
    console.log("  " + kleur.dim("Sin sesión activa — escribe tu primera intención para comenzar."));
  }
  console.log("");
  console.log("  " + suggestNext(session));
  console.log("  " + kleur.dim("Usa /help para ver todos los comandos."));
}

// ─── action executor ──────────────────────────────────────────────────────────

async function executeAction(
  action: ChatAction,
  opts: ChatOpts,
  session: SessionState | null,
): Promise<SessionState | null> {
  const base = {
    provider: opts.provider,
    agent: opts.agent,
    model: opts.model,
    skipSession: false,
  };

  switch (action.type) {
    case "chat": {
      if (!action.message) break;
      const config = loadConfig();
      const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
      const apiKey = getApiKey(providerName);
      const model = opts.model ?? getModel(providerName);
      const provider = await getSladProvider(providerName, apiKey ?? undefined);
      const spinner = ora("…").start();
      let response: string;
      try {
        response = await provider.complete(
          [{ role: "user" as const, content: action.message }],
          { systemPrompt: CHAT_SYSTEM, temperature: 0.7, maxTokens: 2048, model },
        );
      } catch (err) {
        spinner.fail("Error al consultar el modelo");
        log.error((err as Error).message);
        break;
      }
      spinner.stop();
      console.log("");
      console.log(response.split("\n").map(l => `  ${l}`).join("\n"));
      break;
    }

    case "explore": {
      if (!session) {
        session = createSession(action.intent);
        log.dim(`  sesión creada: ${session.id}`);
      }
      await safeCall(() => exploreCommand(action.intent, base));
      break;
    }

    case "snapshot":
      await safeCall(() => snapshotCommand(base));
      break;

    case "plan":
      await safeCall(() => planCommand(base));
      break;

    case "run-auto":
      await safeCall(() => runCommand({ ...base, auto: true }));
      break;

    case "run-task":
      await safeCall(() => runCommand({ ...base, task: action.taskId }));
      break;

    case "run-next":
      await safeCall(() => runCommand(base));
      break;

    case "learn":
      await safeCall(() => learnCommand(base));
      break;

    case "evolve":
      await safeCall(() => evolveCommand(base));
      break;

    case "auto":
      await safeCall(() =>
        autoCommand(action.intent, {
          provider: opts.provider,
          agent: opts.agent,
          model: opts.model,
        }),
      );
      break;

    case "status":
      await sessionShowCommand();
      break;

    case "new": {
      const confirmed = await select({
        message: "¿Empezar una nueva sesión?",
        choices: [
          { name: "Sí, nueva sesión", value: true },
          { name: "No, continuar con la actual", value: false },
        ],
      });
      if (confirmed) {
        const newIntent = await input({ message: "Intención para la nueva sesión:" });
        if (newIntent.trim()) {
          session = createSession(newIntent.trim());
          log.success(`Sesión creada: ${session.id}`);
          await safeCall(() => exploreCommand(newIntent.trim(), base));
        }
      }
      break;
    }

    case "help":
      printHelp();
      break;

    case "exit":
      break;

    case "unknown":
      console.log(
        "\n  " +
        kleur.yellow(`No entendí "${action.input}".`) +
        kleur.dim(' Usa /help para ver los comandos disponibles.') +
        "\n"
      );
      break;
  }

  return getActiveSessionId() ? getActiveSession() : session;
}

// ─── main REPL ────────────────────────────────────────────────────────────────

export async function chatCommand(opts: ChatOpts): Promise<void> {
  const config = loadConfig();
  resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);

  const version = await getFormattedCliVersion();
  let session = getActiveSession();

  // Full-width header
  console.log(makeHeader(version));
  printSessionInfo(session);

  // Setup flow: ask for provider/key if nothing is configured
  await runSetupIfNeeded();

  process.on("SIGINT", () => {
    console.log(kleur.dim("\n\nHasta luego."))
    ORIGINAL_PROCESS_EXIT(0);
  });

  while (true) {
    let userInput: string;
    try {
      // Print top line, blank prompt line, bottom line, then move cursor up 2
      // so the prompt overwrites the blank line — giving a framed input area.
      process.stdout.write(`${line()}\n\n${line()}\n\x1B[2A`);
      userInput = await input({
        message: kleur.cyan("❯"),
        theme: { prefix: "" },
      });
      // After the user submits, erase the bottom frame line so the response
      // appears cleanly outside the frame (not between two lines).
      process.stdout.write("\x1B[1A\x1B[2K");
    } catch {
      console.log(kleur.dim("\n\nHasta luego."))
      break;
    }

    const action = parseAction(userInput, session);

    if (action.type === "exit") {
      console.log(kleur.dim("\n\nHasta luego."))
      break;
    }

    session = await executeAction(action, opts, session);

    // Show pipeline hint only after pipeline actions, not after plain chat messages
    const isPipelineAction = ["explore", "snapshot", "plan", "run-auto", "run-task", "run-next", "learn", "evolve", "auto"].includes(action.type);
    if (isPipelineAction) {
      session = getActiveSessionId() ? getActiveSession() : session;
      console.log("");
      console.log("  " + suggestNext(session));
      console.log("");
    }
  }
}
