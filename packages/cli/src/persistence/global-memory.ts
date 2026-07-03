import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LearnOutput, EvolveOutput } from "../core/types.js";

const exec = promisify(execFile);

/**
 * Bridge to the global Pi/cmux workflow memory (~/.agents).
 *
 * Repo-local docs/log/ stays the canonical per-project record; when the
 * global recording scripts exist, learn/evolve results are additionally
 * exported so ~/.agents remains the single cross-project aggregation point.
 * Everything here is best-effort: missing scripts or failures never break
 * the calling command.
 */

export interface GlobalMemoryContext {
  sessionId: string;
}

export function globalMemoryScript(
  name: "record-learning" | "record-decision",
  scriptsDir = path.join(os.homedir(), ".agents", "workflows", "scripts"),
): string | null {
  const scriptPath = path.join(scriptsDir, `${name}.mjs`);
  return existsSync(scriptPath) ? scriptPath : null;
}

export function buildLearningArgs(learn: LearnOutput, ctx: GlobalMemoryContext): string[] {
  const title = learn.wikiEntryTitle.trim() || learn.summary.slice(0, 80);
  const args = [
    "--title", title,
    "--context", `SLAD session ${ctx.sessionId} · run ${learn.sourceRun} · task ${learn.taskId}\n\n${learn.summary}`,
  ];
  for (const error of learn.errors) args.push("--surprise", error);
  if (learn.patterns.length > 0) args.push("--pattern", learn.patterns.join("; "));
  for (const decision of learn.decisions) args.push("--decision", decision.decision);
  for (const followUp of learn.followUps) args.push("--follow-up", followUp);
  return args;
}

export function buildDecisionArgs(evolve: EvolveOutput, ctx: GlobalMemoryContext): string[] {
  const title = evolve.title.trim() || evolve.summary.slice(0, 80);
  const args = [
    "--title", title,
    "--status", "proposed",
    "--decision", evolve.summary,
    "--rationale", `Propuesto por slad evolve (session ${ctx.sessionId}).`,
  ];
  for (const update of evolve.proposedUpdates) {
    args.push("--follow-up", `${update.changeType} ${update.target}`);
  }
  return args;
}

async function invoke(scriptPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(process.execPath, [scriptPath, ...args], { timeout: 10_000 });
    return stdout.trim().split("\n").pop() || null;
  } catch {
    return null;
  }
}

async function record(
  name: "record-learning" | "record-decision",
  args: string[],
  ctx: GlobalMemoryContext,
  scriptsDir?: string,
): Promise<string | null> {
  if (process.env.SLAD_GLOBAL_MEMORY === "off") return null;
  const script = scriptsDir === undefined ? globalMemoryScript(name) : globalMemoryScript(name, scriptsDir);
  if (!script) return null;

  const recorded = await invoke(script, args);
  if (recorded) return recorded;

  // Most common failure: a record with the same title already exists for
  // today (the scripts refuse to overwrite). Retry once with a session suffix.
  const titleIndex = args.indexOf("--title") + 1;
  const retryArgs = [...args];
  retryArgs[titleIndex] = `${args[titleIndex]} · ${ctx.sessionId.slice(0, 6)}`;
  return invoke(script, retryArgs);
}

/** Exports a LearnOutput to ~/.agents/learnings/. Returns the written path, or null. */
export function recordGlobalLearning(
  learn: LearnOutput,
  ctx: GlobalMemoryContext,
  scriptsDir?: string,
): Promise<string | null> {
  return record("record-learning", buildLearningArgs(learn, ctx), ctx, scriptsDir);
}

/** Exports an EvolveOutput to ~/.agents/decisions/. Returns the written path, or null. */
export function recordGlobalDecision(
  evolve: EvolveOutput,
  ctx: GlobalMemoryContext,
  scriptsDir?: string,
): Promise<string | null> {
  return record("record-decision", buildDecisionArgs(evolve, ctx), ctx, scriptsDir);
}
