import kleur from "kleur";
import type { Question } from "@slad/shared";
import { TTYTransport, type HITLTransport } from "./transport.js";

const defaultTransport = new TTYTransport();

export function canUseInteractiveHitl(transport: HITLTransport = defaultTransport): boolean {
  return transport.canPrompt();
}

export function printHitlPaused(label: string, questionCount: number): void {
  console.log("");
  console.log(
    kleur.bold().yellow(`⏸ ${label} quedó esperando input humano`) +
      kleur.dim(` (${questionCount} pregunta${questionCount === 1 ? "" : "s"})`),
  );
  console.log(kleur.dim("  Entorno no interactivo detectado; se persiste el artifact awaiting_human."));
}

export async function askQuestion(q: Question, transport: HITLTransport = defaultTransport): Promise<string> {
  return transport.askQuestion(q);
}

export async function collectAnswers(
  questions: Question[],
  transport: HITLTransport = defaultTransport,
): Promise<Record<string, string>> {
  return transport.collectAnswers(questions);
}

export function formatAnswersForPrompt(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value}`);
  return `Respuestas del humano:\n${lines.join("\n")}\n\nContinuá la tarea con esta información. Respondé ÚNICAMENTE con el JSON de output según el schema esperado, sin texto adicional.`;
}

export function printHitlHeader(label: string, summary: string, round: number, maxRounds: number): void {
  console.log("");
  console.log(
    kleur.bold().yellow(`⟳ ${label} necesita tu input`) +
      kleur.dim(` (round ${round}/${maxRounds})`),
  );
  if (summary) console.log(kleur.dim(`  ${summary}`));
}
