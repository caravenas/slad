import { confirm } from "@inquirer/prompts";
import kleur from "kleur";
import type { DecisionRecord } from "@slad/shared";
import { canUseInteractiveHitl } from "./hitl.js";
import { log } from "./logger.js";

function formatReversibility(r: DecisionRecord["reversibility"]): string {
  if (r === "permanent") return kleur.red().bold("PERMANENTE");
  return kleur.yellow().bold("DIFÍCIL DE REVERTIR");
}

/**
 * Returns decisions that require explicit human confirmation before proceeding.
 */
export function findGatingDecisions(decisions: DecisionRecord[]): DecisionRecord[] {
  return decisions.filter(
    (d) => d.reversibility === "hard" || d.reversibility === "permanent",
  );
}

/**
 * Presents each gating decision to the user for confirmation.
 * Returns 'approved' if all decisions are confirmed, 'paused' otherwise.
 */
export async function runDecisionGate(
  decisions: DecisionRecord[],
  stageName: string,
): Promise<"approved" | "paused"> {
  const gating = findGatingDecisions(decisions);
  if (gating.length === 0) return "approved";

  if (!canUseInteractiveHitl()) {
    log.warn(
      `  ${stageName} · ${gating.length} decisión(es) irreversible(s) requieren confirmación. ` +
        `Entorno no interactivo — pipeline pausado.`,
    );
    return "paused";
  }

  console.log("");
  console.log(
    kleur.bold().yellow(`⚠  ${stageName} · decisión(es) irreversible(s) requieren confirmación`),
  );

  for (const d of gating) {
    console.log("");
    console.log(
      `  ${formatReversibility(d.reversibility)} · ${kleur.cyan(d.id)}`,
    );
    console.log(`  ${kleur.bold("Decisión:")} ${d.decision}`);
    if (d.rationale) {
      console.log(`  ${kleur.dim("Razón:")} ${d.rationale}`);
    }
    if (d.alternatives.length > 0) {
      console.log(
        `  ${kleur.dim("Alternativas descartadas:")} ${d.alternatives.map((a) => a.option).join(", ")}`,
      );
    }

    const approved = await confirm({
      message: `¿Confirmás esta decisión?`,
      default: false,
    });

    if (!approved) {
      log.warn(`  Decisión "${d.id}" rechazada — pipeline pausado.`);
      return "paused";
    }
  }

  return "approved";
}
