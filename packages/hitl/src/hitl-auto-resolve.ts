import kleur from "kleur";
import type { Question } from "@slad/shared";
import type { HitlAwareOutput } from "./hitl-loop.js";

function logDim(message: string): void {
  console.log(kleur.dim(message));
}

export function autoResolveGeneric(output: HitlAwareOutput): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of output.questions) {
    const resolved = tryResolve(q);
    if (resolved !== null) {
      answers[q.id] = resolved;
      logDim(`  auto-resolve: ${q.id} → ${kleur.cyan(resolved)}`);
    }
  }
  return answers;
}

function tryResolve(q: Question): string | null {
  if (q.kind === "confirm" && q.default !== undefined) return String(q.default);
  if (q.kind === "choice" && q.choices && q.choices.length === 1) return q.choices[0] ?? null;
  if (q.kind === "choice" && q.default !== undefined) return String(q.default);
  if (!q.blocking && q.default !== undefined) return String(q.default);
  if (q.kind === "free" && !q.blocking && q.default !== undefined) return String(q.default);
  return null;
}

export function autoResolveExplore(output: HitlAwareOutput): Record<string, string> {
  const answers = autoResolveGeneric(output);
  for (const q of output.questions) {
    if (answers[q.id]) continue;
    if (/approach|enfoque|strategy/i.test(q.id) && q.kind === "choice" && q.choices && q.choices.length > 0) {
      answers[q.id] = q.choices[0] ?? "";
      logDim(`  auto-resolve (explore): ${q.id} → ${kleur.cyan(q.choices[0] ?? "")} (primer approach)`);
    }
  }
  return answers;
}

export function autoResolvePlan(output: HitlAwareOutput): Record<string, string> {
  const answers = autoResolveGeneric(output);
  for (const q of output.questions) {
    if (answers[q.id]) continue;
    if (q.kind === "ranking" && q.choices && q.choices.length > 0 && q.default) {
      answers[q.id] = String(q.default);
      logDim(`  auto-resolve (plan): ${q.id} → default ranking`);
    }
  }
  return answers;
}
