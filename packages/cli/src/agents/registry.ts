import { AGENT_CATALOG, DEFAULT_AGENT_ID, type AgentDescriptor } from "@slad/shared";
import type { SladPrompts } from "@slad/pipeline";
import { getActiveAgentId, setActiveAgentId } from "../core/config.js";
import * as prompts from "./prompts.js";

/**
 * A runtime agent binds a serializable descriptor (id, label, stages — defined
 * in @slad/shared) to the concrete CLI prompts that drive its stages. This is
 * the seam that lets the interface select between agents instead of hardwiring
 * one pipeline. New agents are added here as config — no stage code changes.
 */
export interface AgentRuntime {
  descriptor: AgentDescriptor;
  prompts: SladPrompts;
}

const SOFTWARE_DEV_PROMPTS: SladPrompts = {
  explorer: prompts.EXPLORER_SYSTEM,
  snapshot: prompts.SNAPSHOT_SYSTEM,
  planner: prompts.PLANNER_SYSTEM,
  builderReviewer: prompts.BUILDER_REVIEWER_SYSTEM,
  arbiterExplore: prompts.ARBITER_EXPLORE_SYSTEM,
  arbiterPlan: prompts.ARBITER_PLAN_SYSTEM,
};

/** Maps each agent id from AGENT_CATALOG to its runtime prompts. */
const PROMPTS_BY_AGENT: Record<string, SladPrompts> = {
  developer: SOFTWARE_DEV_PROMPTS,
};

const AGENT_REGISTRY: Record<string, AgentRuntime> = Object.fromEntries(
  AGENT_CATALOG.map((descriptor) => [
    descriptor.id,
    { descriptor, prompts: PROMPTS_BY_AGENT[descriptor.id] ?? SOFTWARE_DEV_PROMPTS },
  ]),
);

/** All registered agents, in catalog order. */
export function listAgents(): AgentRuntime[] {
  return AGENT_CATALOG.map((d) => AGENT_REGISTRY[d.id]!);
}

/** Look up an agent by id, or null if unknown. */
export function getAgent(id: string): AgentRuntime | null {
  return AGENT_REGISTRY[id] ?? null;
}

/** The currently active agent (from global config), falling back to developer. */
export function getActiveAgent(): AgentRuntime {
  const id = getActiveAgentId();
  return AGENT_REGISTRY[id] ?? AGENT_REGISTRY[DEFAULT_AGENT_ID]!;
}

/** Persist the active agent. Throws if the id is unknown. */
export function setActiveAgent(id: string): AgentRuntime {
  const agent = getAgent(id);
  if (!agent) {
    throw new Error(`Agente desconocido: "${id}". Usa /agents para ver los disponibles.`);
  }
  setActiveAgentId(id);
  return agent;
}
