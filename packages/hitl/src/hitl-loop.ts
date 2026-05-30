import type { ChatMessage, Question } from "@slad/shared";
import type { CompletionOptions, ModelProvider } from "@slad/model-providers";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "./hitl.js";

export interface HitlAwareOutput {
  status: string;
  questions: Question[];
  [key: string]: unknown;
}

export interface HitlLoopOpts<T extends HitlAwareOutput> {
  stageName: string;
  maxRounds?: number;
  completionOpts: CompletionOptions;
  parse: (raw: string) => T;
  autoResolve?: (output: T) => Record<string, string>;
  onRaw?: (raw: string) => void;
}

export interface HitlLoopResult<T extends HitlAwareOutput> {
  output: T;
  humanAnswers: Record<string, string>;
  rounds: number;
}

export async function hitlLoop<T extends HitlAwareOutput>(
  provider: ModelProvider,
  messages: ChatMessage[],
  opts: HitlLoopOpts<T>,
): Promise<HitlLoopResult<T>> {
  const maxRounds = opts.maxRounds ?? 3;
  const allAnswers: Record<string, string> = {};
  let output!: T;
  let raw = "";
  let rounds = 0;

  while (rounds <= maxRounds) {
    raw = await provider.complete(messages, opts.completionOpts);
    opts.onRaw?.(raw);
    output = opts.parse(raw);

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      return { output, humanAnswers: allAnswers, rounds };
    }

    if (rounds >= maxRounds) {
      return { output, humanAnswers: allAnswers, rounds };
    }

    let answers: Record<string, string> = {};
    let unresolvedQuestions = output.questions;

    if (opts.autoResolve) {
      const autoAnswers = opts.autoResolve(output);
      const autoResolved = new Set(Object.keys(autoAnswers));
      unresolvedQuestions = output.questions.filter((q) => !autoResolved.has(q.id));
      answers = { ...autoAnswers };
    }

    if (unresolvedQuestions.length > 0) {
      printHitlHeader(opts.stageName, ((output as Record<string, unknown>).summary as string) ?? "", rounds + 1, maxRounds);
      const interactiveAnswers = await collectAnswers(unresolvedQuestions);
      answers = { ...answers, ...interactiveAnswers };
    }

    Object.assign(allAnswers, answers);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  return { output, humanAnswers: allAnswers, rounds };
}
