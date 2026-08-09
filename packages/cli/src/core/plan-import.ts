import { readFile } from "node:fs/promises";
import { ExternalPlanDocument } from "@slad/shared";
import { PlanArtifactEnvelope } from "./types.js";
import { planHashOf, planInputDigestOf } from "../persistence/index.js";
import { gatePlanPreflight, type PlanPreflightGate } from "./plan-preflight.js";

// ─── External plan import ─────────────────────────────────────────────────────
//
// Reads and validates a canonical external plan (ExternalPlanDocument) before it
// is persisted. No provider/LLM is ever involved: the document already carries
// intent, snapshot and plan. This module performs no persistence — the caller
// decides what to do with a valid document (writePendingPlan re-derives
// planId/revision/digest/approval/planHash, so nothing external survives).
//
// Validation order: JSON → schema → intent match against the active session →
// plan preflight (approve mode) on the exact envelope writePendingPlan would
// produce. A document that fails any step must not be persisted.

export interface PlanImportSession {
  id: string;
  intent: string;
}

export type PlanImportError =
  | { code: "read"; message: string }
  | { code: "json"; message: string }
  | { code: "schema"; message: string; issues: string[] }
  | { code: "intent-mismatch"; message: string }
  | { code: "preflight"; message: string; gate: PlanPreflightGate };

export type ParseExternalPlanResult =
  | { ok: true; document: ExternalPlanDocument }
  | { ok: false; error: PlanImportError };

export type PlanImportResult =
  | { ok: true; document: ExternalPlanDocument; gate: PlanPreflightGate }
  | { ok: false; error: PlanImportError };

/** Parses raw text as a strict ExternalPlanDocument, without touching disk. */
export function parseExternalPlanDocument(text: string): ParseExternalPlanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: { code: "json", message: `El plan externo no es JSON válido: ${(err as Error).message}` },
    };
  }

  const parsed = ExternalPlanDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`,
    );
    return {
      ok: false,
      error: {
        code: "schema",
        message: "El plan externo no cumple el contrato slad.external-plan (schemaVersion 1).",
        issues,
      },
    };
  }

  return { ok: true, document: parsed.data };
}

/**
 * Validates a parsed document against the active session: the intent must match
 * (trim-insensitive) and the plan must pass the approve-mode preflight on the
 * candidate envelope that writePendingPlan would persist.
 */
export function evaluateExternalPlan(
  document: ExternalPlanDocument,
  session: PlanImportSession,
  createdAt = new Date().toISOString(),
): PlanImportResult {
  if (document.intent.trim() !== session.intent.trim()) {
    return {
      ok: false,
      error: {
        code: "intent-mismatch",
        message:
          "La intención del plan externo no coincide con la intención de la sesión activa; " +
          `sesión: "${session.intent}", plan externo: "${document.intent.trim()}".`,
      },
    };
  }

  // Candidate envelope built exactly as writePendingPlan will persist it (the
  // revision/planId may differ, which preflight does not inspect). SLAD owns
  // intent, digest and hash here — external values never enter the envelope.
  const envelope = PlanArtifactEnvelope.parse({
    kind: "plan",
    schemaVersion: 2,
    planId: `${session.id}-import-preflight`,
    sessionId: session.id,
    revision: 1,
    createdAt,
    approval: { status: "pending", planHash: planHashOf(document.plan) },
    input: {
      intent: session.intent,
      snapshot: document.snapshot,
      digest: planInputDigestOf(session.intent, document.snapshot),
    },
    plan: document.plan,
  });

  const gate = gatePlanPreflight(envelope, "approve", { expectedSession: session });
  if (!gate.ok) {
    return {
      ok: false,
      error: {
        code: "preflight",
        message: `El plan externo no pasa el preflight (${gate.blockers.length} blocker(s)); no se importó.`,
        gate,
      },
    };
  }

  return { ok: true, document, gate };
}

/** Reads, parses and validates an external plan file. Never persists anything. */
export async function importExternalPlanFromFile(
  filePath: string,
  session: PlanImportSession,
): Promise<PlanImportResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: { code: "read", message: `No se pudo leer el plan externo: ${filePath} (${(err as Error).message})` },
    };
  }

  const parsed = parseExternalPlanDocument(text);
  if (!parsed.ok) return parsed;
  return evaluateExternalPlan(parsed.document, session);
}
