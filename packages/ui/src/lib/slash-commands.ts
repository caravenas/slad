import {
  SLASH_COMMAND_CATALOG,
  SlashCommand as SlashCommandSchema,
  SlashCommandCatalog,
} from "@slad/shared";
import type { SlashCommand as SharedSlashCommand } from "@slad/shared";
import type {
  UISlashCommandAvailability,
  UISlashCommandContext,
  UISlashCommandHandlerMap,
  UISlashCommandPaletteItem,
  UISlashCommandResult,
} from "./types";

const UI_COMMANDS = SlashCommandCatalog.parse(SLASH_COMMAND_CATALOG);

function normalized(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function matchCommand(command: SharedSlashCommand, rawQuery: string): UISlashCommandPaletteItem["matchedBy"] | null {
  const query = normalized(rawQuery);
  if (!query) return "all";
  if (command.id.toLowerCase().includes(query)) return "id";
  if (command.title.toLowerCase().includes(query)) return "title";
  if (command.aliases.some((alias) => alias.toLowerCase().includes(query))) return "alias";
  if (command.category.toLowerCase().includes(query)) return "category";
  if ((command.metadata.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(query))) return "keyword";
  return null;
}

export function getUiSlashCommandAvailability(
  command: SharedSlashCommand,
  context: UISlashCommandContext = {},
): UISlashCommandAvailability {
  if (!command.surfaces.includes("ui")) {
    return { visible: false, executable: false, reason: "No soportado en UI." };
  }
  if (command.visibility.hidden || !command.visibility.enabledByDefault) {
    return { visible: false, executable: false, reason: "Comando oculto." };
  }
  if (command.visibility.experimental && !context.allowExperimental) {
    return { visible: false, executable: false, reason: "Comando experimental." };
  }
  if (!command.metadata.uiHandler && command.executionIntent.invokesLocalAction) {
    return { visible: false, executable: false, reason: "Sin handler UI." };
  }
  if (command.config.requiresActiveSession && !context.activeSessionId) {
    return { visible: true, executable: false, reason: "Requiere una sesion activa." };
  }
  if (command.config.requiresWorkspaceTrust && !context.hasWorkspaceTrust) {
    return { visible: true, executable: false, reason: "Requiere confiar en el workspace." };
  }
  if (command.config.requiresProvider && !context.hasProvider) {
    return { visible: true, executable: false, reason: "Requiere un provider configurado." };
  }
  if (command.config.requiresPlan && !context.hasPlan) {
    return { visible: true, executable: false, reason: "Requiere un plan disponible." };
  }
  return { visible: true, executable: true };
}

export function getUiSlashCommandItems(
  rawQuery: string,
  context: UISlashCommandContext = {},
): UISlashCommandPaletteItem[] {
  return UI_COMMANDS.flatMap((command) => {
    const availability = getUiSlashCommandAvailability(command, context);
    const matchedBy = matchCommand(command, rawQuery);
    if (!availability.visible || !matchedBy) return [];
    return [{ command, availability, matchedBy }];
  });
}

export async function executeUiSlashCommand(
  command: SharedSlashCommand,
  handlers: UISlashCommandHandlerMap,
): Promise<UISlashCommandResult> {
  const parsed = SlashCommandSchema.safeParse(command);
  if (!parsed.success) {
    return {
      ok: false,
      status: "validation-error",
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  if (parsed.data.args.some((arg) => arg.required)) {
    return {
      ok: false,
      status: "validation-error",
      message: "Este comando requiere argumentos y la palette aun no acepta argumentos.",
    };
  }

  const handler = handlers[parsed.data.id];
  if (!handler) {
    return {
      ok: false,
      status: "not-executable",
      message: "Comando informativo: no hay accion local disponible.",
    };
  }

  const result = await handler(parsed.data);
  return result ?? { ok: true, status: "executed" };
}
