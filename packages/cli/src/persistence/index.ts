import { readFile, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { stripEmptyCollections } from "@slad/shared";
import {
  EvolveOutput,
  ExploreOutput,
  LearnOutput,
  PlanApprovalStatus,
  PlanArtifactEnvelope,
  PlanOutput,
  RunOutput,
  SessionState,
  SnapshotOutput,
} from "../core/types.js";
import { ParseError, SladError } from "../core/errors.js";
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
  const parsed = SCHEMAS[kind].safeParse(value);
  if (!parsed.success) {
    throw new ParseError(`refusing to persist invalid ${kind} artifact`, {
      phase: "zod",
      cause: parsed.error,
    });
  }
  const validatedValue = parsed.data as ArtifactByKind[K];
  const taskId = taskIdFor(kind, validatedValue);

  const envelope = {
    kind,
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt,
    ...(taskId ? { taskId } : {}),
    // Empty collections are dropped on write; the Zod defaults restore them on read.
    value: stripEmptyCollections(validatedValue),
  };

  const key = artifactKey(kind, validatedValue, ctx.key);
  const primary = kind === "run"
    ? await pathForRun(ctx.sessionId, (validatedValue as RunOutput).taskId)
    : await pathForArtifact(kind, ctx.sessionId, key);
  const filePath = existsSync(primary)
    ? kind === "run"
      ? await timestampedPathForRun(ctx.sessionId, (validatedValue as RunOutput).taskId, createdAt)
      : await timestampedPathForArtifact(kind, ctx.sessionId, createdAt, key)
    : primary;

  await writeJsonAtomic(filePath, envelope);

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

  // A v2 plan keeps its body under `plan`, not `value`; unwrap it so callers that
  // only want the PlanOutput keep working across both plan artifact versions.
  const raw = (isPlanEnvelopeV2(envelope) ? envelope.plan : envelope.value ?? envelope) as unknown;
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

// ─── Plan approval API ────────────────────────────────────────────────────────
//
// Plans are the one artifact that carries a human decision, so they get explicit
// read/write helpers instead of riding on the generic envelope. On disk a plan is
// a PlanArtifactEnvelope (schemaVersion 2) whose `approval.planHash` binds the
// decision to the exact plan body that was decided on.
//
// Legacy plans (generic v1 envelopes, written before approvals existed) are still
// readable: readPlan() normalizes them to a v2 envelope with status "pending".
// A plan is never treated as approved unless it says so explicitly.

export interface ReadPlanResult {
  value: PlanArtifactEnvelope;
  /** True when the file on disk was a pre-approval (v1) plan artifact. */
  legacy: boolean;
  warnings: string[];
  staleApproval?: StalePlanApproval;
}

export interface StalePlanApproval {
  status: Exclude<PlanApprovalStatus, "pending">;
  planHash: string;
  currentPlanHash: string;
}

export interface WritePendingPlanOptions {
  sessionId: string;
  intent: string;
  snapshot: SnapshotOutput;
  plan: PlanOutput;
  /** ISO string; default: new Date().toISOString() */
  createdAt?: string;
}

export interface WritePlanResult {
  ref: ArtifactRef<"plan">;
  value: PlanArtifactEnvelope;
  /** Set when this write superseded an existing plan, pointing at its archived copy. */
  supersededPath?: string;
}

export interface PlanDecisionOptions {
  reason?: string;
  /** ISO string; default: new Date().toISOString() */
  decidedAt?: string;
}

/** sha256 over the canonical (key-sorted) JSON of the normalized plan body. */
export function planHashOf(plan: PlanOutput): string {
  return sha256(stableStringify(PlanOutput.parse(plan)));
}

/** sha256 over the canonical JSON of the inputs the plan was derived from. */
export function planInputDigestOf(intent: string, snapshot: SnapshotOutput): string {
  return sha256(stableStringify({ intent, snapshot: SnapshotOutput.parse(snapshot) }));
}

/**
 * Writes a new plan awaiting human approval to the session's canonical plan path.
 * If a plan already lives there it is archived alongside, marked "superseded", and
 * the new plan takes the next revision — so an old approval can never carry over.
 */
export async function writePendingPlan(opts: WritePendingPlanOptions): Promise<WritePlanResult> {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const filePath = await pathForArtifact("plan", opts.sessionId);

  const previous = existsSync(filePath) ? await readPlan(filePath) : null;

  let supersededPath: string | undefined;
  if (previous) {
    supersededPath = await timestampedPathForArtifact("plan", opts.sessionId, createdAt);
    await writeJsonAtomic(supersededPath, {
      ...previous.value,
      approval: { ...previous.value.approval, status: "superseded" as const, decidedAt: createdAt },
      updatedAt: createdAt,
    });
  }

  const plan = PlanOutput.parse(opts.plan);
  const snapshot = SnapshotOutput.parse(opts.snapshot);
  const revision = previous ? previous.value.revision + 1 : 1;

  const value = PlanArtifactEnvelope.parse({
    kind: "plan",
    schemaVersion: 2,
    planId: planIdFor(opts.sessionId, revision),
    sessionId: opts.sessionId,
    revision,
    createdAt,
    ...(previous ? { supersedesPlanId: previous.value.planId } : {}),
    approval: { status: "pending", planHash: planHashOf(plan) },
    input: {
      intent: opts.intent,
      snapshot,
      digest: planInputDigestOf(opts.intent, snapshot),
    },
    plan,
  });

  await writeJsonAtomic(filePath, value);

  return {
    ref: { kind: "plan", path: filePath, sessionId: opts.sessionId, createdAt },
    value,
    ...(supersededPath ? { supersededPath } : {}),
  };
}

/**
 * Reads a plan artifact as a PlanArtifactEnvelope, normalizing legacy plans and
 * stale approvals (a decision whose planHash no longer matches the plan body) to
 * status "pending".
 */
export async function readPlan(filePath: string): Promise<ReadPlanResult> {
  const raw = await readJsonFile(filePath);

  if (isPlanEnvelopeV2(raw)) {
    const parsed = PlanArtifactEnvelope.safeParse(raw);
    if (!parsed.success) {
      throw new ParseError(`plan artifact failed schema validation: ${filePath}`, {
        path: filePath,
        phase: "zod",
        cause: parsed.error,
      });
    }
    return { legacy: false, ...withFreshApproval(parsed.data) };
  }

  return { legacy: true, ...normalizeLegacyPlan(raw, filePath) };
}

/** Records human approval on a plan. Rewrites legacy plans as v2 in place. */
export async function approvePlan(
  filePath: string,
  opts: PlanDecisionOptions = {},
): Promise<PlanArtifactEnvelope> {
  return decidePlan(filePath, "approved", opts);
}

/** Records human rejection on a plan. Rewrites legacy plans as v2 in place. */
export async function rejectPlan(
  filePath: string,
  opts: PlanDecisionOptions = {},
): Promise<PlanArtifactEnvelope> {
  return decidePlan(filePath, "rejected", opts);
}

async function decidePlan(
  filePath: string,
  status: Extract<PlanApprovalStatus, "approved" | "rejected">,
  opts: PlanDecisionOptions,
): Promise<PlanArtifactEnvelope> {
  const current = await readPlan(filePath);

  if (current.value.approval.status === "superseded") {
    throw new SladError(
      `cannot ${status === "approved" ? "approve" : "reject"} a superseded plan: ${filePath}`,
      "PLAN_APPROVAL_ERROR",
      { path: filePath, planId: current.value.planId, status: "superseded" },
    );
  }

  const decidedAt = opts.decidedAt ?? new Date().toISOString();
  const value = PlanArtifactEnvelope.parse({
    ...current.value,
    updatedAt: decidedAt,
    approval: {
      status,
      decidedAt,
      ...(opts.reason ? { reason: opts.reason } : {}),
      planHash: planHashOf(current.value.plan),
    },
  });

  await writeJsonAtomic(filePath, value);
  return value;
}

// ─── Plan helpers ─────────────────────────────────────────────────────────────

/**
 * Re-binds the approval to the plan body on disk. A decision whose planHash no
 * longer matches means the plan was edited after it was decided on: the decision
 * is stale, so it drops back to "pending" rather than being honored.
 */
function withFreshApproval(
  value: PlanArtifactEnvelope,
): { value: PlanArtifactEnvelope; warnings: string[]; staleApproval?: StalePlanApproval } {
  const planHash = planHashOf(value.plan);
  if (planHash === value.approval.planHash) return { value, warnings: [] };

  if (value.approval.status === "pending") {
    return { value: { ...value, approval: { ...value.approval, planHash } }, warnings: [] };
  }

  const staleApproval = {
    status: value.approval.status,
    planHash: value.approval.planHash,
    currentPlanHash: planHash,
  } satisfies StalePlanApproval;

  return {
    value: {
      ...value,
      approval: { status: "pending", planHash },
    },
    staleApproval,
    warnings: [
      `plan body changed since it was ${value.approval.status} (planHash mismatch); treating it as pending`,
    ],
  };
}

/**
 * Normalizes a pre-approval plan artifact — a generic v1 envelope or a bare
 * PlanOutput — into a v2 envelope. It carries no decision, so it is pending.
 */
function normalizeLegacyPlan(
  raw: Record<string, unknown>,
  filePath: string,
): { value: PlanArtifactEnvelope; warnings: string[] } {
  const parsed = PlanOutput.safeParse(raw.value ?? raw);
  if (!parsed.success) {
    throw new ParseError(`plan artifact failed schema validation: ${filePath}`, {
      path: filePath,
      phase: "zod",
      cause: parsed.error,
    });
  }

  const plan = parsed.data;
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId
    ? raw.sessionId
    : path.basename(filePath, ".json");
  const createdAt = isIsoDateTime(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  // A legacy plan only kept the snapshot as prose, and never recorded the intent.
  const snapshot = SnapshotOutput.parse({ content: plan.snapshot });
  const intent = "";

  const value = PlanArtifactEnvelope.parse({
    kind: "plan",
    schemaVersion: 2,
    planId: planIdFor(sessionId, 1),
    sessionId,
    revision: 1,
    createdAt,
    approval: { status: "pending", planHash: planHashOf(plan) },
    input: { intent, snapshot, digest: planInputDigestOf(intent, snapshot) },
    plan,
  });

  return {
    value,
    warnings: [`legacy plan artifact without an approval; treating it as pending`],
  };
}

function planIdFor(sessionId: string, revision: number): string {
  return `${sessionId}-r${revision}`;
}

function isPlanEnvelopeV2(raw: Record<string, unknown>): raw is Record<string, unknown> & { plan: unknown } {
  return raw.kind === "plan" && raw.schemaVersion === 2 && "plan" in raw;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && z.string().datetime().safeParse(value).success;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
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

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err: any) {
    throw new ParseError(`cannot parse JSON in artifact: ${filePath}`, {
      path: filePath,
      phase: "json",
      cause: err,
    });
  }
}

/** Writes via temp file + rename so a reader never observes a half-written plan. */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Kept out of `*.json` so listArtifacts() never picks up a temp file.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err: any) {
    await unlink(tmp).catch(() => {});
    throw new ParseError(`cannot write artifact file: ${filePath}`, {
      path: filePath,
      phase: "filesystem",
      cause: err,
    });
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Canonical JSON: object keys sorted, array order preserved, undefined dropped. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
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
