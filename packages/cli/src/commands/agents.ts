import kleur from "kleur";
import { select } from "@inquirer/prompts";
import { log } from "../core/logger.js";
import { getActiveAgentId } from "../core/config.js";
import { listAgents, setActiveAgent } from "../agents/registry.js";

/** Print all registered agents, marking the active one. */
export function agentsListCommand(): void {
  const activeId = getActiveAgentId();
  console.log("");
  console.log(kleur.bold("  Agentes disponibles:"));
  console.log("");
  for (const { descriptor } of listAgents()) {
    const isActive = descriptor.id === activeId;
    const marker = isActive ? kleur.green("●") : kleur.dim("○");
    const id = isActive ? kleur.green(descriptor.id) : kleur.cyan(descriptor.id);
    console.log(`  ${marker} ${id}  ${kleur.white(descriptor.label)}`);
    console.log(`     ${kleur.dim(descriptor.description)}`);
    console.log(`     ${kleur.dim("stages: " + descriptor.stages.join(" → "))}`);
    console.log("");
  }
  console.log(kleur.dim("  Cambia de agente con ") + kleur.cyan("/agents use <id>") + kleur.dim("."));
}

/**
 * Show an interactive menu to pick an agent. Returns the chosen agent id, or
 * null if the user cancelled (Ctrl+C / ESC).
 */
export async function selectAgentInteractive(currentId?: string): Promise<string | null> {
  const choices = listAgents().map(({ descriptor }) => ({
    name: `${descriptor.label}${descriptor.id === currentId ? kleur.dim(" (activo)") : ""} — ${kleur.dim(descriptor.description)}`,
    value: descriptor.id,
    description: `stages: ${descriptor.stages.join(" → ")}`,
  }));
  try {
    return await select({ message: "Selecciona un agente:", choices, ...(currentId ? { default: currentId } : {}) });
  } catch {
    return null;
  }
}

/** Switch the active agent and persist the choice. */
export function agentsUseCommand(id: string): void {
  try {
    const agent = setActiveAgent(id);
    log.success(`Agente activo: ${agent.descriptor.id} (${agent.descriptor.label})`);
  } catch (err) {
    log.error((err as Error).message);
  }
}
