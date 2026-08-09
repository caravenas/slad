import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(execFile);

/**
 * Git worktree lifecycle for `slad pipeline run --parallel --worktrees`.
 *
 * Each task runs in its own worktree branched from a session integration
 * branch; successful tasks are committed and merged sequentially into the
 * integration branch. The run ends there (review_pending): the main worktree
 * is never touched until an explicit `run --apply <runId>` squashes the
 * integration branch as staged, uncommitted changes, or `run --abort <runId>`
 * discards it. A `run --from-review <runId>` follow-up continues the same
 * integration branch from its tip.
 */

// Transient commits on slad/* branches; identity is fixed so runs never
// depend on (or pollute) the user's git config, and hooks are skipped.
const COMMIT_FLAGS = ["-c", "user.name=slad", "-c", "user.email=slad@local"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execP("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

export function sessionBranch(sessionId: string, suffix: string): string {
  return `slad/${sessionId}/${suffix}`;
}

function sessionWorktreesRoot(cwd: string, sessionId: string): string {
  return path.join(cwd, ".slad-os", "sessions", sessionId, "worktrees");
}

export interface IntegrationSetup {
  integrationBranch: string;
  integrationDir: string;
  baseRef: string;
}

export async function assertWorktreeReady(cwd: string): Promise<void> {
  await git(cwd, "rev-parse", "--verify", "HEAD").catch(() => {
    throw new Error("El modo --worktrees requiere un repo git con al menos un commit.");
  });
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, "status", "--porcelain")).length > 0;
}

/** Parses NUL-delimited `git status --porcelain=v1 -z` output into changed paths. */
export function parseGitStatusPorcelainZ(stdout: string): Set<string> {
  const entries = stdout.split("\0");
  const files = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) files.add(file);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return files;
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Removes any worktrees and slad/<sessionId>/* branches left by a previous run. */
export async function removeSessionWorktrees(cwd: string, sessionId: string): Promise<void> {
  const root = sessionWorktreesRoot(cwd, sessionId);
  // git reports fully resolved paths; the caller's cwd may traverse symlinks
  // (e.g. /var → /private/var on macOS), so match against both forms.
  const rootReal = safeRealpath(root);
  // Match only the root itself or paths under it — a bare prefix check would
  // also catch siblings like ".../worktrees-backup".
  const isUnderRoot = (candidate: string, base: string): boolean =>
    candidate === base || candidate.startsWith(base + path.sep);
  const listing = await git(cwd, "worktree", "list", "--porcelain").catch(() => "");
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length);
    if (isUnderRoot(worktreePath, root) || isUnderRoot(worktreePath, rootReal)) {
      await git(cwd, "worktree", "remove", "--force", worktreePath).catch(() => undefined);
    }
  }
  await git(cwd, "worktree", "prune").catch(() => undefined);
  const branches = await git(
    cwd, "for-each-ref", `refs/heads/slad/${sessionId}/`, "--format=%(refname:short)",
  ).catch(() => "");
  for (const branch of branches.split("\n").filter(Boolean)) {
    await git(cwd, "branch", "-D", branch).catch(() => undefined);
  }
}

/**
 * Creates the session integration worktree/branch at `fromRef` (default HEAD).
 * A --from-review follow-up passes the previous run's integration tip so the
 * new run continues on top of the not-yet-applied result.
 */
export async function setupIntegration(
  cwd: string,
  sessionId: string,
  fromRef?: string,
): Promise<IntegrationSetup> {
  // Resolve before cleanup: removeSessionWorktrees deletes slad/* branches,
  // so a fromRef naming one must be pinned to a sha first.
  const baseRef = await git(cwd, "rev-parse", "--verify", `${fromRef ?? "HEAD"}^{commit}`).catch(() => {
    throw new Error(`La ref base de integración no existe en este repo: ${fromRef ?? "HEAD"}`);
  });
  await removeSessionWorktrees(cwd, sessionId);
  const integrationBranch = sessionBranch(sessionId, "integration");
  const integrationDir = path.join(sessionWorktreesRoot(cwd, sessionId), "_integration");
  await git(cwd, "worktree", "add", "-B", integrationBranch, integrationDir, baseRef);
  return { integrationBranch, integrationDir, baseRef };
}

/** Current tip of the integration branch — the base for the next wave's worktrees. */
export function integrationTip(setup: IntegrationSetup): Promise<string> {
  return git(setup.integrationDir, "rev-parse", "HEAD");
}

export async function addTaskWorktree(
  cwd: string,
  sessionId: string,
  taskId: string,
  baseRef: string,
): Promise<string> {
  const dir = path.join(sessionWorktreesRoot(cwd, sessionId), taskId);
  await git(cwd, "worktree", "add", "-B", sessionBranch(sessionId, taskId), dir, baseRef);
  return dir;
}

export interface TaskCommitResult {
  committed: boolean;
  changedFiles: string[];
}

/** Commits everything the worker changed in its worktree. */
export async function commitTaskWork(
  worktreeDir: string,
  taskId: string,
  title: string,
): Promise<TaskCommitResult> {
  // Raw exec (not the trimming git() helper): the status prefix of the first
  // entry may start with a space, and trimming it shifts the path offset.
  // -uall lists individual files inside untracked directories; without it a
  // declared file under a new directory is reported as "dir/" and per-task
  // ownership attribution flags it as a false violation.
  const { stdout } = await execP("git", ["-C", worktreeDir, "status", "--porcelain=v1", "-z", "-uall"]);
  const changedFiles = [...parseGitStatusPorcelainZ(stdout)];
  if (changedFiles.length === 0) return { committed: false, changedFiles: [] };

  await git(worktreeDir, "add", "-A");
  await git(worktreeDir, ...COMMIT_FLAGS, "commit", "--no-verify", "-m", `slad ${taskId}: ${title}`);
  return { committed: true, changedFiles };
}

/** Merges a task branch into the integration branch. False on conflict (aborted). */
export async function mergeTaskBranch(
  setup: IntegrationSetup,
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  try {
    await git(
      setup.integrationDir,
      ...COMMIT_FLAGS,
      "merge", "--no-ff", "--no-verify",
      "-m", `slad merge ${taskId}`,
      sessionBranch(sessionId, taskId),
    );
    return true;
  } catch {
    await git(setup.integrationDir, "merge", "--abort").catch(() => undefined);
    return false;
  }
}

/** Current sha of a local branch, or null if it no longer exists. */
export async function branchTip(cwd: string, branch: string): Promise<string | null> {
  return git(cwd, "rev-parse", "--verify", `refs/heads/${branch}`).catch(() => null);
}

export interface ApplyIntegrationOptions {
  branch: string;
  /** Main worktree HEAD recorded when the review chain started. */
  baseRef: string;
  /** Integration tip recorded in the run manifest. */
  expectedTip: string;
}

/**
 * Applies a reviewed integration branch onto the main worktree as staged,
 * uncommitted changes (`merge --squash`). Returns an error message when any
 * guard fails; nothing is touched in that case.
 */
export async function applyIntegrationBranch(
  cwd: string,
  { branch, baseRef, expectedTip }: ApplyIntegrationOptions,
): Promise<string | null> {
  const tip = await branchTip(cwd, branch);
  if (!tip) return `la rama de integración ${branch} ya no existe`;
  if (tip !== expectedTip) {
    return `la rama ${branch} se movió desde el run (tip ${tip.slice(0, 12)} ≠ manifest ${expectedTip.slice(0, 12)})`;
  }
  const head = await git(cwd, "rev-parse", "HEAD");
  if (head !== baseRef) {
    return `el worktree principal se movió desde el run (HEAD ${head.slice(0, 12)} ≠ base ${baseRef.slice(0, 12)}); el squash asumía esa base`;
  }
  // A squash on top of uncommitted changes would mix that work with the
  // session's result.
  if (await hasUncommittedChanges(cwd)) {
    return "el worktree principal tiene cambios sin commitear; commitea o stashea antes de aplicar";
  }
  try {
    await git(cwd, "merge", "--squash", branch);
    return null;
  } catch (err) {
    await git(cwd, "reset", "--hard", "HEAD").catch(() => undefined);
    return (err as Error).message.slice(0, 400);
  }
}

/** Human-readable summary of a pending integration range for `run --review`. */
export async function describeIntegration(
  cwd: string,
  baseRef: string,
  tip: string,
): Promise<{ commits: string; diffStat: string }> {
  const range = `${baseRef}..${tip}`;
  return {
    commits: await git(cwd, "log", "--oneline", range).catch(() => "(rango no disponible en este repo)"),
    diffStat: await git(cwd, "diff", "--stat", baseRef, tip).catch(() => "(diff no disponible)"),
  };
}
