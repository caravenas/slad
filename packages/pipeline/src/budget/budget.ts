import type { BudgetState } from "./types.js";

// Precios por 1M tokens (USD) — actualizar según modelo
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-3-5": { input: 0.8, output: 4.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Gemini
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  // MiniMax fallback (default provider en AnthropicProvider)
  "MiniMax-M2.7": { input: 0.3, output: 1.2 },
  // Fallback genérico
  _default: { input: 3.0, output: 15.0 },
};

export class BudgetTracker {
  private state: BudgetState;
  private model: string;

  constructor(model: string, maxCostUsd = 0, maxTokens = 0, initialState?: Partial<BudgetState>) {
    this.model = model;
    this.state = {
      inputTokens: initialState?.inputTokens ?? 0,
      outputTokens: initialState?.outputTokens ?? 0,
      estimatedCostUsd: initialState?.estimatedCostUsd ?? 0,
      byStage: initialState?.byStage ?? {},
      maxCostUsd,
      maxTokens,
    };
  }

  /**
   * Registra tokens consumidos por una llamada al provider.
   */
  record(stage: string, inputTokens: number, outputTokens: number): void {
    this.state.inputTokens += inputTokens;
    this.state.outputTokens += outputTokens;

    const pricing = PRICING[this.model] ?? PRICING["_default"]!;
    const callCost =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;
    this.state.estimatedCostUsd += callCost;

    // Per-stage accumulator
    if (!this.state.byStage[stage]) {
      this.state.byStage[stage] = {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        calls: 0,
      };
    }
    const s = this.state.byStage[stage]!;
    s.inputTokens += inputTokens;
    s.outputTokens += outputTokens;
    s.estimatedCostUsd += callCost;
    s.calls += 1;
  }

  /**
   * Verifica si el budget ha sido excedido.
   */
  isExceeded(): boolean {
    if (
      this.state.maxCostUsd > 0 &&
      this.state.estimatedCostUsd >= this.state.maxCostUsd
    ) {
      return true;
    }
    if (
      this.state.maxTokens > 0 &&
      this.state.inputTokens + this.state.outputTokens >= this.state.maxTokens
    ) {
      return true;
    }
    return false;
  }

  /**
   * Retorna un warning si estamos cerca del límite (>80%).
   */
  warning(): string | null {
    if (this.state.maxCostUsd > 0) {
      const ratio = this.state.estimatedCostUsd / this.state.maxCostUsd;
      if (ratio > 0.8) {
        return `Budget: ${(ratio * 100).toFixed(0)}% consumido ($${this.state.estimatedCostUsd.toFixed(4)} / $${this.state.maxCostUsd})`;
      }
    }
    if (this.state.maxTokens > 0) {
      const total = this.state.inputTokens + this.state.outputTokens;
      const ratio = total / this.state.maxTokens;
      if (ratio > 0.8) {
        return `Tokens: ${(ratio * 100).toFixed(0)}% consumido (${total} / ${this.state.maxTokens})`;
      }
    }
    return null;
  }

  /** Snapshot del estado actual */
  getState(): BudgetState {
    return { ...this.state, byStage: { ...this.state.byStage } };
  }

  /** Print summary al terminal */
  printSummary(): void {
    const total = this.state.inputTokens + this.state.outputTokens;
    console.error(
      `  tokens: ${total.toLocaleString()} (in: ${this.state.inputTokens.toLocaleString()}, out: ${this.state.outputTokens.toLocaleString()})`,
    );
    console.error(`  costo estimado: $${this.state.estimatedCostUsd.toFixed(4)}`);

    for (const [stage, data] of Object.entries(this.state.byStage)) {
      console.error(`    ${stage}: ${data.calls} calls, $${data.estimatedCostUsd.toFixed(4)}`);
    }
  }
}
