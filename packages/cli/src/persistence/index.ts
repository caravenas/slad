import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  EvolveOutput,
  ExploreOutput,
  LearnOutput,
  PlanOutput,
  RunOutput,
  SessionState,
  SnapshotOutput,
} from "../core/types.js";
import { ParseError } from "../core/errors.js";
import {
  artifactDir,
  pathForArtifact,
  pathForRun,
  timestampedPathForArtifact,
  timestampedPathForRun,
} from "./layout.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ArtifactKind =
  | "explore"
  | "snapshot"
  | "plan"
  | "run"
  | "learn"
  | "evolve"
  | "session";

export type ArtifactByKind = {
  run: RunOutput;
  explore: ExploreOutput;
  snapshot: SnapshotOutput;
  plan: PlanOutput;
  learn: LearnOutput;
  evolve: EvolveOutput;
  session: SessionState;
};

export interface WriteContext {
  sessionId: string;
  /** ISO string; default: new Date().toISOString() */
  createdAt?: string;
  key?: string;
}

export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  sessionId: string;
  taskId?: string;
  createdAt: string;
}

export interface ParseResult<T> {
  value: T;
  warnings: string[];
}

// ─── Zod schema map ───────────────────────────────────────────────────────────

const SCHEMAS = {
  explore: ExploreOutput,
  snapshot: SnapshotOutput,
  plan: PlanOutput,
  run: RunOutput,
  learn: LearnOutput,
  evolve: EvolveOutput,
  session: SessionState,
} as const;

// ─── writeArtifact ────────────────────────────────────────────────────────────

/**
 * Serializes value as a JSON envelope, writes to disk, returns an ArtifactRef.
 * For "run": path is <docsRoot>/log/runs/{sessionId}_{taskId}.json
 * If that path already exists, uses a timestamped variant to preserve history.
 */
export async function writeArtifact<K extends ArtifactKind>(
  kind: K,
  value: ArtifactByKind[K],
  ctx: WriteContext,
): Promise<ArtifactRef<K>> {
  const createdAt = ctx.createdAt ?? new Date().toISOString();
  const taskId = taskIdFor(kind, value);

  const envelope = {
    kind,
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt,
    ...(taskId ? { taskId } : {}),
    value,
  };
  const content = JSON.stringify(envelope, null, 2);

  const key = artifactKey(kind, value, ctx.key);
  const primary = kind === "run"
    ? await pathForRun(ctx.sessionId, (value as RunOutput).taskId)
    : await pathForArtifact(kind, ctx.sessionId, key);
  const filePath = existsSync(primary)
    ? kind === "run"
      ? await timestampedPathForRun(ctx.sessionId, (value as RunOutput).taskId, createdAt)
      : await timestampedPathForArtifact(kind, ctx.sessionId, createdAt, key)
    : primary;

  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf8");

  return { kind, path: filePath, sessionId: ctx.sessionId, ...(taskId ? { taskId } : {}), createdAt };
}

// ─── readArtifact ─────────────────────────────────────────────────────────────

/**
 * Reads a JSON artifact envelope from disk, parses and validates it.
 * Throws ParseError if the file is missing or fundamentally unreadable.
 */
export async function readArtifact<K extends ArtifactKind>(
  kind: K,
  filePath: string,
): Promise<ParseResult<ArtifactByKind[K]>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err: any) {
    throw new ParseError(`cannot read artifact file: ${filePath}`, {
      path: filePath,
      phase: "filesystem",
      cause: err,
    });
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text);
  } catch (err: any) {
    throw new ParseError(`cannot parse JSON in artifact: ${filePath}`, {
      path: filePath,
      phase: "json",
      cause: err,
    });
  }

  const raw = (envelope.value ?? envelope) as unknown;
  const schema = SCHEMAS[kind];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ParseError(`artifact failed schema validation: ${filePath}`, {
      path: filePath,
      phase: "zod",
      cause: result.error,
    });
  }

  return { value: result.data as ArtifactByKind[K], warnings: [] };
}

// ─── listArtifacts ────────────────────────────────────────────────────────────

/**
 * Lists artifact refs from disk for a given kind, optionally filtered by sessionId.
 */
export async function listArtifacts<K extends ArtifactKind>(
  kind: K,
  filter?: { sessionId?: string },
): Promise<ArtifactRef<K>[]> {
  const dir = await artifactDir(kind);

  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries.filter((f) => f.endsWith(".json")).map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }

  const refs: ArtifactRef<K>[] = [];

  for (const filePath of files) {
    try {
      const text = await readFile(filePath, "utf8");
      const envelope = JSON.parse(text) as Record<string, unknown>;
      const sessionId = String(envelope.sessionId ?? "");
      const taskId = typeof envelope.taskId === "string" ? envelope.taskId : undefined;
      const createdAt = String(envelope.createdAt ?? "");

      if (filter?.sessionId && sessionId !== filter.sessionId) continue;

      refs.push({ kind, path: filePath, sessionId, taskId, createdAt });
    } catch {
      // skip unreadable files
    }
  }

  return refs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function artifactKey<K extends ArtifactKind>(
  kind: K,
  value: ArtifactByKind[K],
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  if (kind === "learn") return (value as LearnOutput).taskId;
  return undefined;
}

function taskIdFor<K extends ArtifactKind>(kind: K, value: ArtifactByKind[K]): string | undefined {
  if (kind === "run") return (value as RunOutput).taskId;
  if (kind === "learn") return (value as LearnOutput).taskId;
  return undefined;
}
