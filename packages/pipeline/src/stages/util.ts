import type { Question } from "@slad/shared";

/**
 * Los stages del pipeline corren sin humano en el loop: nadie puede responder una
 * pregunta a mitad de una etapa. Si el modelo igual emite "questions", el stage las
 * registra como items abiertos (openQuestions / assumptions / followUps) y sigue.
 */
export function isBlockingQuestion(question: Question): boolean {
  return question.blocking !== false;
}

export function describeUnansweredQuestion(question: Question): string {
  const assumed = question.default !== undefined ? ` (asumido: ${question.default})` : "";
  return `Sin respuesta humana — ${question.prompt}${assumed}`;
}

/** Agrega las preguntas sin responder a una lista de texto existente, sin duplicar. */
export function mergeUnansweredQuestions(
  existing: readonly string[],
  questions: readonly Question[],
): string[] {
  const merged = [...existing];
  for (const question of questions) {
    const text = describeUnansweredQuestion(question);
    if (!merged.includes(text)) merged.push(text);
  }
  return merged;
}

export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}
