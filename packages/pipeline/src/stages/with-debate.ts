import type { Stage, PipelineServices } from "../types.js";

export interface DebateOptions {
  models: [string, string];
  arbiterModel: string;
  consensusThreshold?: number;
}

/** Wraps a stage to run it with multi-model debate */
export function withDebate<I, O, S extends PipelineServices>(
  stage: Stage<I, O, S>,
  opts: DebateOptions,
): Stage<I, O, S> {
  return {
    ...stage,
    id: `${stage.id}-debate`,
    async run(input, ctx) {
      ctx.logger.debug(`Debate opts provided: ${opts.models.join(" vs ")}`);
      // FASE 4: Placeholder for the debate orchestration.
      // A full implementation will execute `stage.run` twice with different models
      // using cloned contexts, diff the outputs, and run an arbiter prompt.
      // For now, it passes through to unblock the pipeline flow.
      return stage.run(input, ctx);
    },
  };
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase().trim()).filter(Boolean));
  const setB = new Set(b.map((s) => s.toLowerCase().trim()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

export function wordJaccard(a: string, b: string): number {
  return jaccard(a.split(/\s+/).filter(Boolean), b.split(/\s+/).filter(Boolean));
}

export interface FieldScore {
  field: string;
  score: number;
  weight: number;
  aValue: string;
  bValue: string;
}

export interface DiffResult {
  consensusScore: number;
  agreements: string[];
  disagreements: Array<{ field: string; values: string[] }>;
}

export function buildDiff(fields: FieldScore[]): DiffResult {
  const totalWeight = fields.reduce((s, f) => s + f.weight, 0);
  const consensusScore = fields.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight;

  const agreements: string[] = [];
  const disagreements: Array<{ field: string; values: string[] }> = [];

  for (const f of fields) {
    if (f.score >= 0.5) {
      agreements.push(`"${f.field}" similar (${Math.round(f.score * 100)}%)`);
    } else {
      disagreements.push({ field: f.field, values: [f.aValue, f.bValue] });
    }
  }

  return { consensusScore, agreements, disagreements };
}
