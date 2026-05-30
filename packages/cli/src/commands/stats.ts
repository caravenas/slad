import kleur from "kleur";
import { getProjectStats, summarizeTelemetry, type ProjectStats, type TelemetryStats } from "../core/stats.js";
import { readAgentRunLog } from "../persistence/telemetry.js";

type StatsCommandOptions = {
  json?: boolean;
};

function formatTelemetry(t: TelemetryStats): string[] {
  if (t.totalRuns === 0) return [];

  const cmdParts = [
    t.byCommand.ask > 0 ? `ask: ${kleur.cyan(String(t.byCommand.ask))}` : "",
    t.byCommand.work > 0 ? `work: ${kleur.cyan(String(t.byCommand.work))}` : "",
    t.byCommand["work-debate"] > 0 ? `work-debate: ${kleur.cyan(String(t.byCommand["work-debate"]))}` : "",
  ].filter(Boolean).join("  ·  ");

  const statusParts = [
    t.byStatus.completed > 0 ? kleur.green(`✓ ${t.byStatus.completed}`) : "",
    t.byStatus.partial > 0 ? kleur.yellow(`~ ${t.byStatus.partial}`) : "",
    t.byStatus.failed > 0 ? kleur.red(`✗ ${t.byStatus.failed}`) : "",
  ].filter(Boolean).join("  ");

  const lines = [
    "",
    kleur.bold(`Telemetry`) + kleur.dim(` (${t.totalRuns} runs)`),
    `  Commands:   ${cmdParts}`,
    `  Status:     ${statusParts || kleur.dim("none")}`,
  ];

  if (t.debateRuns > 0) {
    const consensusPart = t.avgDebateConsensus !== null
      ? `  ·  consenso avg ${kleur.cyan(Math.round(t.avgDebateConsensus * 100) + "%")}`
      : "";
    lines.push(`  Debate:     ${kleur.cyan(String(t.debateRuns))} runs${consensusPart}`);
  }

  if (t.classifierShown > 0) {
    const pct = Math.round((t.classifierAccepted / t.classifierShown) * 100);
    lines.push(`  Classifier: mostrado ${kleur.cyan(String(t.classifierShown))}×, aceptado ${kleur.cyan(String(t.classifierAccepted))}× (${pct}%)`);
  }

  if (t.avgDurationMs !== null) {
    const secs = (t.avgDurationMs / 1000).toFixed(1);
    lines.push(`  Duración:   ${kleur.cyan(secs + "s")} avg`);
  }

  return lines;
}

function formatStats(stats: ProjectStats, telemetry: TelemetryStats): string {
  const totalTokens = stats.budget.totalInputTokens + stats.budget.totalOutputTokens;
  const budgetLines =
    stats.budget.totalRuns > 0
      ? [
          "",
          kleur.bold("Budget history"),
          `  Auto runs: ${kleur.cyan(String(stats.budget.totalRuns))}`,
          `  Total tokens: ${kleur.cyan(totalTokens.toLocaleString())} (in: ${stats.budget.totalInputTokens.toLocaleString()}, out: ${stats.budget.totalOutputTokens.toLocaleString()})`,
          `  Estimated cost: ${kleur.cyan("$" + stats.budget.totalEstimatedCostUsd.toFixed(4))}`,
        ]
      : [];

  return [
    "",
    kleur.bold("Project stats"),
    `  Sessions: ${kleur.cyan(String(stats.sessions))}`,
    `  Runs: ${kleur.cyan(String(stats.runs))}`,
    `  Learnings: ${kleur.cyan(String(stats.learnings))}`,
    ...budgetLines,
    ...formatTelemetry(telemetry),
  ].join("\n");
}

export async function statsCommand(
  opts: StatsCommandOptions = {},
  out: { write(s: string): unknown } = process.stdout,
): Promise<void> {
  const [stats, logEntries] = await Promise.all([
    Promise.resolve(getProjectStats()),
    readAgentRunLog(),
  ]);
  const telemetry = summarizeTelemetry(logEntries);

  if (opts.json) {
    out.write(JSON.stringify({ ...stats, telemetry }, null, 2) + "\n");
    return;
  }

  out.write(formatStats(stats, telemetry) + "\n");
}
