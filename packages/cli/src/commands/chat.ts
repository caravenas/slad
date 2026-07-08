import readline from "node:readline";
import ora from "ora";
import kleur from "kleur";
import { input as promptInput, select } from "@inquirer/prompts";
import { loadConfig, resolveProvider, getModel, getActiveAgentId } from "../core/config.js";
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
import { renderSlashCommandSignature } from "@slad/shared";
import { autoCommand } from "./auto.js";
import { modelCommand } from "./model.js";
import { statsCommand } from "./stats.js";
import { selectAgentInteractive } from "./agents.js";
import { classifyIntent } from "../core/classifier.js";
import { setActiveAgent, type AgentRuntime } from "../agents/registry.js";
import { sessionShowCommand } from "./session.js";
import { makeHeader } from "../cli/ui.js";
import { getFormattedCliVersion } from "../cli/version.js";
import { runSetupIfNeeded } from "../core/setup.js";
import {
  buildCliSlashCommandInsertion,
  findCliSlashCommand,
  getVisibleCliSlashCommands,
  openCliSlashCommandPalette,
  resolveCliSlashCommand,
  resolveCliSlashInput,
  searchAvailableCliSlashCommands,
  type CliSlashLocalAction,
} from "./slash.js";
import {
  buildPromptFrame,
  clampSelection,
  renderSubmittedLine,
  type PromptSlashItem,
} from "./chat-prompt.js";

const CHAT_SYSTEM = `Eres un asistente técnico experto en construir agentes con SLAD (un Agent Construction Kit).
Responde de forma directa, concisa y útil en el idioma del usuario.
Si el usuario quiere construir un agente, tool, stage o pipeline, sugerile /create <kind> <nombre> (ej. /create agent miagente).
Si quiere implementar una feature de software end-to-end, sugerile /auto "<intención>" para ejecutar el pipeline completo.`;

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

// function line(char = "─", color: (s: string) => string = kleur.dim): string {
//   const width = process.stdout.columns || 80;
//   return color(char.repeat(width));
// }

// ─── routing ──────────────────────────────────────────────────────────────────

type ChatAction =
  | CliSlashLocalAction
  | { type: "unknown"; input: string };

function parseAutoTail(tail: string, session: SessionState | null): ChatAction | null {
  const parts = tail.split(/\s+/).filter(Boolean);
  const dryRun = parts.includes("--dry-run");
  const intent = parts.filter((part) => part !== "--dry-run").join(" ").trim() || session?.intent;
  return intent ? { type: "auto", intent, ...(dryRun ? { dryRun } : {}) } : null;
}

function parseRunTail(tail: string): ChatAction | null {
  if (!tail) return { type: "run-next" };
  const parts = tail.split(/\s+/).filter(Boolean);
  const parallel = parts.includes("--parallel");
  const rest = parts.filter((part) => part !== "--parallel");

  if (rest.length === 0) return { type: "run-next", ...(parallel ? { parallel } : {}) };
  if (rest.length === 1 && /^T\d+$/i.test(rest[0]!)) {
    if (parallel) return null;
    return { type: "run-task", taskId: rest[0]!.toUpperCase() };
  }
  if (!parallel && rest.length === 1 && /^(--auto|auto|todo)$/i.test(rest[0]!)) return { type: "run-auto" };
  return null;
}

function hasArtifact(session: SessionState | null, kind: string): boolean {
  return session?.artifacts.some((a: { kind: string }) => a.kind === kind) ?? false;
}

export function parseAction(raw: string, _session: SessionState | null): ChatAction {
  const trimmed = raw.trim();
  if (!trimmed) return { type: "chat", message: "" };

  if (trimmed.startsWith("/")) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) return { type: "unknown", input: trimmed };

    const [head, ...tailParts] = cmd.split(/\s+/);
    const tail = tailParts.join(" ").trim();
    const command = head ? findCliSlashCommand(head) : null;

    if (/^T\d+$/i.test(cmd)) return { type: "run-task", taskId: cmd.toUpperCase() };

    if (command) {
      if (command.id === "run") return parseRunTail(tail) ?? { type: "unknown", input: trimmed };
      if (command.id === "auto") return parseAutoTail(tail, _session) ?? { type: "unknown", input: trimmed };
      if (command.id === "work-debate" && tail) return { type: "auto-debate", intent: tail };
      if (command.id === "explore" && tail) return { type: "explore", intent: tail };
      if (command.id === "agents") {
        const useMatch = tail.match(/^use\s+(\S+)$/i);
        if (useMatch) return { type: "agents-use", id: useMatch[1]! };
        if (!tail) return { type: "agents" };
        return { type: "unknown", input: trimmed };
      }
      if (tail) return { type: "unknown", input: trimmed };

      const result = resolveCliSlashCommand(command, _session);
      return result.localAction ?? { type: "unknown", input: trimmed };
    }

    return { type: "unknown", input: trimmed };
  }

  // Plain text → direct model chat (default mode)
  return { type: "chat", message: trimmed };
}

export function suggestNext(session: SessionState | null): string {
  if (!session || !hasArtifact(session, "explore")) {
    return (
      kleur.dim("Construí con ") +
      kleur.cyan("/create agent <nombre>") +
      kleur.dim(", escribí para chatear, o ") +
      kleur.cyan("/auto \"<intención>\"") +
      kleur.dim(" para el pipeline.")
    );
  }
  if (!hasArtifact(session, "snapshot")) return kleur.dim("Pipeline → ") + kleur.cyan("/snapshot");
  if (!hasArtifact(session, "plan")) return kleur.dim("Pipeline → ") + kleur.cyan("/plan");
  if (!hasArtifact(session, "run")) return kleur.dim("Pipeline → ") + kleur.cyan("/run") + kleur.dim(" o ") + kleur.cyan("/run T1");
  if (!hasArtifact(session, "learn")) return kleur.dim("Pipeline → ") + kleur.cyan("/learn");
  return kleur.dim("Pipeline → ") + kleur.cyan("/evolve") + kleur.dim(" o escribe para seguir chateando.");
}

export type SlashPaletteTriggerResult =
  | { opened: false }
  | { opened: true; insertion: string | null };

type KeypressInfo = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
};

type ChatInputStream = NodeJS.ReadStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

type ChatOutputStream = NodeJS.WriteStream & {
  isTTY?: boolean;
};

type ChatInputPromptResult =
  | { type: "input"; value: string }
  | { type: "palette"; insertion: string | null };

export function shouldOpenSlashPaletteImmediately(
  currentValue: string,
  sequence: string | undefined,
  key: KeypressInfo = {},
): boolean {
  return currentValue.length === 0 && !key.ctrl && !key.meta && (sequence === "/" || key.name === "slash");
}

export async function maybeOpenSlashPalette(
  rawInput: string,
  session: SessionState | null,
  openPalette: typeof openCliSlashCommandPalette = openCliSlashCommandPalette,
): Promise<SlashPaletteTriggerResult> {
  if (rawInput.trim() !== "/") return { opened: false };
  return { opened: true, insertion: await openPalette("", session) };
}

/** Inline slash-command suggestions for the current input (empty if not in slash mode). */
function computeSlashSuggestions(value: string, session: SessionState | null): PromptSlashItem[] {
  if (!value.startsWith("/") || value.includes(" ")) return [];
  return searchAvailableCliSlashCommands(value, session).map((command) => ({
    insertion: buildCliSlashCommandInsertion(command),
    signature: renderSlashCommandSignature(command),
    description: command.description,
    hasArgs: command.args.length > 0,
  }));
}

async function readChatPrompt(
  defaultValue: string | undefined,
  session: SessionState | null,
  agentLabel?: string,
  inputStream: ChatInputStream = process.stdin,
  outputStream: ChatOutputStream = process.stdout,
): Promise<ChatInputPromptResult> {
  const indicator = agentLabel ? `${kleur.magenta(agentLabel)} ${kleur.cyan("❯")}` : kleur.cyan("❯");
  if (!inputStream.isTTY || !outputStream.isTTY || !inputStream.setRawMode) {
    const value = await promptInput({
      message: indicator,
      default: defaultValue,
      theme: { prefix: "" },
    });
    return { type: "input", value };
  }

  let value = defaultValue ?? "";
  let selected = 0;
  let slashClosed = false;
  let suggestions: PromptSlashItem[] = [];
  const wasRaw = inputStream.isRaw ?? false;
  let painted = false;

  return new Promise<ChatInputPromptResult>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      inputStream.off("keypress", onKeypress);
      inputStream.setRawMode?.(wasRaw);
    };

    const settle = (result: ChatInputPromptResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const recompute = (): void => {
      suggestions = slashClosed ? [] : computeSlashSuggestions(value, session);
      selected = clampSelection(selected, suggestions.length);
    };

    // Draw the boxed frame and leave the cursor on the input line. The input
    // line is always frame line index 1, so a repaint just moves up to the top
    // rule, clears to end of screen, and redraws everything.
    const paint = (): void => {
      const frame = buildPromptFrame({
        value,
        promptPrefix: indicator,
        width: outputStream.columns ?? 80,
        suggestions,
        selected,
      });
      if (painted) {
        readline.moveCursor(outputStream, 0, -frame.inputLineIndex);
        readline.cursorTo(outputStream, 0);
        outputStream.write("\x1b[0J");
      }
      outputStream.write(frame.lines.join("\n"));
      const lastIndex = frame.lines.length - 1;
      readline.moveCursor(outputStream, 0, -(lastIndex - frame.inputLineIndex));
      readline.cursorTo(outputStream, frame.cursorCol);
      painted = true;
    };

    // Remove the whole frame (cursor is on the input line → go up to the top rule).
    const clearFrame = (): void => {
      readline.moveCursor(outputStream, 0, -1);
      readline.cursorTo(outputStream, 0);
      outputStream.write("\x1b[0J");
    };

    const submit = (): void => {
      clearFrame();
      const line = renderSubmittedLine(value);
      if (line) outputStream.write(`${line}\n`);
      settle({ type: "input", value });
    };

    const onKeypress = (sequence: string | undefined, key: KeypressInfo = {}): void => {
      if (settled) return;

      if (key.ctrl && key.name === "c") {
        clearFrame();
        outputStream.write("\n");
        fail(new Error("SIGINT"));
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        // In slash mode, Enter applies the highlighted command first.
        if (suggestions.length > 0 && value.startsWith("/") && !value.includes(" ")) {
          const pick = suggestions[selected];
          if (pick) {
            value = pick.insertion;
            if (pick.hasArgs) {
              slashClosed = false;
              recompute();
              paint();
              return;
            }
            value = value.trim();
          }
        }
        submit();
        return;
      }

      if (key.name === "tab") {
        if (suggestions.length > 0) {
          const pick = suggestions[selected];
          if (pick) {
            value = pick.insertion;
            slashClosed = false;
            recompute();
            paint();
          }
        }
        return;
      }

      if (key.name === "escape") {
        if (suggestions.length > 0) {
          slashClosed = true;
          recompute();
          paint();
        }
        return;
      }

      if ((key.name === "up" || key.name === "down") && suggestions.length > 0) {
        selected = clampSelection(selected + (key.name === "down" ? 1 : -1), suggestions.length);
        paint();
        return;
      }

      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        slashClosed = false;
        recompute();
        paint();
        return;
      }

      if (key.ctrl && key.name === "u") {
        value = "";
        slashClosed = false;
        recompute();
        paint();
        return;
      }

      if (!sequence || key.ctrl || key.meta || key.name === "left" || key.name === "right") {
        return;
      }

      const printable = [...sequence].filter((char) => char >= " " && char !== "\x7f").join("");
      if (!printable) return;
      value += printable;
      slashClosed = false;
      recompute();
      paint();
    };

    recompute();
    readline.emitKeypressEvents(inputStream);
    inputStream.setRawMode(true);
    inputStream.resume();
    inputStream.on("keypress", onKeypress);
    paint();
  });
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

const HELP_CATEGORY_ORDER = ["kit", "chat", "pipeline", "session", "observability", "meta"] as const;
const HELP_CATEGORY_LABELS: Record<string, string> = {
  kit: "Construir (Agent Kit)",
  chat: "Conversación",
  pipeline: "Pipeline (avanzado)",
  session: "Sesión",
  observability: "Observabilidad",
  meta: "Meta",
};

function printHelp(): void {
  const w = 26;
  const commands = getVisibleCliSlashCommands();
  console.log("");
  console.log(kleur.bold("  Comandos disponibles:"));
  console.log("");
  console.log("  " + kleur.cyan("<mensaje>".padEnd(w)) + kleur.dim("Chat directo con el modelo (modo por defecto)"));

  for (const category of HELP_CATEGORY_ORDER) {
    const inCategory = commands.filter((command) => command.category === category);
    if (inCategory.length === 0) continue;
    console.log("");
    console.log("  " + kleur.bold(HELP_CATEGORY_LABELS[category] ?? category));
    for (const command of inCategory) {
      const signature = renderSlashCommandSignature(command);
      console.log("  " + kleur.cyan(signature.padEnd(w)) + kleur.dim(command.description));
    }
  }
  console.log(kleur.dim("\n  Escribe / para abrir la lista filtrable de comandos."));
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
      // console.log(kleur.dim(`\n  ${answers.split("\n").join("\n  ")}`));
      console.log(answers);
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
      const model = opts.model ?? getModel(providerName);
      const provider = await getSladProvider(providerName);

      // Smart routing: classify longer messages to detect pipeline intents.
      if (action.message.length > 20) {
        const routing = await classifyIntent(action.message, provider as any).catch(() => null);
        if (routing?.mode === "work" && routing.confidence >= 0.75) {
          const pct = Math.round(routing.confidence * 100);
          console.log(kleur.dim(`\n  → ${routing.rationale} (${pct}%)`));
          const go = await select({
            message: "¿Cómo continuar?",
            choices: [
              { name: "Ejecutar pipeline", value: true },
              { name: "Solo responder", value: false },
            ],
          });
          if (go) {
            await safeCall(() => autoCommand(action.message, {
              provider: opts.provider, agent: opts.agent, model: opts.model, classify: false,
            }));
            session = getActiveSessionId() ? getActiveSession() : session;
            break;
          }
        }
      }

      const startTime = Date.now();
      const spinner = ora({ text: kleur.dim("…"), color: "cyan" }).start();
      try {
        if (provider.stream) {
          let firstChunk = true;
          for await (const chunk of provider.stream(
            [{ role: "user" as const, content: action.message }],
            { systemPrompt: CHAT_SYSTEM, temperature: 0.7, maxTokens: 2048, model },
          )) {
            if (firstChunk) {
              spinner.stop();
              process.stdout.write("\n• ");
              firstChunk = false;
            }
            process.stdout.write(chunk.replace(/\n/g, "\n  "));
          }
          if (firstChunk) spinner.stop();
        } else {
          const response = await provider.complete(
            [{ role: "user" as const, content: action.message }],
            { systemPrompt: CHAT_SYSTEM, temperature: 0.7, maxTokens: 2048, model },
          );
          spinner.stop();
          const lines = response.split("\n");
          process.stdout.write("\n• " + lines[0]);
          for (let i = 1; i < lines.length; i++) {
            process.stdout.write("\n  " + lines[i]);
          }
        }
      } catch (err) {
        spinner.stop();
        process.stdout.write("\n");
        log.error((err as Error).message);
        break;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\n\n${kleur.dim(`* Cooked for ${elapsed}s`)}\n`);
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
      await safeCall(() => runCommand({ ...base, parallel: action.parallel }));
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
          dryRun: action.dryRun,
        }),
      );
      break;

    case "auto-debate":
      await safeCall(() =>
        autoCommand(action.intent, {
          provider: opts.provider,
          agent: opts.agent,
          model: opts.model,
          debate: true,
        }),
      );
      break;


    case "status":
      await sessionShowCommand();
      break;

    case "stats":
      await statsCommand();
      break;

    case "version":
      console.log(await getFormattedCliVersion());
      break;

    case "model":
      await modelCommand();
      break;

    case "agents":
    case "agents-use":
      // Handled in the REPL loop (interactive picker + agent mode).
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
        const newIntent = await promptInput({ message: "Intención para la nueva sesión:" });
        if (newIntent.trim()) {
          session = createSession(newIntent.trim());
          log.success(`Sesión creada: ${session.id}`);
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
  console.log("\n");

  // Setup flow: ask for provider/key if nothing is configured
  await runSetupIfNeeded();

  process.on("SIGINT", () => {
    console.log(kleur.dim("\n\nHasta luego."))
    ORIGINAL_PROCESS_EXIT(0);
  });

  let nextInputDefault: string | undefined;
  // When an agent is active, plain-text input is routed straight to its pipeline
  // (auto mode) instead of the chat model. null = normal chat mode.
  let agentMode: AgentRuntime | null = null;

  while (true) {
    let userInput: string;
    try {
      const promptResult = await readChatPrompt(nextInputDefault, session, agentMode?.descriptor.label);
      nextInputDefault = undefined;
      if (promptResult.type === "palette") {
        if (promptResult.insertion) nextInputDefault = promptResult.insertion;
        continue;
      }
      userInput = promptResult.value;
    } catch {
      console.log(kleur.dim("\n\nHasta luego."))
      break;
    }

    const trimmedInput = userInput.trim();
    const paletteTrigger = await maybeOpenSlashPalette(userInput, session);
    if (paletteTrigger.opened) {
      if (paletteTrigger.insertion) nextInputDefault = paletteTrigger.insertion;
      continue;
    }

    let slashResult: ReturnType<typeof resolveCliSlashInput> = null;
    if (trimmedInput !== "/" && trimmedInput.startsWith("/")) {
      try {
        slashResult = resolveCliSlashInput(userInput, session);
      } catch {
        // Commands with args (e.g. /create) can't resolve from the palette without
        // their arguments — fall through to parseAction, which parses them inline.
        slashResult = null;
      }
    }
    const resolvedSlash = slashResult;

    // /chat leaves agent mode and returns to the conversational model.
    if (agentMode && resolvedSlash?.command.id === "chat") {
      agentMode = null;
      console.log("\n  " + kleur.dim("Volviste al modo chat.") + "\n");
      continue;
    }

    if (resolvedSlash?.sessionMessage) {
      console.log("\n  " + kleur.dim(resolvedSlash.sessionMessage) + "\n");
    }

    if (resolvedSlash && !resolvedSlash.localAction) continue;

    const action = resolvedSlash?.localAction ?? parseAction(userInput, session);

    // /agents → interactive picker; selecting an agent activates it and enters
    // agent mode so the next prompt goes straight to the pipeline.
    if (action.type === "agents") {
      const picked = await selectAgentInteractive(agentMode?.descriptor.id ?? getActiveAgentId());
      if (picked) {
        agentMode = setActiveAgent(picked);
        log.success(`Agente activo: ${agentMode.descriptor.label}.`);
        console.log(
          "  " + kleur.dim("Escribe tu intención y Enter. ") +
          kleur.cyan("/chat") + kleur.dim(" para volver al chat · ") +
          kleur.cyan("/agents") + kleur.dim(" para cambiar.") + "\n",
        );
      }
      continue;
    }

    // /agents use <id> → activate directly and enter agent mode.
    if (action.type === "agents-use") {
      try {
        agentMode = setActiveAgent(action.id);
        log.success(`Agente activo: ${agentMode.descriptor.label}.`);
      } catch (err) {
        log.error((err as Error).message);
      }
      continue;
    }

    // In agent mode, plain text goes through the classifier first (same as a
    // direct /auto call), so conversational questions are answered directly.
    if (agentMode && action.type === "chat" && action.message) {
      await safeCall(() =>
        autoCommand(action.message, {
          provider: opts.provider,
          agent: opts.agent,
          model: opts.model,
        }),
      );
      session = getActiveSessionId() ? getActiveSession() : session;
      console.log("");
      console.log("  " + suggestNext(session));
      console.log("");
      continue;
    }

    if (action.type === "exit") {
      console.log(kleur.dim("\n\nHasta luego."))
      break;
    }

    session = await executeAction(action, opts, session);

    // Show pipeline hint only after pipeline actions, not after plain chat messages
    const isPipelineAction = [
      "explore",
      "snapshot",
      "plan",
      "run-auto",
      "run-task",
      "run-next",
      "learn",
      "evolve",
      "auto",
      "auto-debate",
    ].includes(action.type);
    if (isPipelineAction) {
      session = getActiveSessionId() ? getActiveSession() : session;
      console.log("");
      console.log("  " + suggestNext(session));
      console.log("");
    }
  }
}
