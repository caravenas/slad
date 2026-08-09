import { DoctorReport, type DoctorReport as DoctorReportValue } from "@slad/shared";
import { getModel, loadConfig, resolveProvider } from "../core/config.js";
import { runDoctor } from "../core/doctor.js";

export type DoctorCommandOptions = {
  json?: boolean;
};

type Writer = { write(s: string): unknown };

type DoctorCommandDeps = {
  stdout?: Writer;
  stderr?: Writer;
  run?: () => Promise<DoctorReportValue>;
  setExitCode?: (code: number) => void;
};

function formatSummary(report: DoctorReportValue): string {
  return `passed=${report.summary.passed} warnings=${report.summary.warnings} blockers=${report.summary.blockers}`;
}

function formatDoctorReport(report: DoctorReportValue): string {
  const lines = [
    "SLAD doctor",
    `Status: ${report.status}`,
    `Summary: ${formatSummary(report)}`,
    "Checks:",
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.status}] ${check.name}: ${check.message}`);
    if (check.evidence && check.evidence.length > 0) {
      lines.push("  Evidence:");
      for (const item of check.evidence) lines.push(`  - ${item}`);
    }
    if (check.recommendation) {
      lines.push(`  Recommendation: ${check.recommendation}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function exitCodeForReport(report: DoctorReportValue): number {
  return report.status === "blocked" ? 2 : 0;
}

function bootstrapDoctorConfigReadOnly(): void {
  const config = loadConfig();
  const providerName = resolveProvider(undefined, undefined, config.defaultProvider, config.defaultAgent);
  const model = getModel(providerName);
  if (model && !process.env.CLI_MODEL) process.env.CLI_MODEL = model;
}

export async function doctorCommand(
  options: DoctorCommandOptions = {},
  deps: DoctorCommandDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });

  try {
    const run = deps.run;
    if (!run) {
      try {
        bootstrapDoctorConfigReadOnly();
      } catch {
        // Doctor should remain a read-only diagnostic. If persisted config is
        // malformed, continue with the existing environment and let the real
        // checks report actionable blockers without contaminating JSON stdout.
      }
    }

    const rawReport = await (run ?? (() => runDoctor()))();
    const report = DoctorReport.parse(rawReport);

    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout.write(formatDoctorReport(report));
    }

    setExitCode(exitCodeForReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.json) {
      stderr.write(`doctor error: ${message}\n`);
    }
    setExitCode(1);
  }
}
