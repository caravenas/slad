import { listSessions } from "./session.js";
import type { SessionState } from "./types.js";
import { readBudgetHistory, summarizeBudgetHistory } from "@slad/context-budget";
export { summarizeTelemetry, type TelemetryStats } from "@slad/pipeline";

export type ProjectStats = {
  sessions: number;
  runs: number;
  learnings: number;
  budget: {
    totalRuns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEstimatedCostUsd: number;
  };
};

export function computeStatsFromSessions(sessions: SessionState[]): Omit<ProjectStats, "budget"> {
  return sessions.reduce<Omit<ProjectStats, "budget">>(
    (stats, session) => {
      stats.sessions += 1;
      for (const artifact of session.artifacts) {
        if (artifact.kind === "run") stats.runs += 1;
        if (artifact.kind === "learn") stats.learnings += 1;
      }
      return stats;
    },
    { sessions: 0, runs: 0, learnings: 0 },
  );
}

export function getProjectStats(cwd = process.cwd()): ProjectStats {
  const sessionStats = computeStatsFromSessions(listSessions(cwd));
  const budgetHistory = readBudgetHistory(cwd);
  return {
    ...sessionStats,
    budget: summarizeBudgetHistory(budgetHistory),
  };
}
