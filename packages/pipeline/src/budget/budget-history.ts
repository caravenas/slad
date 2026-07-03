import fs from "node:fs";
import path from "node:path";

export interface BudgetHistoryEntry {
  sessionId: string;
  intent: string;
  startedAt: string;
  completedAt: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  stagesCompleted: string[];
}

export interface BudgetHistorySummary {
  totalRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
}

function historyPath(cwd: string): string {
  return path.join(cwd, ".slad-os", "budget-history.jsonl");
}

export function appendBudgetHistory(entry: BudgetHistoryEntry, cwd = process.cwd()): void {
  const filePath = historyPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function readBudgetHistory(cwd = process.cwd()): BudgetHistoryEntry[] {
  const filePath = historyPath(cwd);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const entries: BudgetHistoryEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as BudgetHistoryEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export function summarizeBudgetHistory(entries: BudgetHistoryEntry[]): BudgetHistorySummary {
  return entries.reduce<BudgetHistorySummary>(
    (acc, e) => {
      acc.totalRuns += 1;
      acc.totalInputTokens += e.inputTokens;
      acc.totalOutputTokens += e.outputTokens;
      acc.totalEstimatedCostUsd += e.estimatedCostUsd;
      return acc;
    },
    { totalRuns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCostUsd: 0 },
  );
}
