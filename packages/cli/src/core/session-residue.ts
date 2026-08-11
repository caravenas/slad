import path from "node:path";
import {
  branchTip,
  isAncestorRef,
  listSessionRefs,
  listSessionWorktreePaths,
  sessionBranch,
  sessionRefSuffix,
} from "../commands/worktrees.js";
import { isTerminalRunStatus, listSessionRunManifests, type RunManifestHandle } from "../persistence/manifest.js";

/**
 * Execution residue of a session (A2).
 *
 * A fresh `run --parallel --worktrees` used to call `setupIntegration`, which
 * deleted every `slad/<sessionId>/*` branch and force-removed every session
 * worktree — the only way this system could actually destroy work. The
 * integration tip alone does not see three kinds of residue that hold work:
 * committed-but-unmerged task refs, registered worktrees with uncommitted
 * changes, and non-terminal manifests whose outcome nobody decided.
 *
 * So a fresh run refuses while any of them exists, and SLAD never cleans them
 * on its own: the refusal prints the exact command a human can run.
 */

export interface ResidueRef {
  kind: "ref";
  branch: string;
  tip: string;
  /** The run whose manifest claims this ref, when it can be attributed. */
  runId?: string;
  runStatus?: string;
  /** Whether the ref is already reachable from its session's integration tip. */
  merged?: boolean;
}

export interface ResidueWorktree {
  kind: "worktree";
  worktreePath: string;
}

export interface ResidueManifest {
  kind: "manifest";
  runId: string;
  status: string;
}

export type ResidueItem = ResidueRef | ResidueWorktree | ResidueManifest;

export interface SessionResidue {
  items: ResidueItem[];
  /** Residue no manifest of the session claims: SLAD lists it and stops there. */
  unattributed: ResidueItem[];
  /** Runs a human can act on with --review / --resume / --apply / --abort. */
  actionableRuns: { runId: string; status: string; recoverySafe: boolean }[];
}

export function hasResidue(residue: SessionResidue): boolean {
  return residue.items.length > 0;
}

/**
 * A session integration ref is *inert* — and therefore ignorable — only when
 * all three hold: it is `slad/<s>/integration`, its tip is exactly the
 * `baseRef` its owning manifest recorded, and that manifest is terminal.
 * Everything else is residue, including any ref that cannot be attributed.
 */
function inertIntegrationRef(
  branch: string,
  tip: string,
  sessionId: string,
  manifests: RunManifestHandle[],
): boolean {
  if (branch !== sessionBranch(sessionId, "integration")) return false;
  return manifests.some(({ value }) =>
    value.worktrees.integration?.branch === branch &&
    value.worktrees.integration.baseRef === tip &&
    isTerminalRunStatus(value.status));
}

export async function collectSessionResidue(
  cwd: string,
  sessionId: string,
): Promise<SessionResidue> {
  const manifests = await listSessionRunManifests(sessionId, cwd);
  const items: ResidueItem[] = [];
  const unattributed: ResidueItem[] = [];

  // R3 — manifests whose outcome nobody decided.
  const openManifests = manifests.filter(({ value }) => !isTerminalRunStatus(value.status));
  for (const { value } of openManifests) {
    items.push({ kind: "manifest", runId: value.runId, status: value.status });
  }

  // R1 — refs under the session namespace.
  const integrationBranch = sessionBranch(sessionId, "integration");
  const currentIntegrationTip = await branchTip(cwd, integrationBranch);
  for (const { branch, tip } of await listSessionRefs(cwd, sessionId)) {
    if (inertIntegrationRef(branch, tip, sessionId, manifests)) continue;
    const suffix = sessionRefSuffix(branch, sessionId);
    const owner = manifests.find(({ value }) =>
      value.worktrees.integration?.branch === branch ||
      (suffix !== null && value.tasks.some((task) => task.taskId === suffix)));
    const item: ResidueRef = {
      kind: "ref",
      branch,
      tip,
      ...(owner ? { runId: owner.value.runId, runStatus: owner.value.status } : {}),
      // Reachability, never commit-message parsing.
      ...(currentIntegrationTip && branch !== integrationBranch
        ? { merged: await isAncestorRef(cwd, branch, currentIntegrationTip) }
        : {}),
    };
    items.push(item);
    if (!owner) unattributed.push(item);
  }

  // R2 — worktrees registered under the session root.
  for (const worktreePath of await listSessionWorktreePaths(cwd, sessionId)) {
    const base = path.basename(worktreePath);
    const item: ResidueWorktree = { kind: "worktree", worktreePath };
    items.push(item);
    const owned = base === "_integration" ||
      manifests.some(({ value }) => value.tasks.some((task) => task.taskId === base));
    if (!owned) unattributed.push(item);
  }

  return {
    items,
    unattributed,
    actionableRuns: manifests
      .filter(({ value }) => !isTerminalRunStatus(value.status) || value.status === "review_pending")
      .map(({ value }) => ({
        runId: value.runId,
        status: value.status,
        recoverySafe: value.recovery?.safe === true,
      })),
  };
}

/** The refusal a fresh run prints; every line is either evidence or a way out. */
export function formatResidueRefusal(sessionId: string, residue: SessionResidue): string {
  const lines = [
    `La sesión ${sessionId} tiene residuo de una ejecución anterior; no se inicia un run nuevo.`,
    "",
  ];
  for (const item of residue.items) {
    if (item.kind === "ref") {
      const label = item.merged === false ? "ref no mergeada" : "ref";
      const owner = item.runId ? `run ${item.runId} (${item.runStatus})` : "sin manifest dueño";
      lines.push(`  ${label.padEnd(18)} ${item.branch.padEnd(28)} ${item.tip.slice(0, 7)}   ${owner}`);
    } else if (item.kind === "worktree") {
      lines.push(`  ${"worktree activo".padEnd(18)} ${item.worktreePath}`);
    } else {
      lines.push(`  ${"manifest abierto".padEnd(18)} ${item.runId.padEnd(28)} ${item.status}`);
    }
  }
  if (residue.actionableRuns.length > 0) {
    lines.push("");
    for (const run of residue.actionableRuns) {
      lines.push(`  slad pipeline run --review ${run.runId}    ver qué quedó`);
      if (run.recoverySafe) lines.push(`  slad pipeline run --resume ${run.runId}    continuar donde se cortó`);
      lines.push(`  slad pipeline run --apply  ${run.runId}    aplicar lo integrado`);
      lines.push(`  slad pipeline run --abort  ${run.runId}    descartar y limpiar la sesión`);
    }
  }
  if (residue.unattributed.length > 0) {
    lines.push("", "  Residuo sin manifest dueño (SLAD no lo toca):");
    for (const item of residue.unattributed) {
      if (item.kind === "ref") lines.push(`    git branch -D ${item.branch}`);
      else if (item.kind === "worktree") lines.push(`    git worktree remove --force ${item.worktreePath}`);
    }
  }
  return lines.join("\n");
}
