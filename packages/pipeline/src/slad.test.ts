import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTIVE_SESSION_FILE,
  archiveSessionFile,
  artifactFilePath,
  artifactLogDir,
  artifactLogDirName,
  commandForMode,
  commandForStage,
  AUTO_PIPELINE_STAGES,
  SLAD_PIPELINE_STAGES,
  activePipelineStageIndex,
  activeSessionFilePath,
  autoReportPath,
  autoPipelineCheckpointPath,
  clearAutoPipelineCheckpoint,
  completeAutoPipelineStage,
  completedAutoStagesThrough,
  createAutoPipelineProgress,
  createAutoPipelineReport,
  createPipelineServices,
  createSessionEnvelope,
  createSessionId,
  createSessionState,
  emptyTelemetryStats,
  expectedAutoPipelineStages,
  extractMarkdownSection,
  findSessionFilePath,
  filesystemSafeTimestamp,
  getAutoPipelineStatus,
  isAutoPipelineStage,
  isSessionFileName,
  isSladPipelineStage,
  isSladRunMode,
  listSessionFilePaths,
  listSessionStateFiles,
  loadAutoPipelineCheckpoint,
  loadSessionStateFileFromDir,
  nextStageAfter,
  nextPipelineStageFromProgress,
  parseAgentRunLog,
  parseSladHumanAnswersRequest,
  parseSladPipelineRunRequest,
  parseSladWorkRequest,
  readAgentRunLog,
  readActiveSessionId,
  readDataFile,
  readSessionStateFile,
  saveAutoPipelineCheckpoint,
  sessionJsonPath,
  slugifySessionIntent,
  stageArtifactDir,
  stageArtifactDirName,
  stageStatusesForSession,
  lastStageArtifact,
  listStageArtifacts,
  localizeStageArtifactPath,
  summarizeTelemetry,
  telemetryLogPath,
  timestampedArtifactFilePath,
  timestampedRunArtifactFilePath,
  upsertSessionAnswers,
  writeAutoReport,
  writeSessionFile,
} from "./index.js";
test("stageArtifactDirName centraliza el mapping de stages", () => {
  assert.equal(stageArtifactDirName("explore"), "explores");
  assert.equal(stageArtifactDirName("snapshot"), "snapshots");
  assert.equal(stageArtifactDirName("plan"), "plans");
  assert.equal(stageArtifactDirName("run"), "runs");
  assert.equal(stageArtifactDirName("learn"), "learnings");
  assert.equal(stageArtifactDirName("evolve"), "evolution");
  assert.equal(stageArtifactDirName("custom"), "custom");
});

test("artifact log helpers centralizan directorios y nombres de archivos persistidos", () => {
  const docsRoot = "/tmp/slad-docs";
  const createdAt = "2026-05-25T12:34:56.789Z";

  assert.equal(artifactLogDirName("session"), "sessions");
  assert.equal(artifactLogDirName("run"), "runs");
  assert.equal(artifactLogDir(docsRoot, "plan"), path.join(docsRoot, "log", "plans"));
  assert.equal(
    artifactFilePath(docsRoot, "learn", "session-1", "task-7"),
    path.join(docsRoot, "log", "learnings", "session-1_task-7.json"),
  );
  assert.equal(
    timestampedArtifactFilePath(docsRoot, "session", "session-1", createdAt),
    path.join(docsRoot, "log", "sessions", "session-1__2026-05-25T12-34-56-789Z.json"),
  );
  assert.equal(
    timestampedRunArtifactFilePath(docsRoot, "session-1", "task-9", createdAt),
    path.join(docsRoot, "log", "runs", "session-1_task-9__2026-05-25T12-34-56-789Z.json"),
  );
});

test("artifact helpers centralizan discovery y status de stages para sesiones", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-stage-artifacts-"));
  try {
    const session = createSessionState("pipeline ui", { id: "session-1", createdAt: "2026-05-25T10:00:00.000Z" });
    const logRoot = path.join(tmpDir, "log");
    const runDir = stageArtifactDir(logRoot, "run");
    const planDir = stageArtifactDir(logRoot, "plan");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(planDir, { recursive: true });

    const relativeRunPath = path.join("docs", "log", "runs", "session-1_task-1.md");
    const runPath = path.join(runDir, "session-1_task-1.md");
    fs.writeFileSync(runPath, [
      "---",
      "kind: run",
      "sessionId: session-1",
      "taskId: task-1",
      "createdAt: 2026-05-25T10:05:00.000Z",
      "value:",
      "  status: blocked",
      "  followUps:",
      "    - pedir aprobación",
      "---",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(planDir, "session-1.json"), JSON.stringify({
      kind: "plan",
      sessionId: "session-1",
      createdAt: "2026-05-25T10:02:00.000Z",
      value: { status: "completed", summary: "plan listo" },
    }, null, 2), "utf8");

    const persisted = {
      ...session,
      artifacts: [
        {
          kind: "run" as const,
          path: relativeRunPath,
          createdAt: "2026-05-25T10:05:00.000Z",
          taskId: "task-1",
        },
      ],
    };

    assert.equal(localizeStageArtifactPath(logRoot, relativeRunPath, "run"), runPath);
    assert.deepEqual(listStageArtifacts(logRoot, persisted, "run").map((artifact) => artifact.path), [runPath]);
    assert.equal(lastStageArtifact(logRoot, persisted, "plan")?.path, path.join(planDir, "session-1.json"));
    assert.deepEqual(stageStatusesForSession(logRoot, persisted), ["pending", "pending", "done", "await", "pending", "pending"]);
    assert.deepEqual(stageStatusesForSession(logRoot, {
      ...persisted,
      humanAnswers: [{ taskId: "task-1", questionId: "blocked_action", answer: "__retry__", askedAt: "2026-05-25T10:06:00.000Z" }],
    }), ["pending", "pending", "done", "failed", "pending", "pending"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("artifact helpers tratan awaiting_human resuelto como pending para reanudar", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-awaiting-human-"));
  try {
    const logRoot = path.join(tmpDir, "log");
    const runDir = stageArtifactDir(logRoot, "run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "session-2_task-1.json"), JSON.stringify({
      kind: "run",
      sessionId: "session-2",
      taskId: "task-1",
      createdAt: "2026-05-25T10:05:00.000Z",
      value: {
        status: "awaiting_human",
        questions: [{ id: "q1", prompt: "¿seguimos?" }],
      },
    }, null, 2), "utf8");

    const session = {
      ...createSessionState("pipeline ui", { id: "session-2", createdAt: "2026-05-25T10:00:00.000Z" }),
      humanAnswers: [{ taskId: "task-1", questionId: "q1", answer: "sí", askedAt: "2026-05-25T10:06:00.000Z" }],
    };

    assert.deepEqual(stageStatusesForSession(logRoot, session), ["pending", "pending", "pending", "pending", "pending", "pending"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("telemetry helpers parsean LDJSON y resumen métricas compartidas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-telemetry-"));
  try {
    const logRoot = path.join(tmpDir, "log");
    const logPath = telemetryLogPath(logRoot);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const now = new Date().toISOString();
    const validEntries = [
      {
        sessionId: "s1",
        intent: "telemetry 1",
        startedAt: now,
        completedAt: now,
        durationMs: 4000,
        commandUsed: "ask" as const,
        stagesCompleted: ["explore"],
        debateUsed: false,
        pipelineStatus: "completed" as const,
      },
      {
        sessionId: "s2",
        intent: "telemetry 2",
        startedAt: now,
        completedAt: now,
        durationMs: 8000,
        commandUsed: "work-debate" as const,
        stagesCompleted: ["explore", "snapshot", "plan"],
        debateUsed: true,
        debateConsensusScores: { explore: 0.8, plan: 0.6 },
        classifierResult: {
          suggestedMode: "work-debate" as const,
          confidence: 0.9,
          rationale: "usar debate",
          shownToUser: true,
          userAccepted: true,
        },
        pipelineStatus: "partial" as const,
      },
      {
        sessionId: "s3",
        intent: "telemetry 3",
        startedAt: now,
        completedAt: now,
        durationMs: 12000,
        commandUsed: "work" as const,
        stagesCompleted: ["explore", "snapshot", "plan", "run"],
        debateUsed: false,
      },
    ];

    const text = [
      JSON.stringify(validEntries[0]),
      "{not-json",
      JSON.stringify(validEntries[1]),
      JSON.stringify({ nope: true }),
      JSON.stringify(validEntries[2]),
      "",
    ].join("\n");
    fs.writeFileSync(logPath, text, "utf8");

    assert.deepEqual(parseAgentRunLog(text), validEntries);
    assert.deepEqual(readAgentRunLog(logRoot), validEntries);
    assert.deepEqual(readAgentRunLog(path.join(tmpDir, "missing-log-root")), []);
    assert.deepEqual(emptyTelemetryStats(), {
      totalRuns: 0,
      byCommand: { ask: 0, work: 0, "work-debate": 0 },
      byStatus: { completed: 0, partial: 0, failed: 0, unknown: 0 },
      debateRuns: 0,
      avgDebateConsensus: null,
      classifierShown: 0,
      classifierAccepted: 0,
      avgDurationMs: null,
    });

    const summary = summarizeTelemetry(validEntries);
    assert.equal(summary.totalRuns, 3);
    assert.deepEqual(summary.byCommand, { ask: 1, work: 1, "work-debate": 1 });
    assert.deepEqual(summary.byStatus, { completed: 1, partial: 1, failed: 0, unknown: 1 });
    assert.equal(summary.debateRuns, 1);
    assert.ok(summary.avgDebateConsensus !== null);
    assert.ok(Math.abs(summary.avgDebateConsensus - 0.7) < 0.001);
    assert.equal(summary.classifierShown, 1);
    assert.equal(summary.classifierAccepted, 1);
    assert.ok(summary.avgDurationMs !== null);
    assert.ok(Math.abs(summary.avgDurationMs - 8000) < 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("nextStageAfter sigue el orden de SLAD_PIPELINE_STAGES", () => {
  assert.deepEqual(SLAD_PIPELINE_STAGES, ["explore", "snapshot", "plan", "run", "learn", "evolve"]);
  assert.equal(nextStageAfter("explore"), "snapshot");
  assert.equal(nextStageAfter("run"), "learn");
  assert.equal(nextStageAfter("evolve"), null);
});

test("helpers de progreso de pipeline centralizan stage activo y siguiente stage", () => {
  assert.equal(activePipelineStageIndex(["done", "await", "pending"]), 1);
  assert.equal(activePipelineStageIndex(["done", "failed", "pending"]), 1);
  assert.equal(activePipelineStageIndex(["done", "progress", "pending"]), 1);
  assert.equal(activePipelineStageIndex(["done", "done", "done"]), 2);
  assert.equal(activePipelineStageIndex([]), 0);

  assert.equal(nextPipelineStageFromProgress(["done", "pending", "pending"]), "snapshot");
  assert.equal(nextPipelineStageFromProgress(["done", "progress", "pending"]), "snapshot");
  assert.equal(nextPipelineStageFromProgress(["done", "done", "done", "done", "done", "done"]), null);
});

test("guards de stages aceptan solo valores válidos", () => {
  assert.deepEqual(AUTO_PIPELINE_STAGES, ["explore", "snapshot", "plan", "run", "learn"]);
  assert.equal(isSladPipelineStage("plan"), true);
  assert.equal(isSladPipelineStage("invalid"), false);
  assert.equal(isAutoPipelineStage("learn"), true);
  assert.equal(isAutoPipelineStage("evolve"), false);
  assert.equal(isSladRunMode("ask"), true);
  assert.equal(isSladRunMode("work-debate"), true);
  assert.equal(isSladRunMode("invalid"), false);
});

test("parseSladPipelineRunRequest normaliza stage/harness y descarta payload inválido", () => {
  assert.deepEqual(
    parseSladPipelineRunRequest({
      sessionId: "session_123",
      stage: "run",
      agent: "codex",
      model: "gpt-5.5",
      harness: "strict",
    }),
    {
      sessionId: "session_123",
      stage: "run",
      agent: "codex",
      model: "gpt-5.5",
      harness: "strict",
    },
  );

  assert.deepEqual(
    parseSladPipelineRunRequest({
      sessionId: "session_123",
      stage: "plan",
      harness: "wat",
    }),
    {
      sessionId: "session_123",
      stage: "plan",
      harness: "on",
    },
  );

  assert.equal(parseSladPipelineRunRequest({ sessionId: "session_123", stage: "invalid" }), null);
  assert.equal(parseSladPipelineRunRequest({ sessionId: "", stage: "plan" }), null);
});

test("parseSladHumanAnswersRequest normaliza answers a strings y valida campos requeridos", () => {
  assert.deepEqual(
    parseSladHumanAnswersRequest({
      sessionId: "session_123",
      stage: "explore",
      taskId: "task_456",
      answers: {
        q1: "sí",
        q2: 42,
        q3: false,
      },
    }),
    {
      sessionId: "session_123",
      stage: "explore",
      taskId: "task_456",
      answers: {
        q1: "sí",
        q2: "42",
        q3: "false",
      },
    },
  );

  assert.equal(parseSladHumanAnswersRequest({ sessionId: "session_123", stage: "explore", answers: {} }), null);
  assert.equal(parseSladHumanAnswersRequest({ sessionId: "session_123", stage: "invalid", answers: { q1: "x" } }), null);
});

test("parseSladWorkRequest normaliza intent/mode y descarta payload inválido", () => {
  assert.deepEqual(
    parseSladWorkRequest({
      intent: "  extraer SDK  ",
      mode: "work-debate",
      agent: "codex",
      model: "gpt-5.5",
      debateModels: "gpt-5.5,claude-sonnet-4-6",
    }),
    {
      intent: "extraer SDK",
      mode: "work-debate",
      agent: "codex",
      model: "gpt-5.5",
      debateModels: "gpt-5.5,claude-sonnet-4-6",
    },
  );

  assert.deepEqual(
    parseSladWorkRequest({ intent: "resolver tarea", mode: "wat" }),
    {
      intent: "resolver tarea",
      mode: "work",
    },
  );

  assert.equal(parseSladWorkRequest({ intent: "x" }), null);
  assert.equal(parseSladWorkRequest({}), null);
});

test("command builders centralizan el contracto CLI para stages y modos", () => {
  assert.deepEqual(commandForStage("explore", "inspeccionar repo", { agent: "codex", model: "gpt-5.5" }), [
    "explore",
    "inspeccionar repo",
    "--agent",
    "codex",
    "--model",
    "gpt-5.5",
  ]);
  assert.deepEqual(commandForStage("run", "ignorado", { harness: "strict" }), [
    "run",
    "--auto",
    "--harness",
    "strict",
    "--non-interactive",
  ]);
  assert.deepEqual(commandForMode("ask", "¿qué sigue?", { agent: "codex" }), [
    "ask",
    "¿qué sigue?",
    "--agent",
    "codex",
  ]);
  assert.deepEqual(commandForMode("work-debate", "resolver bug", { model: "gpt-5.5", debateModels: "a,b" }), [
    "work",
    "resolver bug",
    "--debate",
    "--model",
    "gpt-5.5",
    "--debate-models",
    "a,b",
  ]);
});

test("session helpers centralizan ids, envelopes y answers", () => {
  const now = new Date("2026-05-25T15:45:00");
  const createdAt = now.toISOString();
  const session = createSessionState("  Extraer sesión ágil  ", { createdAt, trimIntent: true });

  assert.equal(slugifySessionIntent("Sesión ágil / Plan"), "sesion-agil-plan");
  assert.match(createSessionId(), /^[0-9a-f]{12}$/);
  assert.match(session.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(
    { ...session, id: "<hash>" },
    { id: "<hash>", createdAt, intent: "Extraer sesión ágil", artifacts: [], humanAnswers: [], notes: [] },
  );

  assert.deepEqual(createSessionEnvelope(session), {
    kind: "session",
    schemaVersion: 1,
    sessionId: session.id,
    createdAt,
    value: session,
  });

  const updated = upsertSessionAnswers(
    {
      ...session,
      humanAnswers: [
        { taskId: "plan", questionId: "q1", answer: "vieja", askedAt: "2026-05-25T15:40:00.000Z" },
        { taskId: "run", questionId: "q2", answer: "mantener", askedAt: "2026-05-25T15:41:00.000Z" },
      ],
    },
    "plan",
    { q1: "nueva", q3: "extra" },
    "2026-05-25T15:46:00.000Z",
  );
  assert.deepEqual(updated.humanAnswers, [
    { taskId: "run", questionId: "q2", answer: "mantener", askedAt: "2026-05-25T15:41:00.000Z" },
    { taskId: "plan", questionId: "q1", answer: "nueva", askedAt: "2026-05-25T15:46:00.000Z" },
    { taskId: "plan", questionId: "q3", answer: "extra", askedAt: "2026-05-25T15:46:00.000Z" },
  ]);
});

test("session fs helpers persisten archivo y active session", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-session-"));
  try {
    const session = createSessionState("pipeline sdk", { createdAt: "2026-05-25T16:00:00.000Z" });
    const sessionFile = writeSessionFile(tmpDir, session);
    assert.equal(sessionFile, sessionJsonPath(tmpDir, session.id));
    assert.equal(activeSessionFilePath(tmpDir), path.join(tmpDir, ACTIVE_SESSION_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, "utf8")), createSessionEnvelope(session));

    fs.writeFileSync(activeSessionFilePath(tmpDir), `${session.id}\n`, "utf8");
    assert.equal(readActiveSessionId(tmpDir), session.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session file discovery helpers prefieren json y filtran artifacts no-session", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-session-files-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "alpha.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmpDir, "alpha.md"), "---\nid: alpha\n---", "utf8");
    fs.writeFileSync(path.join(tmpDir, "beta.md"), "---\nid: beta\n---", "utf8");
    fs.writeFileSync(path.join(tmpDir, "beta_cli-discovery.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmpDir, ACTIVE_SESSION_FILE), "alpha\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "ignore", "utf8");

    assert.equal(isSessionFileName("alpha.json"), true);
    assert.equal(isSessionFileName("beta.md"), true);
    assert.equal(isSessionFileName("beta_cli-discovery.json"), false);
    assert.equal(isSessionFileName(ACTIVE_SESSION_FILE), false);

    assert.deepEqual(
      listSessionFilePaths(tmpDir).map((filePath) => path.basename(filePath)).sort(),
      ["alpha.json", "alpha.md", "beta.md"],
    );
    assert.equal(findSessionFilePath(tmpDir, "alpha"), path.join(tmpDir, "alpha.json"));
    assert.equal(findSessionFilePath(tmpDir, "beta"), path.join(tmpDir, "beta.md"));
    assert.equal(findSessionFilePath(tmpDir, "missing"), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session directory helpers cargan una sesión puntual y listan sesiones ordenadas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-session-dir-"));
  try {
    const older = createSessionState("older session", { id: "older", createdAt: "2026-05-25T10:00:00.000Z" });
    const newer = createSessionState("newer session", { id: "newer", createdAt: "2026-05-25T11:00:00.000Z" });
    writeSessionFile(tmpDir, older);
    writeSessionFile(tmpDir, newer);
    fs.writeFileSync(path.join(tmpDir, "newer_cli-discovery.json"), "{}", "utf8");

    const loaded = loadSessionStateFileFromDir(tmpDir, "newer");
    assert.ok(loaded);
    assert.equal(loaded?.session.id, "newer");
    assert.equal(loaded?.session.intent, "newer session");
    assert.equal(loadSessionStateFileFromDir(tmpDir, "missing"), null);

    const listed = listSessionStateFiles(tmpDir);
    assert.deepEqual(listed.map((entry) => entry.session.id), ["newer", "older"]);
    assert.deepEqual(listed.map((entry) => path.basename(entry.path)), ["newer.json", "older.json"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session data helpers leen JSON/Markdown y normalizan sesiones", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-session-data-"));
  try {
    const runFile = path.join(tmpDir, "run.md");
    fs.writeFileSync(runFile, [
      "---",
      "kind: run",
      "sessionId: session_123",
      "taskId: task_456",
      "createdAt: 2026-05-25T12:00:00.000Z",
      "value:",
      "  status: completed",
      "  summary: shipped",
      "---",
      "",
      "## Summary",
      "markdown summary",
      "",
    ].join("\n"), "utf8");

    const sessionFile = path.join(tmpDir, "session.md");
    fs.writeFileSync(sessionFile, [
      "---",
      "kind: session",
      "sessionId: markdown-session",
      "createdAt: 2026-05-25T13:00:00.000Z",
      "value:",
      "  notes:",
      "    - keep",
      "---",
      "",
      "## Intent",
      "  Markdown-first session  ",
      "",
      "## Notes",
      "hola",
      "",
    ].join("\n"), "utf8");

    assert.deepEqual(readDataFile(runFile), {
      kind: "run",
      sessionId: "session_123",
      taskId: "task_456",
      createdAt: "2026-05-25T12:00:00.000Z",
      value: {
        status: "completed",
        summary: "shipped",
      },
      raw: fs.readFileSync(runFile, "utf8"),
      path: runFile,
    });

    const parsedSession = readSessionStateFile(sessionFile);
    assert.equal(parsedSession?.session.id, "session");
    assert.equal(parsedSession?.session.createdAt, "2026-05-25T13:00:00.000Z");
    assert.equal(parsedSession?.session.intent, "Markdown-first session");
    assert.deepEqual(parsedSession?.session.notes, ["keep"]);
    assert.equal(extractMarkdownSection(parsedSession?.raw ?? "", "Intent"), "Markdown-first session");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("archiveSessionFile actualiza sesiones JSON y markdown", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-archive-session-"));
  try {
    const archivedAt = "2026-05-25T14:00:00.000Z";
    const jsonSession = createSessionState("json session", { id: "json-session", createdAt: "2026-05-25T13:55:00.000Z" });
    writeSessionFile(tmpDir, jsonSession);
    const mdPath = path.join(tmpDir, "markdown-session.md");
    fs.writeFileSync(mdPath, [
      "---",
      "kind: session",
      "sessionId: markdown-session",
      "createdAt: 2026-05-25T13:58:00.000Z",
      "---",
      "",
      "## Intent",
      "markdown session",
      "",
    ].join("\n"), "utf8");

    assert.deepEqual(archiveSessionFile(tmpDir, "json-session", archivedAt), {
      archivedAt,
      filePath: path.join(tmpDir, "json-session.json"),
    });
    assert.equal(readSessionStateFile(path.join(tmpDir, "json-session.json"))?.session.archivedAt, archivedAt);

    assert.deepEqual(archiveSessionFile(tmpDir, "markdown-session", archivedAt), {
      archivedAt,
      filePath: mdPath,
    });
    assert.match(fs.readFileSync(mdPath, "utf8"), /archivedAt: 2026-05-25T14:00:00.000Z/);

    assert.throws(() => archiveSessionFile(tmpDir, "missing", archivedAt), (error: unknown) => {
      return (error as { code?: string }).code === "ENOENT";
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("helpers de auto pipeline centralizan orden y status", () => {
  assert.deepEqual(completedAutoStagesThrough("explore"), ["explore"]);
  assert.deepEqual(completedAutoStagesThrough("plan"), ["explore", "snapshot", "plan"]);

  assert.deepEqual(expectedAutoPipelineStages({ dryRun: true }), ["explore", "snapshot", "plan"]);
  assert.deepEqual(expectedAutoPipelineStages({ skipLearn: true }), ["explore", "snapshot", "plan", "run"]);
  assert.deepEqual(expectedAutoPipelineStages(), ["explore", "snapshot", "plan", "run", "learn"]);

  assert.equal(
    getAutoPipelineStatus({
      dryRun: true,
      stagesCompleted: ["explore", "snapshot", "plan"],
      stoppedAt: "plan",
      stopReason: "Dry run — solo explore+snapshot+plan",
    }),
    "completed",
  );
  assert.equal(getAutoPipelineStatus({ stagesCompleted: ["explore", "snapshot"] }), "partial");
  assert.equal(getAutoPipelineStatus({ stagesCompleted: [] }), "failed");
});

test("auto checkpoint helpers persisten, leen y limpian estado", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-checkpoint-"));
  try {
    const checkpoint = {
      intent: "extraer pipeline sdk",
      sessionId: "session_123",
      lastStageCompleted: "plan" as const,
      artifacts: { explore: "docs/log/explores/session_123.json" },
      budgetState: { inputTokens: 10, outputTokens: 20 },
      savedAt: "2026-05-25T00:00:00.000Z",
    };

    assert.equal(
      autoPipelineCheckpointPath(tmpDir),
      path.join(tmpDir, ".slad-os", "auto-checkpoint.json"),
    );

    saveAutoPipelineCheckpoint(checkpoint, tmpDir);
    assert.deepEqual(loadAutoPipelineCheckpoint(tmpDir), checkpoint);

    clearAutoPipelineCheckpoint(tmpDir);
    assert.equal(loadAutoPipelineCheckpoint(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadAutoPipelineCheckpoint tolera JSON inválido", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-checkpoint-invalid-"));
  try {
    const checkpointFile = autoPipelineCheckpointPath(tmpDir);
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.writeFileSync(checkpointFile, "{not-json", "utf8");

    assert.equal(loadAutoPipelineCheckpoint(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("auto pipeline progress helpers restauran y persisten progreso incremental", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-progress-"));
  try {
    const initial = createAutoPipelineProgress();
    assert.deepEqual(initial.stagesCompleted, []);
    assert.deepEqual(initial.artifacts, {});
    assert.equal(initial.checkpoint, null);

    const afterExplore = completeAutoPipelineStage({
      intent: "extraer pipeline sdk",
      sessionId: "session_123",
      stage: "explore",
      artifactPath: "/tmp/explore.json",
      budgetState: { inputTokens: 10 },
      progress: initial,
      savedAt: "2026-05-25T00:00:00.000Z",
      cwd: tmpDir,
    });

    assert.deepEqual(afterExplore.stagesCompleted, ["explore"]);
    assert.deepEqual(afterExplore.artifacts, { explore: "/tmp/explore.json" });
    assert.deepEqual(loadAutoPipelineCheckpoint(tmpDir), afterExplore.checkpoint);

    const restored = createAutoPipelineProgress(afterExplore.checkpoint);
    assert.deepEqual(restored.stagesCompleted, ["explore"]);
    assert.deepEqual(restored.artifacts, { explore: "/tmp/explore.json" });

    const afterPlan = completeAutoPipelineStage({
      intent: "extraer pipeline sdk",
      sessionId: "session_123",
      stage: "plan",
      artifactPath: "/tmp/plan.json",
      budgetState: { inputTokens: 30 },
      progress: restored,
      savedAt: "2026-05-25T00:10:00.000Z",
      cwd: tmpDir,
    });

    assert.deepEqual(afterPlan.stagesCompleted, ["explore", "plan"]);
    assert.deepEqual(afterPlan.artifacts, {
      explore: "/tmp/explore.json",
      plan: "/tmp/plan.json",
    });
    assert.deepEqual(loadAutoPipelineCheckpoint(tmpDir), afterPlan.checkpoint);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("helpers de auto report generan rutas y payload persistido", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pipeline-auto-report-"));
  try {
    const createdAt = "2026-05-25T12:34:56.789Z";
    const report = { status: "completed", tasks: 3 };

    assert.equal(filesystemSafeTimestamp(createdAt), "2026-05-25T12-34-56-789Z");
    assert.equal(
      autoReportPath({ docsRoot: tmpDir, createdAt, basename: "auto" }),
      path.join(tmpDir, "log", "auto", "2026-05-25T12-34-56-789Z-auto.json"),
    );

    const filePath = writeAutoReport(report, { docsRoot: tmpDir, createdAt, basename: "auto" });
    assert.equal(filePath, path.join(tmpDir, "log", "auto", "2026-05-25T12-34-56-789Z-auto.json"));

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
      kind: "auto-report",
      schemaVersion: 1,
      createdAt,
      value: report,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("createAutoPipelineReport normaliza dry-run y clona artifacts/tasksSummary", () => {
  const report = createAutoPipelineReport({
    intent: "extraer pipeline sdk",
    startedAt: "2026-05-25T00:00:00.000Z",
    completedAt: "2026-05-25T00:05:00.000Z",
    durationMs: 300000,
    dryRun: true,
    stagesCompleted: ["explore", "snapshot", "plan"],
    stoppedAt: "plan",
    stopReason: "Dry run — solo explore+snapshot+plan",
    artifacts: { plan: "/tmp/plan.json" },
    budget: { inputTokens: 10, outputTokens: 20 },
    tasksSummary: { total: 3, completed: 2, failed: 0, skipped: 1 },
  });

  assert.equal(report.status, "completed");
  assert.equal(report.stoppedAt, undefined);
  assert.equal(report.stopReason, undefined);
  assert.deepEqual(report.artifacts, { plan: "/tmp/plan.json" });
  assert.deepEqual(report.tasksSummary, { total: 3, completed: 2, failed: 0, skipped: 1 });
});

test("createPipelineServices arma el bag de dependencias sin claves vacías", () => {
  const provider = { supportsToolUse: true };
  const services = createPipelineServices({
    provider: provider as never,
    extras: { sessionId: "s_123", retries: 2 },
  });

  assert.equal(services.provider, provider);
  assert.equal(services.sessionId, "s_123");
  assert.equal(services.retries, 2);
  assert.equal("tools" in services, false);
  assert.equal("cache" in services, false);
});
