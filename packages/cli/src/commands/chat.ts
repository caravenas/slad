import readline from "node:readline";
import ora from "ora";
import kleur from "kleur";
import { input as promptInput, select } from "@inquirer/prompts";
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
import { statsCommand } from "./stats.js";
import { sessionShowCommand } from "./session.js";
import { makeHeader } from "../cli/ui.js";
import { getFormattedCliVersion } from "../cli/version.js";
import { runSetupIfNeeded } from "../core/setup.js";
import {
  findCliSlashCommand,
  getVisibleCliSlashCommands,
  openCliSlashCommandPalette,
  resolveCliSlashCommand,
  resolveCliSlashInput,
  type CliSlashLocalAction,
} from "./slash.js";

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

// function line(char = "─", color: (s: string) => string = kleur.dim): string {
//   const width = process.stdout.columns || 80;
//   return color(char.repeat(width));
// }

// ─── routing ──────────────────────────────────────────────────────────────────

type ChatAction =
  | CliSlashLocalAction
  | { type: "unknown"; input: string };

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
      if (command.id === "run" && /^T\d+$/i.test(tail)) return { type: "run-task", taskId: tail.toUpperCase() };
      if (command.id === "run" && /^(--auto|auto|todo)$/i.test(tail)) return { type: "run-auto" };
      if (command.id === "auto" && tail) return { type: "auto", intent: tail };
      if (command.id === "work-debate" && tail) return { type: "auto-debate", intent: tail };
      if (command.id === "explore" && tail) return { type: "explore", intent: tail };
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

async function readChatPrompt(
  defaultValue: string | undefined,
  session: SessionState | null,
  openPalette: typeof openCliSlashCommandPalette = openCliSlashCommandPalette,
  inputStream: ChatInputStream = process.stdin,
  outputStream: ChatOutputStream = process.stdout,
): Promise<ChatInputPromptResult> {
  if (!inputStream.isTTY || !outputStream.isTTY || !inputStream.setRawMode) {
    const value = await promptInput({
      message: kleur.cyan("❯"),
      default: defaultValue,
      theme: { prefix: "" },
    });
    return { type: "input", value };
  }

  const prompt = `${kleur.cyan("❯")} `;
  let value = defaultValue ?? "";
  const wasRaw = inputStream.isRaw ?? false;

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

    const render = (): void => {
      readline.clearLine(outputStream, 0);
      readline.cursorTo(outputStream, 0);
      outputStream.write(prompt + value);
    };

    const openSlashPalette = async (): Promise<void> => {
      cleanup();
      outputStream.write("/\n");
      try {
        const insertion = await openPalette("", session);
        resolve({ type: "palette", insertion });
      } catch {
        resolve({ type: "palette", insertion: null });
      }
    };

    const onKeypress = (sequence: string | undefined, key: KeypressInfo = {}): void => {
      if (settled) return;

      if (key.ctrl && key.name === "c") {
        outputStream.write("\n");
        fail(new Error("SIGINT"));
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        outputStream.write("\n");
        settle({ type: "input", value });
        return;
      }

      if (shouldOpenSlashPaletteImmediately(value, sequence, key)) {
        settled = true;
        void openSlashPalette();
        return;
      }

      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        render();
        return;
      }

      if (key.ctrl && key.name === "u") {
        value = "";
        render();
        return;
      }

      if (
        !sequence ||
        key.ctrl ||
        key.meta ||
        key.name === "up" ||
        key.name === "down" ||
        key.name === "left" ||
        key.name === "right"
      ) {
        return;
      }

      const printable = [...sequence].filter((char) => char >= " " && char !== "\x7f").join("");
      if (!printable) return;
      value += printable;
      render();
    };

    readline.emitKeypressEvents(inputStream);
    inputStream.setRawMode(true);
    inputStream.resume();
    inputStream.on("keypress", onKeypress);
    outputStream.write(prompt + value);
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

function printHelp(): void {
  const w = 22;
  const cmds: [string, string][] = [
    ["<mensaje>", "Chat directo con el modelo (modo por defecto)"],
    ...getVisibleCliSlashCommands().map((command): [string, string] => [`/${command.id}`, command.description]),
  ];
  console.log("");
  console.log(kleur.bold("  Comandos disponibles:"));
  console.log("");
  cmds.forEach(([cmd, desc]) => {
    console.log("  " + kleur.cyan(cmd.padEnd(w)) + kleur.dim(desc));
  });
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
      const apiKey = getApiKey(providerName);
      const model = opts.model ?? getModel(providerName);
      const provider = await getSladProvider(providerName, apiKey ?? undefined);

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

  while (true) {
    let userInput: string;
    try {
      const promptResult = await readChatPrompt(nextInputDefault, session);
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

    const slashResult =
      trimmedInput !== "/" && trimmedInput.startsWith("/") ? resolveCliSlashInput(userInput, session) : null;
    const resolvedSlash = slashResult;

    if (resolvedSlash?.sessionMessage) {
      console.log("\n  " + kleur.dim(resolvedSlash.sessionMessage) + "\n");
    }

    if (resolvedSlash && !resolvedSlash.localAction) continue;

    const action = resolvedSlash?.localAction ?? parseAction(userInput, session);

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
