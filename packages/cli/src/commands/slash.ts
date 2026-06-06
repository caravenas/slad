import { search } from "@inquirer/prompts";
import kleur from "kleur";
import {
  SLASH_COMMAND_CATALOG,
  SlashCommand,
  renderSlashCommandSignature,
  type SlashCommand as SlashCommandDefinition,
} from "@slad/shared";
import {
  CliSlashCommandPayload,
  type CliSlashCommandHandlerResult,
  type SessionState,
} from "../core/types.js";

export type CliSlashLocalAction =
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
  | { type: "auto-debate"; intent: string }
  | { type: "status" }
  | { type: "stats" }
  | { type: "version" }
  | { type: "model" }
  | { type: "agents" }
  | { type: "agents-use"; id: string }
  | { type: "new" }
  | { type: "help" }
  | { type: "exit" };

export type CliSlashCommandContext = {
  command: SlashCommandDefinition;
  session: SessionState | null;
};

export type CliSlashCommandResult = CliSlashCommandHandlerResult<CliSlashLocalAction> & {
  command: SlashCommandDefinition;
  payload: CliSlashCommandPayload;
};

type CliSlashCommandHandlerWithContext = (
  payload: CliSlashCommandPayload,
  context: CliSlashCommandContext,
) => CliSlashCommandHandlerResult<CliSlashLocalAction>;

const noSessionMessage = "Este comando necesita una sesión activa. Crea una sesión o ejecuta /auto con una intención.";

const cliSlashCommandHandlers = {
  ask: () => ({ sessionMessage: "Escribe tu pregunta como mensaje directo en el chat." }),
  chat: () => ({ sessionMessage: "Ya estás en el modo conversacional. Escribe tu mensaje y presiona Enter." }),
  auto: () => ({ localAction: { type: "run-auto" } }),
  "work-debate": (_payload, context) =>
    context.session
      ? { localAction: { type: "auto-debate", intent: context.session.intent } }
      : { sessionMessage: noSessionMessage },
  explore: (_payload, context) =>
    context.session
      ? { localAction: { type: "explore", intent: context.session.intent } }
      : { sessionMessage: "Para explorar una idea nueva, escribe /explore seguido de la intención." },
  snapshot: () => ({ localAction: { type: "snapshot" } }),
  plan: () => ({ localAction: { type: "plan" } }),
  run: () => ({ localAction: { type: "run-next" } }),
  learn: () => ({ localAction: { type: "learn" } }),
  evolve: () => ({ localAction: { type: "evolve" } }),
  status: () => ({ localAction: { type: "status" } }),
  new: () => ({ localAction: { type: "new" } }),
  stats: () => ({ localAction: { type: "stats" } }),
  version: () => ({ localAction: { type: "version" } }),
  model: () => ({ localAction: { type: "model" } }),
  agents: () => ({ localAction: { type: "agents" } }),
  help: () => ({ localAction: { type: "help" } }),
  exit: () => ({ localAction: { type: "exit" } }),
} satisfies Record<string, CliSlashCommandHandlerWithContext>;

const cliSlashCommandHandlerIds = new Set(Object.keys(cliSlashCommandHandlers));
const cliSlashCommandRuntimeRequirements: Partial<Record<string, { requiresActiveSession?: boolean; requiresPlan?: boolean }>> = {
  "work-debate": { requiresActiveSession: true },
};

export function getCliSlashHandlerIds(): string[] {
  return [...cliSlashCommandHandlerIds].sort();
}

export function isInformationalSlashCommand(command: SlashCommandDefinition): boolean {
  return (
    command.metadata.source === "informational" ||
    command.metadata.keywords.includes("informational") ||
    (command.executionIntent.kind === "session-message" &&
      command.executionIntent.emitsSessionMessage &&
      !command.executionIntent.invokesLocalAction)
  );
}

export function isVisibleCliSlashCommand(command: SlashCommandDefinition): boolean {
  if (!command.surfaces.includes("cli")) return false;
  const visible = !command.visibility.hidden && command.visibility.enabledByDefault;
  if (!visible && !isInformationalSlashCommand(command)) return false;
  return cliSlashCommandHandlerIds.has(command.id) || isInformationalSlashCommand(command);
}

export function getVisibleCliSlashCommands(
  catalog: readonly SlashCommandDefinition[] = SLASH_COMMAND_CATALOG,
): SlashCommandDefinition[] {
  return catalog.filter(isVisibleCliSlashCommand);
}

function sessionHasArtifact(session: SessionState | null, kind: string): boolean {
  return session?.artifacts.some((artifact) => artifact.kind === kind) ?? false;
}

export function isAvailableCliSlashCommand(
  command: SlashCommandDefinition,
  session: SessionState | null,
): boolean {
  if (!isVisibleCliSlashCommand(command)) return false;
  const runtimeRequirements = cliSlashCommandRuntimeRequirements[command.id];
  const requiresActiveSession = command.config.requiresActiveSession || runtimeRequirements?.requiresActiveSession;
  const requiresPlan = command.config.requiresPlan || runtimeRequirements?.requiresPlan;

  if (requiresActiveSession && !session) return false;
  if (requiresPlan && !sessionHasArtifact(session, "plan")) return false;
  return true;
}

export function getAvailableCliSlashCommands(
  session: SessionState | null,
  catalog: readonly SlashCommandDefinition[] = SLASH_COMMAND_CATALOG,
): SlashCommandDefinition[] {
  return catalog.filter((command) => isAvailableCliSlashCommand(command, session));
}

function normalizeSearchTerm(value: string): string {
  return value.trim().replace(/^\//, "").toLocaleLowerCase();
}

function commandSearchFields(command: SlashCommandDefinition): string[] {
  return [
    command.id,
    command.title,
    command.category,
    ...command.aliases,
    ...command.metadata.keywords,
  ];
}

export function searchCliSlashCommands(
  query: string,
  catalog: readonly SlashCommandDefinition[] = SLASH_COMMAND_CATALOG,
): SlashCommandDefinition[] {
  const commands = getVisibleCliSlashCommands(catalog);
  const normalized = normalizeSearchTerm(query);
  if (!normalized) return commands;

  return commands.filter((command) =>
    commandSearchFields(command).some((field) => field.toLocaleLowerCase().includes(normalized)),
  );
}

export function searchAvailableCliSlashCommands(
  query: string,
  session: SessionState | null,
  catalog: readonly SlashCommandDefinition[] = SLASH_COMMAND_CATALOG,
): SlashCommandDefinition[] {
  const commands = getAvailableCliSlashCommands(session, catalog);
  const normalized = normalizeSearchTerm(query);
  if (!normalized) return commands;

  return commands.filter((command) =>
    commandSearchFields(command).some((field) => field.toLocaleLowerCase().includes(normalized)),
  );
}

export function findCliSlashCommand(
  input: string,
  catalog: readonly SlashCommandDefinition[] = SLASH_COMMAND_CATALOG,
): SlashCommandDefinition | null {
  const normalized = normalizeSearchTerm(input);
  if (!normalized) return null;

  return (
    getVisibleCliSlashCommands(catalog).find(
      (command) =>
        command.id.toLocaleLowerCase() === normalized ||
        command.aliases.some((alias) => alias.toLocaleLowerCase() === normalized),
    ) ?? null
  );
}

export function validateInitialCliSlashCommandPayload(command: SlashCommandDefinition): CliSlashCommandPayload {
  const parsedCommand = SlashCommand.parse(command);
  const payload = CliSlashCommandPayload.parse({ commandId: parsedCommand.id, args: {} });

  if (parsedCommand.args.length > 0) {
    throw new Error(`El comando /${parsedCommand.id} requiere argumentos y todavía no puede ejecutarse desde la paleta.`);
  }

  return payload;
}

export function resolveCliSlashCommand(
  command: SlashCommandDefinition,
  session: SessionState | null,
): CliSlashCommandResult {
  const payload = validateInitialCliSlashCommandPayload(command);
  const handler = cliSlashCommandHandlers[command.id as keyof typeof cliSlashCommandHandlers] as
    | CliSlashCommandHandlerWithContext
    | undefined;

  if (!handler) {
    if (isInformationalSlashCommand(command)) {
      return { command, payload, sessionMessage: command.description };
    }
    throw new Error(`No hay handler CLI registrado para /${command.id}.`);
  }

  const result = handler(payload, { command, session }) as CliSlashCommandHandlerResult<CliSlashLocalAction>;
  return { command, payload, ...result };
}

export function resolveCliSlashInput(input: string, session: SessionState | null): CliSlashCommandResult | null {
  const command = findCliSlashCommand(input);
  return command ? resolveCliSlashCommand(command, session) : null;
}

export function buildCliSlashCommandInsertion(command: SlashCommandDefinition): string {
  return command.args.length > 0 ? `/${command.id} ` : `/${command.id}`;
}

function renderCliSlashCommandPaletteName(command: SlashCommandDefinition): string {
  const signature = renderSlashCommandSignature(command);
  return `${kleur.cyan(signature.padEnd(18))} ${kleur.white(command.title)} ${kleur.dim(`· ${command.description}`)}`;
}

export async function openCliSlashCommandPalette(
  initialQuery = "",
  session: SessionState | null = null,
): Promise<string | null> {
  try {
    return await search<string>({
      message: "Comando",
      source: async (term) =>
        searchAvailableCliSlashCommands(term ?? initialQuery, session).map((command) => ({
          name: renderCliSlashCommandPaletteName(command),
          value: buildCliSlashCommandInsertion(command),
          description: `${renderSlashCommandSignature(command)} · ${command.category}`,
        })),
    });
  } catch {
    return null;
  }
}
