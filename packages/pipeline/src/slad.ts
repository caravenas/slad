import fs from "node:fs";
import path from "node:path";
import { AgentRunLog, STAGE_NAMES, type SessionState, type StageName, type AgentRunLog as AgentRunLogEntry } from "@slad/shared";
import type { CacheStore } from "@slad/cache";
import type { ExecutionHarness } from "@slad/harness";
import type { HITLTransport } from "@slad/hitl";
import type { ModelProvider } from "@slad/model-providers";
import type { ToolRegistry } from "@slad/tools";
import { readDataFile, type ParsedDataFile } from "./session.js";
import type { PipelineServices } from "./types.js";

export const SLAD_PIPELINE_STAGES = STAGE_NAMES;
export type SladPipelineStage = StageName;

export const AUTO_PIPELINE_STAGES = ["explore", "snapshot", "plan", "run", "learn"] as const;
export type AutoPipelineStage = (typeof AUTO_PIPELINE_STAGES)[number];
export type AutoPipelineStatus = "completed" | "partial" | "failed";
export type PipelineStageProgress = "done" | "progress" | "pending" | "await" | "failed";
export type SladHarnessMode = "off" | "on" | "strict";
export type SladRunMode = "ask" | "work" | "work-debate";
export type TelemetryStatus = "completed" | "partial" | "failed" | "unknown";
export type SladArtifactKind = SladPipelineStage | "session";

export interface TelemetryStats {
  totalRuns: number;
  byCommand: { ask: number; work: number; "work-debate": number };
  byStatus: Record<TelemetryStatus, number>;
  debateRuns: number;
  avgDebateConsensus: number | null;
  classifierShown: number;
  classifierAccepted: number;
  avgDurationMs: number | null;
}

const sladStageSet = new Set<string>(SLAD_PIPELINE_STAGES);
const autoStageSet = new Set<string>(AUTO_PIPELINE_STAGES);
const sladRunModeSet = new Set<string>(["ask", "work", "work-debate"]);

export interface CreatePipelineServicesOptions<Extras extends Record<string, unknown> = {}> {
  provider?: ModelProvider;
  harness?: ExecutionHarness;
  hitl?: HITLTransport;
  tools?: ToolRegistry;
  cache?: CacheStore<unknown>;
  extras?: Extras;
}

export function createPipelineServices<Extras extends Record<string, unknown> = {}>(
  options: CreatePipelineServicesOptions<Extras> = {},
): PipelineServices & Extras {
  const { provider, harness, hitl, tools, cache, extras } = options;
  return {
    ...(provider ? { provider } : {}),
    ...(harness ? { harness } : {}),
    ...(hitl ? { hitl } : {}),
    ...(tools ? { tools } : {}),
    ...(cache ? { cache } : {}),
    ...(extras ?? {}),
  } as PipelineServices & Extras;
}

export function isSladPipelineStage(value: string): value is SladPipelineStage {
  return sladStageSet.has(value);
}

export function isAutoPipelineStage(value: string): value is AutoPipelineStage {
  return autoStageSet.has(value);
}

export interface SladPipelineRunRequest {
  sessionId: string;
  stage: SladPipelineStage;
  agent?: string;
  model?: string;
  harness: SladHarnessMode;
}

export interface SladHumanAnswersRequest {
  sessionId: string;
  stage: SladPipelineStage;
  taskId?: string;
  answers: Record<string, string>;
}

export interface SladWorkRequest {
  intent: string;
  mode: SladRunMode;
  agent?: string;
  model?: string;
  debateModels?: string;
}

export function parseSladHarnessMode(value: unknown, fallback: SladHarnessMode = "on"): SladHarnessMode {
  return value === "off" || value === "on" || value === "strict" ? value : fallback;
}

export function isSladRunMode(value: string): value is SladRunMode {
  return sladRunModeSet.has(value);
}

export function parseSladPipelineRunRequest(value: unknown): SladPipelineRunRequest | null {
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const stage = typeof value.stage === "string" && isSladPipelineStage(value.stage) ? value.stage : null;
  if (!sessionId || !stage) return null;

  return {
    sessionId,
    stage,
    ...(typeof value.agent === "string" && value.agent ? { agent: value.agent } : {}),
    ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
    harness: parseSladHarnessMode(value.harness),
  };
}

export function parseSladHumanAnswersRequest(value: unknown): SladHumanAnswersRequest | null {
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const stage = typeof value.stage === "string" && isSladPipelineStage(value.stage) ? value.stage : null;
  const answers = normalizeStringRecord(value.answers);
  if (!sessionId || !stage || Object.keys(answers).length === 0) return null;

  return {
    sessionId,
    stage,
    ...(typeof value.taskId === "string" && value.taskId ? { taskId: value.taskId } : {}),
    answers,
  };
}

export function parseSladWorkRequest(
  value: unknown,
  fallbackMode: SladRunMode = "work",
): SladWorkRequest | null {
  if (!isRecord(value)) return null;
  const intent = typeof value.intent === "string" ? value.intent.trim() : "";
  if (intent.length < 2) return null;

  const mode = typeof value.mode === "string" && isSladRunMode(value.mode)
    ? value.mode
    : fallbackMode;

  return {
    intent,
    mode,
    ...(typeof value.agent === "string" && value.agent ? { agent: value.agent } : {}),
    ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
    ...(typeof value.debateModels === "string" && value.debateModels ? { debateModels: value.debateModels } : {}),
  };
}

export function commandForStage(
  stage: SladPipelineStage,
  intent: string,
  opts?: { agent?: string; model?: string; harness?: SladHarnessMode },
): string[] {
  const agentFlags = opts?.agent ? ["--agent", opts.agent] : [];
  const modelFlags = opts?.model ? ["--model", opts.model] : [];
  const harnessMode = opts?.harness ?? "on";
  switch (stage) {
    case "explore":
      return ["explore", intent, ...agentFlags, ...modelFlags];
    case "snapshot":
      return ["snapshot", ...agentFlags, ...modelFlags];
    case "plan":
      return ["plan", ...agentFlags, ...modelFlags];
    case "run":
      return ["run", "--auto", "--harness", harnessMode, "--non-interactive", ...agentFlags, ...modelFlags];
    case "learn":
      return ["learn", ...agentFlags, ...modelFlags];
    case "evolve":
      return ["evolve", ...agentFlags, ...modelFlags];
  }
}

export function commandForMode(
  mode: SladRunMode,
  intent: string,
  opts?: { agent?: string; model?: string; debateModels?: string },
): string[] {
  const agentFlags = opts?.agent ? ["--agent", opts.agent] : [];
  const modelFlags = opts?.model ? ["--model", opts.model] : [];
  switch (mode) {
    case "ask":
      return ["ask", intent, ...agentFlags, ...modelFlags];
    case "work-debate": {
      const debateModelsFlags = opts?.debateModels
        ? ["--debate-models", opts.debateModels]
        : [];
      return ["work", intent, "--debate", ...agentFlags, ...modelFlags, ...debateModelsFlags];
    }
    case "work":
    default:
      return ["work", intent, ...agentFlags, ...modelFlags];
  }
}

export function stageArtifactDirName(stage: string): string {
  switch (stage) {
    case "explore":
      return "explores";
    case "snapshot":
      return "snapshots";
    case "plan":
      return "plans";
    case "run":
      return "runs";
    case "learn":
      return "learnings";
    case "evolve":
      return "evolution";
    default:
      return stage;
  }
}

export function stageArtifactDir(logRoot: string, stage: SladPipelineStage): string {
  return path.join(logRoot, stageArtifactDirName(stage));
}

export function artifactLogDirName(kind: SladArtifactKind): string {
  if (kind === "session") return "sessions";
  return stageArtifactDirName(kind);
}

export function artifactLogDir(docsRoot: string, kind: SladArtifactKind): string {
  return path.join(docsRoot, "log", artifactLogDirName(kind));
}

export function artifactFilePath(
  docsRoot: string,
  kind: SladArtifactKind,
  sessionId: string,
  key?: string,
): string {
  const suffix = key ? `_${key}` : "";
  return path.join(artifactLogDir(docsRoot, kind), `${sessionId}${suffix}.json`);
}

export function timestampedArtifactFilePath(
  docsRoot: string,
  kind: SladArtifactKind,
  sessionId: string,
  isoTimestamp: string,
  key?: string,
): string {
  const suffix = key ? `_${key}` : "";
  return path.join(
    artifactLogDir(docsRoot, kind),
    `${sessionId}${suffix}__${filesystemSafeTimestamp(isoTimestamp)}.json`,
  );
}

export function runArtifactFilePath(docsRoot: string, sessionId: string, taskId: string): string {
  return artifactFilePath(docsRoot, "run", sessionId, taskId);
}

export function timestampedRunArtifactFilePath(
  docsRoot: string,
  sessionId: string,
  taskId: string,
  isoTimestamp: string,
): string {
  return timestampedArtifactFilePath(docsRoot, "run", sessionId, isoTimestamp, taskId);
}

export function localizeStageArtifactPath(logRoot: string, filePath: string, stage: SladPipelineStage): string {
  if (fs.existsSync(filePath)) return filePath;
  return path.join(stageArtifactDir(logRoot, stage), path.basename(filePath));
}

export function listStageArtifacts(
  logRoot: string,
  session: Pick<SessionState, "id" | "artifacts">,
  stage: SladPipelineStage,
): ParsedDataFile<Record<string, unknown>>[] {
  const fromSession = session.artifacts
    .filter((artifact) => artifact.kind === stage)
    .map((artifact) => localizeStageArtifactPath(logRoot, artifact.path, stage));
  const dir = stageArtifactDir(logRoot, stage);
  const fromDir = fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter((entry) => {
        if (!/\.(json|md)$/.test(entry)) return false;
        if (stage === "run" || stage === "learn") return entry.startsWith(`${session.id}_`);
        return entry === `${session.id}.json` || entry === `${session.id}.md` || entry.startsWith(`${session.id}__`);
      })
      .map((entry) => path.join(dir, entry))
    : [];

  return [...new Set([...fromSession, ...fromDir])]
    .map((filePath) => readDataFile<Record<string, unknown>>(filePath))
    .filter((artifact): artifact is ParsedDataFile<Record<string, unknown>> => Boolean(artifact))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

export function lastStageArtifact(
  logRoot: string,
  session: Pick<SessionState, "id" | "artifacts">,
  stage: SladPipelineStage,
): ParsedDataFile<Record<string, unknown>> | null {
  const artifacts = listStageArtifacts(logRoot, session, stage);
  return artifacts[artifacts.length - 1] ?? null;
}

export function stageStatusesForSession(
  logRoot: string,
  session: Pick<SessionState, "id" | "artifacts" | "humanAnswers">,
): PipelineStageProgress[] {
  return SLAD_PIPELINE_STAGES.map((stage) => {
    const artifact = lastStageArtifact(logRoot, session, stage);
    if (!artifact) return "pending";
    if (artifactNeedsResume(session, artifact)) return "pending";
    if (artifactHasHumanBlock(session, artifact)) return "await";
    if (artifact.value.status === "blocked" || artifact.value.status === "failed") return "failed";
    return "done";
  });
}

export interface AutoPipelineExpectationOptions {
  dryRun?: boolean;
  skipLearn?: boolean;
}

export interface AutoPipelineStatusOptions extends AutoPipelineExpectationOptions {
  stagesCompleted: readonly AutoPipelineStage[];
  stoppedAt?: string;
  stopReason?: string;
}

export interface AutoPipelineCheckpoint<State = unknown> {
  intent: string;
  sessionId: string;
  lastStageCompleted: AutoPipelineStage;
  artifacts: Record<string, string>;
  budgetState: State;
  savedAt: string;
}

export interface AutoPipelineProgress<State = unknown> {
  stagesCompleted: AutoPipelineStage[];
  artifacts: Record<string, string>;
  checkpoint: AutoPipelineCheckpoint<State> | null;
}

export interface AutoPipelineTasksSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface AutoPipelineReport<BudgetState = unknown> {
  intent: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: AutoPipelineStatus;
  stagesCompleted: AutoPipelineStage[];
  stoppedAt?: string;
  stopReason?: string;
  artifacts: Record<string, string>;
  budget: BudgetState;
  tasksSummary?: AutoPipelineTasksSummary;
}

export interface StoredAutoReport<T> {
  kind: "auto-report";
  schemaVersion: 1;
  createdAt: string;
  value: T;
}

export function completedAutoStagesThrough(stage: AutoPipelineStage): AutoPipelineStage[] {
  const index = AUTO_PIPELINE_STAGES.indexOf(stage);
  return index === -1 ? [] : AUTO_PIPELINE_STAGES.slice(0, index + 1);
}

export function createAutoPipelineProgress<State = unknown>(
  checkpoint?: AutoPipelineCheckpoint<State> | null,
): AutoPipelineProgress<State> {
  if (!checkpoint) {
    return {
      stagesCompleted: [],
      artifacts: {},
      checkpoint: null,
    };
  }

  return {
    stagesCompleted: completedAutoStagesThrough(checkpoint.lastStageCompleted),
    artifacts: { ...checkpoint.artifacts },
    checkpoint,
  };
}

export function expectedAutoPipelineStages(options: AutoPipelineExpectationOptions = {}): AutoPipelineStage[] {
  if (options.dryRun) return AUTO_PIPELINE_STAGES.slice(0, 3);
  if (options.skipLearn) return AUTO_PIPELINE_STAGES.slice(0, 4);
  return [...AUTO_PIPELINE_STAGES];
}

export function getAutoPipelineStatus(options: AutoPipelineStatusOptions): AutoPipelineStatus {
  const expected = expectedAutoPipelineStages(options);
  const isDryRunStop =
    options.dryRun && options.stoppedAt === "plan" && options.stopReason?.startsWith("Dry run");

  if (options.stagesCompleted.length === expected.length || isDryRunStop) {
    return "completed";
  }
  return options.stagesCompleted.length > 0 ? "partial" : "failed";
}

export function autoPipelineCheckpointPath(cwd: string): string {
  return path.join(cwd, ".slad-os", "auto-checkpoint.json");
}

export function filesystemSafeTimestamp(isoTimestamp = new Date().toISOString()): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export interface WriteAutoReportOptions {
  docsRoot: string;
  createdAt?: string;
  basename?: string;
}

export function autoReportPath(options: WriteAutoReportOptions): string {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const basename = options.basename ?? "auto-report";
  return path.join(options.docsRoot, "log", "auto", `${filesystemSafeTimestamp(createdAt)}-${basename}.json`);
}

export function telemetryLogPath(logRoot: string): string {
  return path.join(logRoot, "telemetry", "agent-run-log.ldjson");
}

export function parseAgentRunLog(text: string): AgentRunLogEntry[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [AgentRunLog.parse(JSON.parse(line))];
      } catch {
        return [];
      }
    });
}

export function readAgentRunLog(logRoot: string): AgentRunLogEntry[] {
  const filePath = telemetryLogPath(logRoot);
  if (!fs.existsSync(filePath)) return [];
  try {
    return parseAgentRunLog(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export function emptyTelemetryStats(): TelemetryStats {
  return {
    totalRuns: 0,
    byCommand: { ask: 0, work: 0, "work-debate": 0 },
    byStatus: { completed: 0, partial: 0, failed: 0, unknown: 0 },
    debateRuns: 0,
    avgDebateConsensus: null,
    classifierShown: 0,
    classifierAccepted: 0,
    avgDurationMs: null,
  };
}

export function summarizeTelemetry(entries: readonly AgentRunLogEntry[]): TelemetryStats {
  if (entries.length === 0) return emptyTelemetryStats();

  const byCommand = { ask: 0, work: 0, "work-debate": 0 };
  const byStatus = { completed: 0, partial: 0, failed: 0, unknown: 0 };
  let debateRuns = 0;
  let debateConsensusSum = 0;
  let debateConsensusCount = 0;
  let classifierShown = 0;
  let classifierAccepted = 0;
  let totalDurationMs = 0;

  for (const entry of entries) {
    byCommand[entry.commandUsed] = (byCommand[entry.commandUsed] ?? 0) + 1;

    const status = entry.pipelineStatus ?? "unknown";
    if (status === "completed" || status === "partial" || status === "failed") {
      byStatus[status] += 1;
    } else {
      byStatus.unknown += 1;
    }

    if (entry.debateUsed) {
      debateRuns += 1;
      const scores = entry.debateConsensusScores;
      if (scores) {
        if (scores.explore !== undefined) { debateConsensusSum += scores.explore; debateConsensusCount += 1; }
        if (scores.plan !== undefined) { debateConsensusSum += scores.plan; debateConsensusCount += 1; }
      }
    }

    if (entry.classifierResult) {
      if (entry.classifierResult.shownToUser) classifierShown += 1;
      if (entry.classifierResult.userAccepted) classifierAccepted += 1;
    }

    totalDurationMs += entry.durationMs;
  }

  return {
    totalRuns: entries.length,
    byCommand,
    byStatus,
    debateRuns,
    avgDebateConsensus: debateConsensusCount > 0 ? debateConsensusSum / debateConsensusCount : null,
    classifierShown,
    classifierAccepted,
    avgDurationMs: totalDurationMs / entries.length,
  };
}

export function writeAutoReport<T>(
  report: T,
  options: WriteAutoReportOptions,
): string {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const filePath = autoReportPath({ ...options, createdAt });
  const payload: StoredAutoReport<T> = {
    kind: "auto-report",
    schemaVersion: 1,
    createdAt,
    value: report,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

export function saveAutoPipelineCheckpoint<State>(
  checkpoint: AutoPipelineCheckpoint<State>,
  cwd = process.cwd(),
): void {
  const filePath = autoPipelineCheckpointPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf8");
}

export function loadAutoPipelineCheckpoint<State = unknown>(
  cwd = process.cwd(),
): AutoPipelineCheckpoint<State> | null {
  const filePath = autoPipelineCheckpointPath(cwd);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AutoPipelineCheckpoint<State>;
  } catch {
    return null;
  }
}

export function clearAutoPipelineCheckpoint(cwd = process.cwd()): void {
  const filePath = autoPipelineCheckpointPath(cwd);
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

export interface CompleteAutoPipelineStageOptions<State> {
  intent: string;
  sessionId: string;
  stage: AutoPipelineStage;
  artifactPath: string;
  budgetState: State;
  progress?: AutoPipelineProgress<State>;
  savedAt?: string;
  cwd?: string;
}

export function completeAutoPipelineStage<State>(
  options: CompleteAutoPipelineStageOptions<State>,
): AutoPipelineProgress<State> {
  const existingStages = options.progress?.stagesCompleted ?? [];
  const stagesCompleted = existingStages.includes(options.stage)
    ? [...existingStages]
    : [...existingStages, options.stage];
  const artifacts = {
    ...(options.progress?.artifacts ?? {}),
    [options.stage]: options.artifactPath,
  };
  const checkpoint: AutoPipelineCheckpoint<State> = {
    intent: options.intent,
    sessionId: options.sessionId,
    lastStageCompleted: options.stage,
    artifacts,
    budgetState: options.budgetState,
    savedAt: options.savedAt ?? new Date().toISOString(),
  };

  saveAutoPipelineCheckpoint(checkpoint, options.cwd);

  return {
    stagesCompleted,
    artifacts,
    checkpoint,
  };
}

export interface CreateAutoPipelineReportOptions<BudgetState>
  extends AutoPipelineStatusOptions {
  intent: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifacts?: Record<string, string>;
  budget: BudgetState;
  tasksSummary?: AutoPipelineTasksSummary;
}

export function createAutoPipelineReport<BudgetState>(
  options: CreateAutoPipelineReportOptions<BudgetState>,
): AutoPipelineReport<BudgetState> {
  const status = getAutoPipelineStatus(options);
  const isDryRunStop =
    options.dryRun && options.stoppedAt === "plan" && options.stopReason?.startsWith("Dry run");

  return {
    intent: options.intent,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    durationMs: options.durationMs,
    status,
    stagesCompleted: [...options.stagesCompleted],
    stoppedAt: isDryRunStop ? undefined : options.stoppedAt,
    stopReason: isDryRunStop ? undefined : options.stopReason,
    artifacts: { ...(options.artifacts ?? {}) },
    budget: options.budget,
    ...(options.tasksSummary ? { tasksSummary: options.tasksSummary } : {}),
  };
}

export function nextStageAfter(stage: SladPipelineStage): SladPipelineStage | null {
  const index = SLAD_PIPELINE_STAGES.indexOf(stage);
  if (index === -1 || index === SLAD_PIPELINE_STAGES.length - 1) return null;
  return SLAD_PIPELINE_STAGES[index + 1] ?? null;
}

export function activePipelineStageIndex(stages: readonly PipelineStageProgress[]): number {
  const awaitingHuman = stages.findIndex((stage) => stage === "await");
  if (awaitingHuman !== -1) return awaitingHuman;

  const failed = stages.findIndex((stage) => stage === "failed");
  if (failed !== -1) return failed;

  const inProgress = stages.findIndex((stage) => stage === "progress");
  if (inProgress !== -1) return inProgress;

  const pending = stages.findIndex((stage) => stage === "pending");
  if (pending !== -1) return pending;

  return Math.max(stages.length - 1, 0);
}

export function nextPipelineStageFromProgress(
  stages: readonly PipelineStageProgress[],
  pipelineStages: readonly SladPipelineStage[] = SLAD_PIPELINE_STAGES,
): SladPipelineStage | null {
  const next = stages.findIndex((stage) => stage === "progress" || stage === "pending" || stage === "await" || stage === "failed");
  if (next === -1) return null;
  return pipelineStages[next] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSessionAnswerAfter(
  session: Pick<SessionState, "humanAnswers">,
  taskId: string,
  questionId: string,
  afterIso?: string,
): boolean {
  const after = Date.parse(afterIso ?? "");
  return session.humanAnswers.some((answer) => {
    if (answer.taskId !== taskId || answer.questionId !== questionId) return false;
    return !Number.isFinite(after) || Date.parse(answer.askedAt) > after;
  });
}

function hasSessionAnswer(
  session: Pick<SessionState, "humanAnswers">,
  taskId: string,
  questionId: string,
): boolean {
  return session.humanAnswers.some((answer) => (
    answer.taskId === taskId && answer.questionId === questionId && answer.answer.trim() !== ""
  ));
}

function artifactQuestionTaskId(artifact: ParsedDataFile<Record<string, unknown>>): string {
  if (artifact.kind === "run") return String(artifact.value.taskId ?? artifact.taskId ?? "run");
  return artifact.kind;
}

function artifactNeedsResume(
  session: Pick<SessionState, "humanAnswers">,
  artifact: ParsedDataFile<Record<string, unknown>> | null,
): boolean {
  if (!artifact || artifact.value.status !== "awaiting_human") return false;
  const questions = artifact.value.questions;
  if (!Array.isArray(questions) || questions.length === 0) return true;
  const taskId = artifactQuestionTaskId(artifact);
  return questions.every((question) => {
    const questionId = String((question as Record<string, unknown>).id ?? "");
    return questionId && hasSessionAnswer(session, taskId, questionId);
  });
}

function artifactHasHumanBlock(
  session: Pick<SessionState, "humanAnswers">,
  artifact: ParsedDataFile<Record<string, unknown>> | null,
): boolean {
  if (!artifact) return false;
  const status = artifact.value.status;
  const questions = artifact.value.questions;
  const followUps = artifact.value.followUps;
  if (Array.isArray(questions) && questions.length > 0) {
    const taskId = artifactQuestionTaskId(artifact);
    return questions.some((question) => {
      const questionId = String((question as Record<string, unknown>).id ?? "");
      return !questionId || !hasSessionAnswer(session, taskId, questionId);
    });
  }
  if (status === "awaiting_human") return true;
  if ((status === "blocked" || status === "failed") && Array.isArray(followUps) && followUps.length > 0) {
    const taskId = String(artifact.value.taskId ?? artifact.taskId ?? "run");
    return !hasSessionAnswerAfter(session, taskId, "blocked_action", artifact.createdAt);
  }
  return false;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
