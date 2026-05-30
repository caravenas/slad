import fs from "node:fs";
import path from "node:path";
import type { SessionState } from "@slad/shared";

export const ACTIVE_SESSION_FILE = ".active-session";
export const SESSION_FILE_EXTENSIONS = [".json", ".md"] as const;

export interface SessionEnvelope<T extends SessionState = SessionState> {
  kind: "session";
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  value: T;
}

export interface ParsedDataFile<T extends Record<string, unknown> = Record<string, unknown>> {
  kind: string;
  sessionId: string;
  taskId?: string;
  createdAt?: string;
  value: T;
  raw: string;
  path: string;
}

export interface ParsedSessionStateFile<T extends SessionState = SessionState> extends ParsedDataFile<Record<string, unknown>> {
  session: T;
}

export interface CreateSessionStateOptions {
  id?: string;
  createdAt?: string;
  trimIntent?: boolean;
}

export function slugifySessionIntent(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export function createSessionId(intent: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  return `${date}-${time}-${slugifySessionIntent(intent)}`;
}

export function createSessionState(intent: string, options: CreateSessionStateOptions = {}): SessionState {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    id: options.id ?? createSessionId(intent, new Date(createdAt)),
    createdAt,
    intent: options.trimIntent ? intent.trim() : intent,
    artifacts: [],
    humanAnswers: [],
    notes: [],
  };
}

export function createSessionEnvelope<T extends SessionState>(session: T): SessionEnvelope<T> {
  return {
    kind: "session",
    schemaVersion: 1,
    sessionId: session.id,
    createdAt: session.createdAt,
    value: session,
  };
}

export function sessionJsonPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.json`);
}

export function isSessionFileName(entry: string): boolean {
  return SESSION_FILE_EXTENSIONS.some((extension) => entry.endsWith(extension)) && !entry.includes("_cli-discovery");
}

export function listSessionFilePaths(sessionDir: string): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  return fs.readdirSync(sessionDir)
    .filter((entry) => isSessionFileName(entry))
    .map((entry) => path.join(sessionDir, entry));
}

export function findSessionFilePath(sessionDir: string, sessionId: string): string | null {
  const jsonPath = sessionJsonPath(sessionDir, sessionId);
  if (fs.existsSync(jsonPath)) return jsonPath;
  return listSessionFilePaths(sessionDir)
    .find((filePath) => path.basename(filePath, path.extname(filePath)) === sessionId) ?? null;
}

export function readDataFile<T extends Record<string, unknown> = Record<string, unknown>>(
  filePath: string,
): ParsedDataFile<T> | null {
  const raw = safeRead(filePath);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const value = (json.value ?? json) as T;
    return {
      kind: String(json.kind ?? value.kind ?? ""),
      sessionId: String(json.sessionId ?? value.sessionId ?? ""),
      taskId: typeof json.taskId === "string" ? json.taskId : undefined,
      createdAt: typeof json.createdAt === "string" ? json.createdAt : undefined,
      value,
      raw,
      path: filePath,
    };
  } catch {
    const frontmatter = parseFrontmatter(raw);
    const value = (frontmatter.value && typeof frontmatter.value === "object"
      ? frontmatter.value
      : frontmatter) as T;
    return {
      kind: String(frontmatter.kind ?? ""),
      sessionId: String(frontmatter.sessionId ?? ""),
      taskId: typeof frontmatter.taskId === "string" ? frontmatter.taskId : undefined,
      createdAt: typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : undefined,
      value,
      raw,
      path: filePath,
    };
  }
}

export function readSessionStateFile<T extends SessionState = SessionState>(
  filePath: string,
): ParsedSessionStateFile<T> | null {
  const parsed = readDataFile(filePath);
  if (!parsed) return null;
  const value = parsed.value;
  const session = (value.value ?? value.session ?? value) as Partial<T>;
  const id = typeof session.id === "string" ? session.id : path.basename(filePath, path.extname(filePath));
  const bodyIntent = extractMarkdownSection(parsed.raw, "Intent");
  const archivedAt = typeof session.archivedAt === "string"
    ? session.archivedAt
    : typeof value.archivedAt === "string"
      ? value.archivedAt
      : undefined;

  return {
    ...parsed,
    session: {
      ...session,
      id,
      createdAt: typeof session.createdAt === "string"
        ? session.createdAt
        : parsed.createdAt ?? new Date(0).toISOString(),
      intent: typeof session.intent === "string" ? session.intent : bodyIntent || id,
      artifacts: Array.isArray(session.artifacts) ? session.artifacts : [],
      humanAnswers: Array.isArray(session.humanAnswers) ? session.humanAnswers : [],
      notes: Array.isArray(session.notes) ? session.notes : [],
      ...(archivedAt ? { archivedAt } : {}),
      ...(typeof session.currentPhase === "string" ? { currentPhase: session.currentPhase } : {}),
    } as T,
  };
}

export function loadSessionStateFileFromDir<T extends SessionState = SessionState>(
  sessionDir: string,
  sessionId: string,
): ParsedSessionStateFile<T> | null {
  const filePath = findSessionFilePath(sessionDir, sessionId);
  return filePath ? readSessionStateFile<T>(filePath) : null;
}

export function listSessionStateFiles<T extends SessionState = SessionState>(
  sessionDir: string,
): ParsedSessionStateFile<T>[] {
  return listSessionFilePaths(sessionDir)
    .map((filePath) => readSessionStateFile<T>(filePath))
    .filter((session): session is ParsedSessionStateFile<T> => Boolean(session))
    .sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt));
}

export function activeSessionFilePath(sessionDir: string): string {
  return path.join(sessionDir, ACTIVE_SESSION_FILE);
}

export function writeSessionFile<T extends SessionState>(sessionDir: string, session: T): string {
  const filePath = sessionJsonPath(sessionDir, session.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(createSessionEnvelope(session), null, 2), "utf8");
  return filePath;
}

export function setActiveSessionFile(sessionDir: string, sessionId: string): string {
  const filePath = activeSessionFilePath(sessionDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${sessionId}\n`, "utf8");
  return filePath;
}

export function readActiveSessionId(sessionDir: string): string | null {
  const filePath = activeSessionFilePath(sessionDir);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8").trim() || null;
}

export function archiveSessionFile(
  sessionDir: string,
  sessionId: string,
  archivedAt = new Date().toISOString(),
): { archivedAt: string; filePath: string } {
  const filePath = findSessionFilePath(sessionDir, sessionId);
  if (!filePath) {
    const err = new Error(`Session not found: ${sessionId}`) as Error & { code?: string };
    err.code = "ENOENT";
    throw err;
  }

  const raw = fs.readFileSync(filePath, "utf8");

  if (filePath.endsWith(".md")) {
    const closingFm = raw.indexOf("\n---", 3);
    if (closingFm !== -1) {
      const before = raw.slice(0, closingFm);
      const after = raw.slice(closingFm);
      const updated = /^archivedAt:/m.test(before)
        ? before.replace(/^archivedAt:.*$/m, `archivedAt: ${archivedAt}`) + after
        : before + `\narchivedAt: ${archivedAt}` + after;
      fs.writeFileSync(filePath, updated, "utf8");
    }
  } else {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = (parsed.value && typeof parsed.value === "object")
      ? parsed.value as Record<string, unknown>
      : null;
    const next = value
      ? { ...parsed, value: { ...value, archivedAt } }
      : { ...parsed, archivedAt };
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return { archivedAt, filePath };
}

export function upsertSessionAnswers(
  session: SessionState,
  taskId: string,
  answers: Record<string, string>,
  askedAt = new Date().toISOString(),
): SessionState {
  const existing = session.humanAnswers.filter((answer) => {
    if (answer.taskId !== taskId) return true;
    return !(answer.questionId in answers);
  });
  const nextAnswers = Object.entries(answers).map(([questionId, answer]) => ({
    taskId,
    questionId,
    answer,
    askedAt,
  }));
  return { ...session, humanAnswers: [...existing, ...nextAnswers] };
}

export function extractMarkdownSection(raw: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*$`, "im");
  const match = raw.match(pattern);
  if (!match || match.index == null) return "";
  const rest = raw.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return "";
  if (value === "[]" || value === "{}") return value === "[]" ? [] : {};
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function indentation(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseYamlBlock(lines: string[], start: number, indent: number): [unknown, number] {
  const first = lines[start];
  if (!first) return [{}, start];
  const isArray = indentation(first) === indent && first.trimStart().startsWith("- ");
  return isArray ? parseYamlArray(lines, start, indent) : parseYamlObject(lines, start, indent);
}

function parseYamlObject(lines: string[], start: number, indent: number): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) break;
    const match = trimmed.match(/^([^:]+):(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1].trim();
    const rest = match[2].trim();
    if (rest === "|") {
      const chunks: string[] = [];
      i += 1;
      while (i < lines.length && indentation(lines[i]) > indent) {
        chunks.push(lines[i].slice(indent + 2));
        i += 1;
      }
      obj[key] = chunks.join("\n");
    } else if (rest) {
      obj[key] = parseScalar(rest);
      i += 1;
    } else {
      const [child, next] = parseYamlBlock(lines, i + 1, indent + 2);
      obj[key] = child;
      i = next;
    }
  }
  return [obj, i];
}

function parseYamlArray(lines: string[], start: number, indent: number): [unknown[], number] {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) break;
    const rest = trimmed.slice(2).trim();
    if (!rest) {
      const [child, next] = parseYamlBlock(lines, i + 1, indent + 2);
      arr.push(child);
      i = next;
      continue;
    }
    const pair = rest.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (pair) {
      const item: Record<string, unknown> = {};
      item[pair[1].trim()] = pair[2].trim() ? parseScalar(pair[2].trim()) : {};
      i += 1;
      if (i < lines.length && indentation(lines[i]) >= indent + 2) {
        const [child, next] = parseYamlObject(lines, i, indent + 2);
        Object.assign(item, child);
        i = next;
      }
      arr.push(item);
    } else {
      arr.push(parseScalar(rest));
      i += 1;
    }
  }
  return [arr, i];
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = text.slice(3, end).trim();
  const [parsed] = parseYamlObject(body.split(/\r?\n/), 0, 0);
  return parsed;
}
