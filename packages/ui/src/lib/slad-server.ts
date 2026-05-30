import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  SLAD_PIPELINE_STAGES,
  activePipelineStageIndex,
  createSessionState,
  extractMarkdownSection,
  listSessionStateFiles,
  listStageArtifacts,
  nextPipelineStageFromProgress,
  nextStageAfter,
  readAgentRunLog,
  loadSessionStateFileFromDir,
  readActiveSessionId as readPipelineActiveSessionId,
  setActiveSessionFile,
  stageStatusesForSession,
  summarizeTelemetry,
  upsertSessionAnswers,
  writeSessionFile,
  type ParsedDataFile,
  type SladPipelineStage,
} from "@slad/pipeline";
import type { SessionArtifactKind, SessionState } from "@slad/shared";
import { resolveUiDocsRoot } from "./config";
import type {
  UIArtifact,
  UIDecisionRecord,
  UIDiffBlock,
  UIFileChange,
  UIKnowledgeItem,
  UIQuestion,
  UISession,
  UISessionDetail,
  UITelemetryStats,
  UIThreadItem,
  UIVerification,
} from "./types";

const cwd = process.cwd();
export const SLAD_ROOT =
  path.basename(cwd) === "ui" && path.basename(path.dirname(cwd)) === "packages"
    ? path.resolve(cwd, "../..")
    : cwd;
export const SLAD_DOCS_ROOT = resolveUiDocsRoot(SLAD_ROOT);
export const SLAD_LOG_ROOT = path.join(SLAD_DOCS_ROOT, "log");
export const SESSION_DIR = path.join(SLAD_LOG_ROOT, "sessions");
export const ACTIVE_SESSION_FILE = path.join(SESSION_DIR, ".active-session");

export const PIPELINE_STAGES = SLAD_PIPELINE_STAGES;
export type PipelineStage = SladPipelineStage;

type SessionArtifact = {
  kind: SessionArtifactKind | "cli-discovery";
  path: string;
  createdAt: string;
  taskId?: string;
};

type SessionStateLite = {
  id: string;
  createdAt: string;
  intent: string;
  archivedAt?: string | null;
  currentPhase?: string;
  artifacts: SessionArtifact[];
  humanAnswers: Array<{ taskId: string; questionId: string; answer: string; askedAt: string }>;
  notes: string[];
};

type ArtifactRecord = ParsedDataFile<Record<string, unknown>>;

export type SladUiState = {
  sessions: UISession[];
  details: Record<string, UISessionDetail>;
  artifacts: Record<string, UIArtifact | Record<string, unknown>>;
  knowledge: UIKnowledgeItem[];
  telemetry: UITelemetryStats;
};

type SessionFile = {
  filePath: string;
  session: SessionStateLite;
};

function normalizeUiSession(session: SessionStateLite): SessionState {
  const { archivedAt, currentPhase, ...rest } = session;
  return {
    ...rest,
    ...(archivedAt ? { archivedAt } : {}),
    ...(typeof currentPhase === "string" ? { currentPhase: currentPhase as SessionArtifactKind } : {}),
  } as SessionState;
}

function writeUiSessionFile(session: SessionStateLite): string {
  return writeSessionFile(SESSION_DIR, normalizeUiSession(session));
}

export function createLocalSession(intent: string): SessionStateLite {
  const session = createSessionState(intent, { trimIntent: true }) as SessionStateLite;
  writeUiSessionFile(session);
  setActiveSession(session.id);
  return session;
}

export function setActiveSession(id: string): void {
  setActiveSessionFile(SESSION_DIR, id);
}

export function getActiveSessionId(): string | null {
  return readPipelineActiveSessionId(SESSION_DIR);
}

export function saveHumanAnswers(input: {
  sessionId: string;
  stage: PipelineStage;
  taskId?: string;
  answers: Record<string, string>;
}): void {
  const current = readSessionById(input.sessionId);
  if (!current) throw new Error(`Unknown session: ${input.sessionId}`);
  const taskId = input.taskId || input.stage;
  const session = upsertSessionAnswers(normalizeUiSession(current), taskId, input.answers) as SessionStateLite;
  writeUiSessionFile(session);
  setActiveSession(input.sessionId);
}

function parseSessionRecord(parsed: { session: SessionState }): SessionStateLite {
  return {
    ...(parsed.session as SessionState),
    archivedAt: parsed.session.archivedAt ?? null,
    currentPhase: typeof parsed.session.currentPhase === "string" ? parsed.session.currentPhase : undefined,
    artifacts: Array.isArray(parsed.session.artifacts) ? parsed.session.artifacts as SessionArtifact[] : [],
    humanAnswers: Array.isArray(parsed.session.humanAnswers)
      ? parsed.session.humanAnswers as SessionStateLite["humanAnswers"]
      : [],
    notes: Array.isArray(parsed.session.notes) ? parsed.session.notes as string[] : [],
  } as SessionStateLite;
}

function readSessionById(id: string): SessionStateLite | null {
  const parsed = loadSessionStateFileFromDir(SESSION_DIR, id);
  return parsed ? parseSessionRecord(parsed) : null;
}

function stageArtifactRecords(session: SessionStateLite, stage: PipelineStage): ArtifactRecord[] {
  return listStageArtifacts(SLAD_LOG_ROOT, normalizeUiSession(session), stage) as ArtifactRecord[];
}

function lastArtifact(session: SessionStateLite, stage: PipelineStage): ArtifactRecord | null {
  const artifacts = stageArtifactRecords(session, stage);
  return artifacts[artifacts.length - 1] ?? null;
}

function updatedAtLabel(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "sin fecha";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "hace menos de 1 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

function artifactQuestionTaskId(artifact: ArtifactRecord): string {
  if (artifact.kind === "run") return String(artifact.value.taskId ?? artifact.taskId ?? "run");
  return artifact.kind;
}

function stageStatuses(session: SessionStateLite): UISession["stages"] {
  return stageStatusesForSession(SLAD_LOG_ROOT, normalizeUiSession(session));
}

function activeStage(stages: UISession["stages"]): number {
  return activePipelineStageIndex(stages);
}

function toQuestion(q: Record<string, unknown>): UIQuestion {
  const choices = Array.isArray(q.choices) ? q.choices : Array.isArray(q.options) ? q.options : [];
  const options = choices.map((choice) => ({ v: String(choice), label: String(choice) }));
  const defaultValue = q.default === undefined ? undefined : String(q.default);
  return {
    id: String(q.id ?? "question"),
    kind: (q.kind === "choice" || q.kind === "confirm" || q.kind === "ranking" ? q.kind : "free") as UIQuestion["kind"],
    prompt: String(q.prompt ?? ""),
    context: typeof q.context === "string" ? q.context : undefined,
    options,
    items: options,
    selected: defaultValue,
    value: q.default as string | boolean | null | undefined,
  };
}

function latestAnswer(
  session: SessionStateLite,
  taskId: string,
  questionId: string,
): string | undefined {
  return [...session.humanAnswers]
    .reverse()
    .find((answer) => answer.taskId === taskId && answer.questionId === questionId)
    ?.answer;
}

function questionsFromArtifact(session: SessionStateLite, artifact: ArtifactRecord | null, stage?: PipelineStage): UIQuestion[] {
  const questions = artifact?.value.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const taskId = artifact ? artifactQuestionTaskId(artifact) : stage ?? "run";
    return questions.map((q) => {
      const question = toQuestion(q as Record<string, unknown>);
      const answer = latestAnswer(session, taskId, question.id);
      return answer === undefined ? question : { ...question, selected: answer, value: answer };
    });
  }
  if (stage === "run" && artifact && (artifact.value.status === "blocked" || artifact.value.status === "failed")) {
    const followUps = Array.isArray(artifact.value.followUps) ? artifact.value.followUps.map(String) : [];
    if (followUps.length > 0) {
      return [{
        id: "blocked_action",
        kind: "choice",
        prompt: `Tarea ${String(artifact.value.taskId ?? artifact.taskId ?? "run")} quedó ${String(artifact.value.status)}. ¿Qué hacemos?`,
        context: String(artifact.value.summary ?? "El Builder propuso follow-ups para desbloquear la tarea."),
        selected: "__all_followups__",
        options: [
          { v: "__all_followups__", label: `Ejecutar todos los follow-ups (${followUps.length})` },
          ...followUps.map((followUp, index) => ({
            v: `__followup__:${index}`,
            label: followUp,
          })),
          { v: "__retry__", label: "Reintentar la tarea original" },
          { v: "__skip__", label: "Saltar esta tarea y sus dependientes" },
          { v: "__abort__", label: "Abortar el loop" },
        ],
      }];
    }
  }
  return [];
}

function buildPlanDetail(artifact: ArtifactRecord | null): UISessionDetail["plan"] | undefined {
  if (!artifact) return undefined;
  const tasks = Array.isArray(artifact.value.tasks) ? artifact.value.tasks as Array<Record<string, unknown>> : [];
  return {
    goal: String(artifact.value.summary ?? artifact.value.snapshot ?? "Plan"),
    tasks: tasks.map((task) => ({
      id: String(task.id ?? "T1") as any,
      title: String(task.title ?? task.id ?? "Task"),
      deps: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) as any : [],
      files: Array.isArray(task.files) ? task.files.map(String) : [],
      accept: Array.isArray(task.acceptanceCriteria)
        ? task.acceptanceCriteria.map(String).join(" ")
        : String(task.description ?? ""),
      verify: Array.isArray(artifact.value.verification) ? artifact.value.verification.map(String) : [],
    })),
  };
}

function buildRunDetail(session: SessionStateLite): Partial<UISessionDetail> {
  const runs = stageArtifactRecords(session, "run");
  const latest = runs[runs.length - 1] ?? null;
  const runRows: UIThreadItem[] = runs.map((run) => ({
    kind: "tool",
    icon: run.value.status === "completed" ? "✓" : run.value.status === "failed" ? "✗" : "◐",
    name: `run ${run.value.taskId ?? run.taskId ?? "task"}`,
    arg: String(run.value.summary ?? extractMarkdownSection(run.raw, "Summary") ?? ""),
    ts: updatedAtLabel(String(run.createdAt ?? "")),
    meta: String(run.value.status ?? ""),
  }));
  const changedFiles = Array.isArray(latest?.value.changedFiles) ? latest.value.changedFiles.map(String) : [];
  const verification = Array.isArray(latest?.value.verification)
    ? latest.value.verification as Array<Record<string, unknown>>
    : [];
  const questions = Array.isArray(latest?.value.questions)
    ? latest.value.questions.map((q) => toQuestion(q as Record<string, unknown>))
    : [];

  return {
    runActiveTask: String(latest?.value.taskId ?? latest?.taskId ?? ""),
    runThread: [
      { kind: "section", text: runs.length ? `${runs.length} run artifact(s)` : "Sin runs todavía" },
      ...runRows,
    ],
    files: changedFiles.map((file): UIFileChange => ({ path: file, add: 0, rem: 0 })),
    verify: verification.map((item): UIVerification => ({
      cmd: String(item.command ?? ""),
      state: item.status === "passed" ? "done" : item.status === "failed" ? "failed" : "pending",
      dur: "persistido",
    })),
    questions,
  };
}

function buildLearnDetail(artifact: ArtifactRecord | null, session: SessionStateLite): UIKnowledgeItem[] {
  if (!artifact) return [];
  const groups: Array<[UIKnowledgeItem["cat"], unknown]> = [
    ["decision", artifact.value.decisions],
    ["error", artifact.value.errors],
    ["pattern", artifact.value.patterns],
    ["followup", artifact.value.followUps],
  ];
  return groups.flatMap(([cat, items]) =>
    (Array.isArray(items) ? items : []).map((item) => ({
      cat,
      proj: "slad",
      session: session.id,
      time: updatedAtLabel(String(artifact.createdAt ?? session.createdAt)),
      // Decisions may be DecisionRecord objects (new schema) or plain strings (legacy)
      text: typeof item === "string"
        ? item
        : typeof item === "object" && item !== null
          ? String((item as Record<string, unknown>).decision ?? JSON.stringify(item))
          : String(item),
    })),
  );
}

function buildEvolveDetail(artifact: ArtifactRecord | null): UISessionDetail["evolve"] | undefined {
  if (!artifact) return undefined;
  const updates = Array.isArray(artifact.value.proposedUpdates)
    ? artifact.value.proposedUpdates as Array<Record<string, unknown>>
    : [];
  const agentsDiff: UIDiffBlock[] = [];
  const wikiDiff: UIDiffBlock[] = [];
  updates.forEach((update, index) => {
    const block = {
      id: `evolve-${index + 1}`,
      title: String(update.target ?? update.changeType ?? `Update ${index + 1}`),
      state: "pending" as const,
      lines: String(update.content ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 30)
        .map((line) => ({ k: "add" as const, t: line })),
    };
    if (String(update.target ?? "").startsWith("wiki/decisions/")) {
      wikiDiff.push(block);
    } else {
      agentsDiff.push(block);
    }
  });
  return { agentsDiff, wikiDiff };
}

function buildDecisionsDetail(sessionId: string): UIDecisionRecord[] {
  const decisionsPath = path.join(SLAD_LOG_ROOT, "decisions", `${sessionId}.json`);
  if (!fs.existsSync(decisionsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(decisionsPath, "utf8")) as Record<string, unknown>;
    const decisions = Array.isArray(raw.decisions) ? raw.decisions as Array<Record<string, unknown>> : [];
    const validReversibility = new Set(["trivial", "moderate", "hard", "permanent"]);
    return decisions.map((d): UIDecisionRecord => ({
      id: String(d.id ?? ""),
      stage: String(d.stage ?? ""),
      decision: String(d.decision ?? ""),
      reversibility: validReversibility.has(String(d.reversibility))
        ? d.reversibility as UIDecisionRecord["reversibility"]
        : "moderate",
      rationale: typeof d.rationale === "string" && d.rationale ? d.rationale : undefined,
      alternatives: Array.isArray(d.alternatives)
        ? (d.alternatives as Array<Record<string, unknown>>).map((alt) => ({
            option: String(alt.option ?? ""),
            rejectedBecause: String(alt.rejectedBecause ?? ""),
          }))
        : undefined,
      confidence: typeof d.confidence === "number" ? d.confidence : undefined,
    }));
  } catch {
    return [];
  }
}

function buildDetail(session: SessionStateLite): UISessionDetail {
  const explore = lastArtifact(session, "explore");
  const snapshot = lastArtifact(session, "snapshot");
  const plan = lastArtifact(session, "plan");
  const learn = lastArtifact(session, "learn");
  const evolve = lastArtifact(session, "evolve");
  return {
    explore: explore?.value,
    snapshot: snapshot ? { ...snapshot.value, content: extractMarkdownSection(snapshot.raw, "Context") || snapshot.raw } : undefined,
    questionsByStage: {
      explore: questionsFromArtifact(session, explore, "explore"),
      snapshot: questionsFromArtifact(session, snapshot, "snapshot"),
      plan: questionsFromArtifact(session, plan, "plan"),
      run: questionsFromArtifact(session, lastArtifact(session, "run"), "run"),
      learn: questionsFromArtifact(session, learn, "learn"),
      evolve: questionsFromArtifact(session, evolve, "evolve"),
    },
    plan: buildPlanDetail(plan),
    ...buildRunDetail(session),
    decisions: buildDecisionsDetail(session.id),
    learn: buildLearnDetail(learn, session),
    evolve: buildEvolveDetail(evolve),
  } as UISessionDetail;
}

function artifactValueFor(session: SessionStateLite, stage: PipelineStage): Record<string, unknown> | undefined {
  const artifact = lastArtifact(session, stage);
  if (!artifact) return undefined;
  return {
    schema: `slad.${stage}.v1`,
    ...artifact.value,
    artifactPath: path.relative(SLAD_ROOT, artifact.path),
  };
}

function readTelemetry(): UITelemetryStats {
  const summary = summarizeTelemetry(readAgentRunLog(SLAD_LOG_ROOT));
  return {
    totalRuns: summary.totalRuns,
    byCommand: summary.byCommand,
    byStatus: {
      completed: summary.byStatus.completed,
      partial: summary.byStatus.partial,
      failed: summary.byStatus.failed,
    },
    debateRuns: summary.debateRuns,
    avgDebateConsensus: summary.avgDebateConsensus,
    classifierShown: summary.classifierShown,
    classifierAccepted: summary.classifierAccepted,
    avgDurationMs: summary.avgDurationMs,
  } satisfies UITelemetryStats;
}

export function readSladUiState(): SladUiState {
  if (!fs.existsSync(SESSION_DIR)) {
    return { sessions: [], details: {}, artifacts: {}, knowledge: [], telemetry: readTelemetry() };
  }

  const activeId = getActiveSessionId();
  const rawSessions = listSessionStateFiles<SessionState>(SESSION_DIR)
    .map((entry): SessionFile => ({
      filePath: entry.path,
      session: parseSessionRecord(entry),
    }));

  const byId = new Map<string, SessionFile>();
  for (const item of rawSessions) {
    const existing = byId.get(item.session.id);
    const itemIsJson = item.filePath.endsWith(".json");
    const existingIsJson = existing?.filePath.endsWith(".json");
    if (
      !existing ||
      (itemIsJson && !existingIsJson) ||
      (itemIsJson === existingIsJson && item.session.createdAt > existing.session.createdAt)
    ) {
      byId.set(item.session.id, item);
    }
  }
  const sessionsRaw = [...byId.values()]
    .map((item) => item.session)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const details: Record<string, UISessionDetail> = {};
  const artifacts: Record<string, UIArtifact | Record<string, unknown>> = {};
  const knowledge: UIKnowledgeItem[] = [];

  const sessions = sessionsRaw.map((session) => {
    const stages = stageStatuses(session);
    const current = activeStage(stages);
    const runs = stageArtifactRecords(session, "run");
    const detail = buildDetail(session);
    details[session.id] = detail;
    if (detail.learn) knowledge.push(...detail.learn);
    for (const stage of PIPELINE_STAGES) {
      const artifact = artifactValueFor(session, stage);
      if (artifact) artifacts[`${session.id}:${stage}`] = artifact;
    }
    return {
      id: session.id,
      intent: session.intent,
      archivedAt: session.archivedAt ?? null,
      updatedAt: updatedAtLabel(
        [...PIPELINE_STAGES.map((stage) => lastArtifact(session, stage)?.createdAt), session.createdAt]
          .filter(Boolean)
          .sort()
          .at(-1) ?? session.createdAt,
      ),
      stages,
      activeStage: current,
      tokens: 0,
      costUsd: 0,
      provider: { vendor: "config", model: ".env/default" },
      cacheHits: 0,
      cacheMisses: 0,
      runMode: stages[3] === "await" ? "hitl" : runs.length > 0 ? "live" : undefined,
      tasksTotal: detail.plan?.tasks.length,
      tasksDone: runs.filter((run) => run.value.status === "completed").length,
      hitlRound: stages.some((stage) => stage === "await") ? 1 : undefined,
      hitlMax: stages.some((stage) => stage === "await") ? 3 : undefined,
      isActive: session.id === activeId,
    } satisfies UISession;
  });

  return { sessions, details, artifacts, knowledge, telemetry: readTelemetry() };
}

const KNOWN_BINARIES = ["codex", "gemini", "claude", "agent"] as const;

export async function runAndSaveDiscovery(
  sessionId: string,
  opts?: { selectedAgent?: string },
): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const candidates: Array<{ binary: string; resolvedPath: string; version: string; evidence: string[]; confidenceScore: number; conflicts: string[] }> = [];

  for (const binary of KNOWN_BINARIES) {
    try {
      const { stdout } = await exec("which", [binary], { timeout: 800 });
      const resolvedPath = stdout.trim();
      if (!resolvedPath) continue;
      let version = "";
      try {
        const v = await exec(resolvedPath, ["--version"], { timeout: 800 });
        version = ((v.stdout || v.stderr) as string).trim().split("\n")[0].slice(0, 40);
      } catch { /* version optional */ }
      candidates.push({ binary, resolvedPath, version, evidence: ["which:found"], confidenceScore: 0.9, conflicts: [] });
    } catch { /* not installed */ }
  }

  const selectedCandidate = opts?.selectedAgent
    ? candidates.find((candidate) => candidate.binary === opts.selectedAgent) ?? null
    : null;

  const discovery = {
    candidates,
    selected: selectedCandidate ?? candidates[0] ?? null,
    pathHash: "0".repeat(64),
    status: candidates.length > 0 ? "resolved" : "empty",
  };

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSION_DIR, `${sessionId}_cli-discovery.json`),
    JSON.stringify({ kind: "cli-discovery", schemaVersion: 1, sessionId, createdAt: new Date().toISOString(), value: discovery }, null, 2),
    "utf8",
  );
}

export function readCliDiscovery(sessionId?: string): { candidates: Array<{ binary: string; version: string; resolvedPath: string; confidenceScore: number }>; selected?: string } {
  if (!fs.existsSync(SESSION_DIR)) return { candidates: [] };

  const findArtifact = (id: string): string | null => {
    const p = path.join(SESSION_DIR, `${id}_cli-discovery.json`);
    return fs.existsSync(p) ? p : null;
  };

  let artifactPath: string | null = null;
  if (sessionId) {
    artifactPath = findArtifact(sessionId);
  }
  if (!artifactPath) {
    const entries = fs.readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith("_cli-discovery.json"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length) artifactPath = path.join(SESSION_DIR, entries[0].f);
  }
  if (!artifactPath) return { candidates: [] };

  try {
    const envelope = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const value = (envelope.value ?? envelope) as Record<string, unknown>;
    const raw = Array.isArray(value.candidates) ? value.candidates as Array<Record<string, unknown>> : [];
    const seen = new Set<string>();
    const candidates = raw
      .filter((c) => {
        const b = String(c.binary ?? "");
        if (!b || seen.has(b)) return false;
        seen.add(b);
        return (c.confidenceScore as number) >= 0.5;
      })
      .sort((a, b) => (b.confidenceScore as number) - (a.confidenceScore as number))
      .map((c) => ({
        binary: String(c.binary),
        version: String(c.version ?? ""),
        resolvedPath: String(c.resolvedPath ?? ""),
        confidenceScore: c.confidenceScore as number,
      }));
    const selected = value.selected ? String((value.selected as Record<string, unknown>).binary ?? "") : undefined;
    return { candidates, selected: selected || undefined };
  } catch {
    return { candidates: [] };
  }
}

export function spawnSladCli(args: string[], callbacks: {
  onLog: (stream: "stdout" | "stderr" | "system", line: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}): ReturnType<typeof spawn> {
  const workspacePath = readTrustConfig().activeWorkspace ?? SLAD_ROOT;
  const tsxBin = path.join(SLAD_ROOT, "packages/cli/node_modules/.bin/tsx");
  const cliEntry = path.join(SLAD_ROOT, "packages/cli/src/cli.ts");
  callbacks.onLog("system", `$ tsx ${cliEntry} ${args.join(" ")} (workspace: ${workspacePath})`);
  const child = spawn(tsxBin, [cliEntry, ...args], {
    cwd: workspacePath,
    env: {
      ...process.env,
      SLAD_WORKSPACE: SLAD_ROOT,
      SLAD_DOCS_PATH: SLAD_DOCS_ROOT,
      CI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => callbacks.onLog("stdout", line));
  });
  child.stderr.on("data", (chunk) => {
    String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => callbacks.onLog("stderr", line));
  });
  child.on("exit", callbacks.onExit);
  child.on("error", (error) => callbacks.onLog("stderr", error.message));
  return child;
}

export function applyEvolveDecisions(
  sessionId: string,
  decisions: Record<string, "apply" | "reject">,
  workspacePath?: string,
): { applied: string[]; errors: string[] } {
  const session = readSessionById(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);

  const evolveArtifact = lastArtifact(session, "evolve");
  if (!evolveArtifact) throw new Error("No evolve artifact found for this session.");

  const updates = Array.isArray(evolveArtifact.value.proposedUpdates)
    ? (evolveArtifact.value.proposedUpdates as Array<Record<string, unknown>>)
    : [];

  const applied: string[] = [];
  const errors: string[] = [];

  for (const [sectionId, decision] of Object.entries(decisions)) {
    if (decision !== "apply") continue;
    const match = sectionId.match(/^evolve-(\d+)$/);
    if (!match) continue;
    const idx = parseInt(match[1], 10) - 1;
    const update = updates[idx];
    if (!update) continue;

    const target = String(update.target ?? "");
    const content = String(update.content ?? "");
    const changeType = String(update.changeType ?? "update");
    if (!target || !content) continue;

    const root = workspacePath ?? readTrustConfig().activeWorkspace ?? SLAD_ROOT;
    const targetPath = path.isAbsolute(target) ? target : path.join(root, target);
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (changeType === "append") {
        const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
        fs.writeFileSync(targetPath, existing + (existing ? "\n\n" : "") + content, "utf8");
      } else {
        fs.writeFileSync(targetPath, content, "utf8");
      }
      applied.push(target);
    } catch (err) {
      errors.push(`${target}: ${(err as Error).message}`);
    }
  }

  const note = `evolve-apply: applied=[${applied.join(", ")}] decisions=${JSON.stringify(decisions)}`;
  const updated: SessionStateLite = { ...session, notes: [...session.notes, note] };
  writeUiSessionFile(updated);

  return { applied, errors };
}

const TRUST_FILE = path.join(SLAD_DOCS_ROOT, "trusted-workspaces.json");

export type TrustConfig = {
  trustedPaths: string[];
  activeWorkspace?: string;
};

export function readTrustConfig(): TrustConfig {
  try {
    const raw = fs.readFileSync(TRUST_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<TrustConfig>;
    return {
      trustedPaths: Array.isArray(parsed.trustedPaths) ? parsed.trustedPaths : [],
      activeWorkspace: typeof parsed.activeWorkspace === "string" ? parsed.activeWorkspace : undefined,
    };
  } catch {
    return { trustedPaths: [] };
  }
}

export function trustWorkspace(workspacePath: string): TrustConfig {
  const cfg = readTrustConfig();
  if (!cfg.trustedPaths.includes(workspacePath)) cfg.trustedPaths.push(workspacePath);
  cfg.activeWorkspace = workspacePath;
  fs.mkdirSync(path.dirname(TRUST_FILE), { recursive: true });
  fs.writeFileSync(TRUST_FILE, JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

export function isWorkspaceTrusted(workspacePath?: string): boolean {
  const target = workspacePath ?? SLAD_ROOT;
  return readTrustConfig().trustedPaths.some(t => target === t || target.startsWith(t + path.sep));
}

export function nextStageForSession(session: UISession): PipelineStage | null {
  return nextPipelineStageFromProgress(session.stages, PIPELINE_STAGES);
}
