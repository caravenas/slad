import { input, select, confirm } from "@inquirer/prompts";
import type { Question } from "@slad/shared";

export type HITLTransportKind = "tty" | "http";

export interface HITLTransport {
  readonly kind: HITLTransportKind;
  canPrompt(): boolean;
  canInteract(): boolean;
  askQuestion(question: Question): Promise<string>;
  collectAnswers(questions: Question[]): Promise<Record<string, string>>;
  printHeader?(label: string, summary: string, round: number, maxRounds: number): void;
  printPaused?(label: string, questionCount: number): void;
}

export interface TTYTransportOptions {
  isTTY?: () => boolean;
  askQuestion?: (question: Question) => Promise<string>;
  writeLine?: (line: string) => void;
}

export interface HTTPTransportOptions {
  wsUrl?: string;
  timeoutMs?: number;
  requestAnswers?: (questions: Question[]) => Promise<Record<string, string>>;
}

export class TTYTransport implements HITLTransport {
  readonly kind = "tty" as const;

  constructor(private readonly opts: TTYTransportOptions = {}) {}

  canPrompt(): boolean {
    return this.opts.isTTY ? this.opts.isTTY() : Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  canInteract(): boolean {
    return this.canPrompt();
  }

  async askQuestion(q: Question): Promise<string> {
    if (this.opts.askQuestion) return this.opts.askQuestion(q);
    const header = q.context ? `${q.prompt}
  (${q.context})` : q.prompt;
    switch (q.kind) {
      case "free":
        return input({ message: header, default: q.default });
      case "choice": {
        const choices = (q.choices ?? []).map((c) => ({ name: c, value: c }));
        return select({ message: header, choices, default: q.default });
      }
      case "confirm": {
        const answer = await confirm({ message: header, default: q.default !== "no" });
        return answer ? "yes" : "no";
      }
      case "ranking": {
        const items = q.choices ?? [];
        if (items.length === 0) return input({ message: header, default: q.default });
        return input({
          message: `${header}
Opciones: ${items.join(", ")}
Ingresá el orden separado por comas:`,
          default: q.default ?? items.join(", "),
        });
      }
    }
  }

  async collectAnswers(questions: Question[]): Promise<Record<string, string>> {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      this.opts.writeLine?.("");
      if (!this.opts.writeLine) console.log("");
      answers[q.id] = await this.askQuestion(q);
    }
    return answers;
  }
}

export class HTTPTransport implements HITLTransport {
  readonly kind = "http" as const;
  readonly wsUrl?: string;
  readonly timeoutMs: number;

  constructor(private readonly opts: HTTPTransportOptions = {}) {
    this.wsUrl = opts.wsUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  canPrompt(): boolean {
    return Boolean(this.opts.requestAnswers);
  }

  canInteract(): boolean {
    return this.canPrompt();
  }

  async askQuestion(question: Question): Promise<string> {
    const answers = await this.collectAnswers([question]);
    return answers[question.id] ?? "";
  }

  async collectAnswers(questions: Question[]): Promise<Record<string, string>> {
    if (!this.opts.requestAnswers) {
      const target = this.wsUrl ? ` at ${this.wsUrl}` : "";
      throw new Error(`HTTPTransport is a stub: requestAnswers not implemented${target}`);
    }
    return this.opts.requestAnswers(questions);
  }
}

export function createHitlTransport(kind: "tty", opts?: TTYTransportOptions): HITLTransport;
export function createHitlTransport(kind: "http", opts?: HTTPTransportOptions): HITLTransport;
export function createHitlTransport(kind: HITLTransportKind, opts?: TTYTransportOptions | HTTPTransportOptions): HITLTransport {
  return kind === "http" ? new HTTPTransport(opts as HTTPTransportOptions) : new TTYTransport(opts as TTYTransportOptions);
}
