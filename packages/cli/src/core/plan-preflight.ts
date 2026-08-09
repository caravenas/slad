import type { PlanArtifactEnvelope, PlanOutput, PlanTask } from "./types.js";
import { log } from "./logger.js";
import { planHashOf, planInputDigestOf, type StalePlanApproval } from "../persistence/index.js";

// ─── Plan preflight ───────────────────────────────────────────────────────────
//
// Pure validator for a PlanArtifactEnvelope before a human decision ("approve")
// or before execution ("run"). It performs no I/O: the caller reads the plan
// (readPlan already normalizes legacy artifacts) and decides what to do with
// the report. Blockers mean the plan must not proceed in the given mode;
// warnings surface risks but never block.

export type PlanPreflightMode = "approve" | "run";

export type PlanPreflightCode =
  // Envelope binding
  | "envelope.session-id.missing"
  | "envelope.session-id.mismatch"
  | "envelope.intent.empty"
  | "envelope.intent.mismatch"
  | "envelope.digest.mismatch"
  // Approval binding
  | "approval.hash.mismatch"
  | "approval.hash.stale"
  | "approval.status.superseded"
  | "approval.status.already-approved"
  | "approval.status.rejected"
  | "approval.status.not-approved"
  | "approval.decided-at.missing"
  // Task graph
  | "plan.status.not-completed"
  | "plan.tasks.empty"
  | "task.id.duplicate"
  | "task.deps.self"
  | "task.deps.unknown"
  | "task.deps.duplicate"
  | "plan.deps.cycle"
  | "plan.recommended-first-task.missing"
  | "plan.recommended-first-task.unknown"
  | "plan.recommended-first-task.has-deps"
  // Declared files
  | "task.files.empty"
  | "task.files.glob"
  | "task.files.backslash"
  | "task.files.absolute"
  | "task.files.traversal"
  | "task.files.root"
  | "task.files.unnormalized"
  | "task.files.duplicate"
  | "task.files.none"
  // Ownership
  | "plan.ownership.overlap";

export interface PlanPreflightIssue {
  code: PlanPreflightCode;
  message: string;
  /** Set when the issue is tied to a specific task. */
  taskId?: string;
}

export interface PlanPreflightReport {
  mode: PlanPreflightMode;
  /** True when no blockers were found; warnings never block. */
  ok: boolean;
  blockers: PlanPreflightIssue[];
  warnings: PlanPreflightIssue[];
}

export interface PlanPreflightOptions {
  mode: PlanPreflightMode;
  expectedSession?: { id: string; intent: string } | undefined;
  staleApproval?: StalePlanApproval | undefined;
}

export function preflightPlan(
  envelope: PlanArtifactEnvelope,
  options: PlanPreflightOptions,
): PlanPreflightReport {
  const blockers: PlanPreflightIssue[] = [];
  const warnings: PlanPreflightIssue[] = [];

  const blocker = (code: PlanPreflightCode, message: string, taskId?: string) => {
    blockers.push({ code, message, ...(taskId ? { taskId } : {}) });
  };
  const warning = (code: PlanPreflightCode, message: string, taskId?: string) => {
    warnings.push({ code, message, ...(taskId ? { taskId } : {}) });
  };

  checkEnvelopeBinding(envelope, options.expectedSession, blocker, warning);
  checkApproval(envelope, options.mode, options.staleApproval, blocker, warning);
  checkTaskGraph(envelope.plan, blocker, warning);
  checkTaskFiles(envelope.plan.tasks, blocker, warning);
  checkOwnershipOverlap(envelope.plan.tasks, warning);

  return { mode: options.mode, ok: blockers.length === 0, blockers, warnings };
}

type Report = (code: PlanPreflightCode, message: string, taskId?: string) => void;

const BYPASSABLE_CODES: ReadonlySet<PlanPreflightCode> = new Set(["approval.status.not-approved"]);

export interface PlanPreflightGate {
  report: PlanPreflightReport;
  /** Blockers still in force after applying the --bypass policy. */
  blockers: PlanPreflightIssue[];
  /** Blockers skipped by --bypass (only approval.status.not-approved qualifies). */
  bypassed: PlanPreflightIssue[];
  ok: boolean;
}

export function gatePlanPreflight(
  envelope: PlanArtifactEnvelope,
  mode: PlanPreflightMode,
  options: {
    bypass?: boolean;
    expectedSession?: { id: string; intent: string } | undefined;
    staleApproval?: StalePlanApproval | undefined;
  } = {},
): PlanPreflightGate {
  const report = preflightPlan(envelope, {
    mode,
    expectedSession: options.expectedSession,
    staleApproval: options.staleApproval,
  });
  const bypassed = options.bypass
    ? report.blockers.filter((issue) => BYPASSABLE_CODES.has(issue.code))
    : [];
  const blockers = report.blockers.filter((issue) => !bypassed.includes(issue));
  return { report, blockers, bypassed, ok: blockers.length === 0 };
}

export function printPlanPreflight(gate: PlanPreflightGate, readWarnings: string[] = []): void {
  for (const warning of readWarnings) log.warn(warning);
  for (const warning of gate.report.warnings) log.warn(warning.message);
  for (const issue of gate.bypassed) {
    log.warn(`bypass: ignorando bloqueo ${issue.code} — ${issue.message}`);
  }
  for (const issue of gate.blockers) log.error(issue.message);
}

// ─── Envelope binding ─────────────────────────────────────────────────────────

function checkEnvelopeBinding(
  envelope: PlanArtifactEnvelope,
  expectedSession: { id: string; intent: string } | undefined,
  blocker: Report,
  warning: Report,
): void {
  if (!envelope.sessionId || !envelope.sessionId.trim()) {
    blocker("envelope.session-id.missing", "El plan no está vinculado a una sesión (sessionId vacío).");
  } else if (expectedSession && envelope.sessionId !== expectedSession.id) {
    blocker(
      "envelope.session-id.mismatch",
      `El plan pertenece a la sesión ${envelope.sessionId}, no a la sesión activa ${expectedSession.id}.`,
    );
  }

  // Legacy plans (v1 artifacts) never recorded the intent; keep them usable.
  if (!envelope.input.intent.trim()) {
    warning(
      "envelope.intent.empty",
      "El plan no registra la intención original (artefacto legacy); el contexto de ejecución será menos preciso.",
    );
  } else if (expectedSession && envelope.input.intent.trim() !== expectedSession.intent.trim()) {
    blocker(
      "envelope.intent.mismatch",
      "La intención registrada en el plan no coincide con la intención de la sesión activa.",
    );
  }

  const digest = planInputDigestOf(envelope.input.intent, envelope.input.snapshot);
  if (digest !== envelope.input.digest) {
    blocker(
      "envelope.digest.mismatch",
      "El digest de los insumos no coincide con intent+snapshot registrados; el artefacto fue alterado o está corrupto.",
    );
  }
}

// ─── Approval binding ─────────────────────────────────────────────────────────

function checkApproval(
  envelope: PlanArtifactEnvelope,
  mode: PlanPreflightMode,
  staleApproval: StalePlanApproval | undefined,
  blocker: Report,
  warning: Report,
): void {
  if (staleApproval) {
    const message =
      `El plan fue modificado después de quedar ${staleApproval.status}; requiere una nueva aprobación.`;
    if (mode === "run") blocker("approval.hash.mismatch", message);
    else warning("approval.hash.stale", message);
  }

  const bound = planHashOf(envelope.plan) === envelope.approval.planHash;
  if (!bound) {
    if (mode === "run") {
      blocker(
        "approval.hash.mismatch",
        "La aprobación no corresponde al cuerpo actual del plan (planHash desactualizado); requiere una nueva aprobación.",
      );
    } else {
      warning(
        "approval.hash.stale",
        "El planHash registrado no coincide con el cuerpo del plan; al aprobar se re-vinculará al contenido actual.",
      );
    }
  }

  const status = envelope.approval.status;
  if (mode === "approve") {
    if (status === "superseded") {
      blocker("approval.status.superseded", "El plan fue reemplazado por una revisión más nueva; no puede aprobarse.");
    } else if (status === "approved") {
      warning("approval.status.already-approved", "El plan ya está aprobado; una nueva aprobación no cambia nada.");
    } else if (status === "rejected") {
      warning("approval.status.rejected", "El plan fue rechazado previamente; aprobar revierte esa decisión.");
    }
    return;
  }

  if (status !== "approved") {
    blocker(
      "approval.status.not-approved",
      `El plan requiere aprobación explícita antes de ejecutarse (estado actual: ${status}).`,
    );
  } else if (!envelope.approval.decidedAt) {
    warning("approval.decided-at.missing", "El plan está aprobado pero no registra cuándo se decidió.");
  }
}

// ─── Task graph ───────────────────────────────────────────────────────────────

function checkTaskGraph(
  plan: PlanOutput,
  blocker: Report,
  warning: Report,
): void {
  if (plan.status !== "completed") {
    blocker(
      "plan.status.not-completed",
      `El plan quedó en estado ${plan.status}; resolvé las preguntas pendientes y regenerá el plan antes de aprobarlo o ejecutarlo.`,
    );
  }

  const tasks = plan.tasks;
  if (tasks.length === 0) {
    blocker("plan.tasks.empty", "El plan no tiene tareas; no hay nada que ejecutar.");
    return;
  }

  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      blocker("task.id.duplicate", `El id ${id} está declarado ${count} veces en el plan.`, id);
    }
  }

  const ids = new Set(counts.keys());
  for (const task of tasks) {
    const seenDeps = new Set<string>();
    for (const dep of task.dependsOn) {
      if (seenDeps.has(dep)) {
        warning("task.deps.duplicate", `La tarea ${task.id} declara la dependencia ${dep} más de una vez.`, task.id);
      }
      seenDeps.add(dep);

      if (dep === task.id) {
        blocker("task.deps.self", `La tarea ${task.id} depende de sí misma.`, task.id);
      } else if (!ids.has(dep)) {
        blocker("task.deps.unknown", `La tarea ${task.id} depende de ${dep}, que no existe en el plan.`, task.id);
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    blocker("plan.deps.cycle", `El plan tiene dependencias cíclicas: ${cycle.join(" → ")}.`);
  }

  const first = plan.recommendedFirstTask;
  if (!first) {
    warning("plan.recommended-first-task.missing", "El plan no recomienda una primera tarea.");
  } else if (!ids.has(first)) {
    blocker(
      "plan.recommended-first-task.unknown",
      `La primera tarea recomendada (${first}) no existe en el plan.`,
    );
  } else {
    const task = tasks.find((t) => t.id === first);
    if (task && task.dependsOn.length > 0) {
      warning(
        "plan.recommended-first-task.has-deps",
        `La primera tarea recomendada (${first}) tiene dependencias (${task.dependsOn.join(", ")}); no puede ejecutarse primero.`,
      );
    }
  }
}

/** First dependency cycle found (self-deps and unknown deps are reported separately). */
function findCycle(tasks: PlanTask[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let cycle: string[] | undefined;

  const visit = (id: string): boolean => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      const depState = state.get(dep);
      if (depState === "done") continue;
      if (depState === "visiting") {
        cycle = [...stack.slice(stack.indexOf(dep)), dep];
        return true;
      }
      if (visit(dep)) return true;
    }
    stack.pop();
    state.set(id, "done");
    return false;
  };

  for (const task of tasks) {
    if (!state.has(task.id) && visit(task.id)) return cycle;
  }
  return undefined;
}

// ─── Declared files ───────────────────────────────────────────────────────────
//
// PlanTask.files feeds the wave scheduler and the ownership checks, both of
// which compare paths literally. Preflight therefore requires literal relative
// posix paths in normalized form: no globs, no absolutes, no traversal, and no
// cosmetic variants ("./src/x.ts") that would break literal comparison.

const GLOB_CHARS = /[*?[\]{}]/;

type FileEntryCheck =
  | { kind: "ok"; normalized: string; cosmetic: boolean }
  | { kind: "empty" | "glob" | "backslash" | "absolute" | "traversal" | "root" };

function checkFileEntry(raw: string): FileEntryCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.includes("\\")) return { kind: "backslash" };
  if (GLOB_CHARS.test(trimmed) || trimmed.startsWith("!")) return { kind: "glob" };
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:/.test(trimmed)) {
    return { kind: "absolute" };
  }

  const segments = trimmed.split("/").filter((segment) => segment !== "");
  if (segments.includes("..")) return { kind: "traversal" };

  const meaningful = segments.filter((segment) => segment !== ".");
  if (meaningful.length === 0) return { kind: "root" };

  const normalized = meaningful.join("/");
  return { kind: "ok", normalized, cosmetic: normalized !== raw };
}

/** Task types expected to declare the files they touch. */
const TYPES_EXPECTING_FILES: ReadonlySet<PlanTask["type"]> = new Set([
  "implementation",
  "test",
  "docs",
]);

function checkTaskFiles(tasks: PlanTask[], blocker: Report, warning: Report): void {
  for (const task of tasks) {
    const normalized = new Set<string>();
    for (const file of task.files) {
      const result = checkFileEntry(file);
      switch (result.kind) {
        case "empty":
          blocker("task.files.empty", `La tarea ${task.id} declara una ruta vacía.`, task.id);
          break;
        case "backslash":
          blocker(
            "task.files.backslash",
            `La tarea ${task.id} declara "${file}" con backslashes; las rutas deben usar separadores posix (/).`,
            task.id,
          );
          break;
        case "glob":
          blocker(
            "task.files.glob",
            `La tarea ${task.id} declara "${file}" con caracteres de glob; solo se admiten rutas literales.`,
            task.id,
          );
          break;
        case "absolute":
          blocker(
            "task.files.absolute",
            `La tarea ${task.id} declara "${file}" como ruta absoluta o de home; las rutas deben ser relativas al workspace.`,
            task.id,
          );
          break;
        case "traversal":
          blocker(
            "task.files.traversal",
            `La tarea ${task.id} declara "${file}" con segmentos ".."; las rutas deben quedar dentro del workspace y estar normalizadas.`,
            task.id,
          );
          break;
        case "root":
          blocker(
            "task.files.root",
            `La tarea ${task.id} declara "${file}", que apunta a la raíz del workspace en vez de a un archivo.`,
            task.id,
          );
          break;
        case "ok":
          if (result.cosmetic) {
            blocker(
              "task.files.unnormalized",
              `La tarea ${task.id} declara "${file}"; usá la forma normalizada "${result.normalized}" para que la comparación literal de propiedad funcione.`,
              task.id,
            );
          }
          if (normalized.has(result.normalized)) {
            warning(
              "task.files.duplicate",
              `La tarea ${task.id} declara "${result.normalized}" más de una vez.`,
              task.id,
            );
          }
          normalized.add(result.normalized);
          break;
      }
    }

    if (task.files.length === 0 && tasks.length > 1 && TYPES_EXPECTING_FILES.has(task.type)) {
      warning(
        "task.files.none",
        `La tarea ${task.id} (${task.type}) no declara archivos; en ejecución paralela reclama propiedad exclusiva de todo el workspace y corre sola.`,
        task.id,
      );
    }
  }
}

// ─── Ownership overlap ────────────────────────────────────────────────────────
//
// Two tasks with no dependency path between them may run in the same parallel
// wave; if they declare the same file the scheduler serializes them silently
// and worktree merges can conflict. Overlap between dependent tasks is fine —
// they never run concurrently.

function checkOwnershipOverlap(tasks: PlanTask[], warning: Report): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = new Map<string, Set<string>>();

  const collect = (id: string, visiting: Set<string>): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || visiting.has(dep)) continue;
      result.add(dep);
      for (const transitive of collect(dep, visiting)) result.add(transitive);
    }
    visiting.delete(id);
    ancestors.set(id, result);
    return result;
  };

  const ownedFiles = (task: PlanTask): Set<string> => {
    const owned = new Set<string>();
    for (const file of task.files) {
      const result = checkFileEntry(file);
      if (result.kind === "ok") owned.add(result.normalized);
    }
    return owned;
  };

  const files = tasks.map(ownedFiles);
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (a.id === b.id) continue;
      if (collect(a.id, new Set()).has(b.id) || collect(b.id, new Set()).has(a.id)) continue;

      const shared = [...files[i]!].filter((file) => files[j]!.has(file));
      if (shared.length > 0) {
        warning(
          "plan.ownership.overlap",
          `Las tareas ${a.id} y ${b.id} son paralelas (sin dependencia entre sí) y declaran archivos en común: ${shared.join(", ")}.`,
        );
      }
    }
  }
}
