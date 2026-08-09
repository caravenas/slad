import fs from "node:fs";
import path from "node:path";
import {
  createSessionState,
  listSessionStateFiles,
  loadSessionStateFileFromDir,
  readActiveSessionId,
  sessionJsonPath,
  setActiveSessionFile,
  upsertSessionAnswers,
  writeSessionFile,
} from "@slad/pipeline";
import { SessionError } from "./errors.js";
import { SessionState, type SessionArtifactKind, type SessionAnswer } from "./types.js";
import { artifactDirSync } from "../persistence/layout.js";
import { readPlan, type ReadPlanResult } from "../persistence/index.js";

function sessionsRoot(cwd: string): string {
  return artifactDirSync("session", cwd);
}

function statePath(id: string, cwd: string): string {
  return sessionJsonPath(sessionsRoot(cwd), id);
}

function legacyStatePath(id: string, cwd: string): string {
  return path.join(cwd, "sessions", id, "state.json");
}

function legacyActiveFilePath(cwd: string): string {
  return path.join(cwd, ".slad-session");
}

function loadSessionStrict(id: string, cwd = process.cwd()): SessionState {
  const current = loadSessionStateFileFromDir<SessionState>(sessionsRoot(cwd), id);
  if (current) {
    try {
      return SessionState.parse(current.value);
    } catch (err) {
      throw new SessionError(`Sesión '${id}' tiene estado inválido.`, {
        sessionId: id,
        path: current.path,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const legacy = legacyStatePath(id, cwd);
  if (!fs.existsSync(legacy)) {
    throw new SessionError(`Sesión '${id}' sin archivo de estado.`, { sessionId: id, path: statePath(id, cwd) });
  }

  try {
    const text = fs.readFileSync(legacy, "utf8");
    const envelope = JSON.parse(text) as Record<string, unknown>;
    const raw = envelope.value ?? envelope;
    return SessionState.parse(raw);
  } catch (err) {
    throw new SessionError(`Sesión '${id}' tiene estado inválido.`, {
      sessionId: id,
      path: legacy,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createSession(intent: string, cwd = process.cwd()): SessionState {
  const session = createSessionState(intent);
  saveSession(session, cwd);
  setActiveSession(session.id, cwd);
  return session;
}

export function getOrCreateSession(intent: string, cwd = process.cwd()): SessionState {
  const existing = getActiveSession(cwd);
  if (existing) return existing;
  return createSession(intent, cwd);
}

export function resumeSession(id?: string, cwd = process.cwd()): SessionState | null {
  const sessionId = id ?? getActiveSessionId(cwd);
  if (!sessionId) return null;

  const session = loadSession(sessionId, cwd);
  if (!session) return null;

  setActiveSession(session.id, cwd);
  return session;
}

export function saveSession(session: SessionState, cwd = process.cwd()): void {
  writeSessionFile(sessionsRoot(cwd), session);
}

export function setActiveSession(id: string, cwd = process.cwd()): void {
  setActiveSessionFile(sessionsRoot(cwd), id);
}

export function getActiveSessionId(cwd = process.cwd()): string | null {
  const id = readActiveSessionId(sessionsRoot(cwd));
  if (!id) {
    const legacy = legacyActiveFilePath(cwd);
    if (!fs.existsSync(legacy)) return null;
    return fs.readFileSync(legacy, "utf8").trim() || null;
  }
  return id;
}

export function loadSession(id: string, cwd = process.cwd()): SessionState | null {
  const p = statePath(id, cwd);
  const legacy = legacyStatePath(id, cwd);
  if (!fs.existsSync(p) && !fs.existsSync(legacy)) return null;
  try {
    return loadSessionStrict(id, cwd);
  } catch {
    return null;
  }
}

export function getActiveSession(cwd = process.cwd()): SessionState | null {
  const id = getActiveSessionId(cwd);
  if (!id) return null;
  return loadSession(id, cwd);
}

export function hasPersistedActiveSession(cwd = process.cwd()): boolean {
  return getActiveSession(cwd) !== null;
}

export function listSessions(cwd = process.cwd()): SessionState[] {
  const root = sessionsRoot(cwd);
  if (!fs.existsSync(root)) return [];

  const current = listSessionStateFiles<SessionState>(root)
    .map((entry) => {
      try {
        return SessionState.parse(entry.value);
      } catch {
        return null;
      }
    })
    .filter((session): session is SessionState => Boolean(session));
  const fileCount = fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json") && !entry.includes("_cli-discovery"))
    .length;

  if (current.length === fileCount) {
    return current;
  }

  return fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json") && !entry.includes("_cli-discovery"))
    .map((entry) => loadSessionStrict(path.basename(entry, ".json"), cwd))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendArtifact(
  session: SessionState,
  kind: SessionArtifactKind,
  filePath: string,
  taskId?: string,
): SessionState {
  return {
    ...session,
    currentPhase: kind,
    artifacts: [
      ...session.artifacts,
      {
        kind,
        path: filePath,
        createdAt: new Date().toISOString(),
        ...(taskId ? { taskId } : {}),
      },
    ],
  };
}

export function upsertArtifact(
  session: SessionState,
  kind: SessionArtifactKind,
  filePath: string,
  taskId?: string,
): SessionState {
  const replacement = {
    kind,
    path: filePath,
    createdAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
  const firstExistingIndex = session.artifacts.findIndex((artifact) => artifact.kind === kind);
  const filtered = session.artifacts.filter((artifact) => artifact.kind !== kind);
  const insertAt = firstExistingIndex === -1
    ? filtered.length
    : session.artifacts
      .slice(0, firstExistingIndex)
      .filter((artifact) => artifact.kind !== kind).length;

  return {
    ...session,
    currentPhase: kind,
    artifacts: [
      ...filtered.slice(0, insertAt),
      replacement,
      ...filtered.slice(insertAt),
    ],
  };
}

export function appendAnswers(
  session: SessionState,
  taskId: string,
  answers: Record<string, string>,
): SessionState {
  const newAnswers: SessionAnswer[] = Object.entries(answers).map(([questionId, answer]) => ({
    taskId,
    questionId,
    answer,
    askedAt: new Date().toISOString(),
  }));
  return { ...session, humanAnswers: [...session.humanAnswers, ...newAnswers] };
}

export function upsertAnswers(
  session: SessionState,
  taskId: string,
  answers: Record<string, string>,
): SessionState {
  return upsertSessionAnswers(session, taskId, answers);
}

export function lastArtifactPath(
  session: SessionState,
  kind: SessionArtifactKind,
): string | undefined {
  return [...session.artifacts].reverse().find((a) => a.kind === kind)?.path;
}

/**
 * Reads the session's most recent plan artifact, normalized to a v2 envelope.
 * Returns null when the session has no plan (or its file is gone).
 */
export async function readSessionPlan(session: SessionState): Promise<ReadPlanResult | null> {
  const planPath = lastArtifactPath(session, "plan");
  if (!planPath || !fs.existsSync(planPath)) return null;
  return readPlan(planPath);
}

/**
 * True only when the session's latest plan carries an explicit human approval.
 * A missing, legacy, pending, rejected, or superseded plan is not approved.
 */
export async function isSessionPlanApproved(session: SessionState): Promise<boolean> {
  const plan = await readSessionPlan(session);
  return plan?.value.approval.status === "approved";
}

export function sessionContextBlock(session: SessionState): string {
  if (session.humanAnswers.length === 0) return "";
  const lines = session.humanAnswers.map((a) => `- [${a.taskId}/${a.questionId}] ${a.answer}`);
  return `Decisiones humanas previas en esta sesión:\n${lines.join("\n")}`;
}
