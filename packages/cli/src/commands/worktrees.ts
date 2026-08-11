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

/** Match only the root itself or paths under it — a bare prefix check would
 * also catch siblings like ".../worktrees-backup". */
function isUnderRoot(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/** Registered worktree paths of the session, as git reports them. */
export async function listSessionWorktreePaths(cwd: string, sessionId: string): Promise<string[]> {
  const root = sessionWorktreesRoot(cwd, sessionId);
  // git reports fully resolved paths; the caller's cwd may traverse symlinks
  // (e.g. /var → /private/var on macOS), so match against both forms.
  const rootReal = safeRealpath(root);
  const listing = await git(cwd, "worktree", "list", "--porcelain").catch(() => "");
  const paths: string[] = [];
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length);
    if (isUnderRoot(worktreePath, root) || isUnderRoot(worktreePath, rootReal)) paths.push(worktreePath);
  }
  return paths;
}

/** `slad/<sessionId>/*` branch names that currently exist, with their tips. */
export async function listSessionRefs(
  cwd: string,
  sessionId: string,
): Promise<{ branch: string; tip: string }[]> {
  const listing = await git(
    cwd, "for-each-ref", `refs/heads/slad/${sessionId}/`, "--format=%(refname:short)%09%(objectname)",
  ).catch(() => "");
  return listing.split("\n").filter(Boolean).map((line) => {
    const [branch, tip] = line.split("\t");
    return { branch: branch!, tip: tip ?? "" };
  });
}

/** The trailing segment of `slad/<sessionId>/<suffix>`, or null when malformed. */
export function sessionRefSuffix(branch: string, sessionId: string): string | null {
  const prefix = `slad/${sessionId}/`;
  return branch.startsWith(prefix) ? branch.slice(prefix.length) || null : null;
}

/** Reachability, never commit-message parsing: is `ref` already in `tip`? */
export async function isAncestorRef(cwd: string, ref: string, tip: string): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ref, tip);
    return true;
  } catch {
    return false;
  }
}

/** Removes any worktrees and slad/<sessionId>/* branches left by a previous run. */
export async function removeSessionWorktrees(cwd: string, sessionId: string): Promise<void> {
  for (const worktreePath of await listSessionWorktreePaths(cwd, sessionId)) {
    await git(cwd, "worktree", "remove", "--force", worktreePath).catch(() => undefined);
  }
  await git(cwd, "worktree", "prune").catch(() => undefined);
  for (const { branch } of await listSessionRefs(cwd, sessionId)) {
    await git(cwd, "branch", "-D", branch).catch(() => undefined);
  }
}

/**
 * Recycles the *task* worktrees of a resume/follow-up: `addTaskWorktree` uses
 * fixed paths and `worktree add` fails when the directory is already
 * registered. Never touches `_integration` nor `slad/<sessionId>/integration`,
 * and only acts on task ids the caller could attribute to the parent manifest.
 */
export async function removeTaskWorktrees(
  cwd: string,
  sessionId: string,
  taskIds: readonly string[],
): Promise<void> {
  const root = sessionWorktreesRoot(cwd, sessionId);
  const rootReal = safeRealpath(root);
  const known = new Set(taskIds);
  for (const worktreePath of await listSessionWorktreePaths(cwd, sessionId)) {
    const base = path.basename(worktreePath);
    if (base === "_integration" || !known.has(base)) continue;
    if (!isUnderRoot(worktreePath, root) && !isUnderRoot(worktreePath, rootReal)) continue;
    await git(cwd, "worktree", "remove", "--force", worktreePath).catch(() => undefined);
  }
  await git(cwd, "worktree", "prune").catch(() => undefined);
}

export interface SetupIntegrationOptions {
  /**
   * Task ids whose worktrees may be recycled (`--resume` / `--from-review`):
   * `addTaskWorktree` uses fixed paths and `worktree add` fails on a directory
   * that is already registered. The fresh-run path passes nothing — its
   * residue must already be resolved by the caller's guard, because SLAD never
   * cleans ambiguous residue on its own.
   */
  recycleTasks?: readonly string[];
}

/**
 * Creates (or reuses) the session integration worktree/branch at `fromRef`
 * (default HEAD). A --from-review follow-up or a --resume passes the previous
 * integration tip so the new run continues on top of the not-yet-applied
 * result; reusing the existing worktree keeps the pinned base permanently
 * reachable instead of deleting and recreating the branch around it.
 */
export async function setupIntegration(
  cwd: string,
  sessionId: string,
  fromRef?: string,
  options: SetupIntegrationOptions = {},
): Promise<IntegrationSetup> {
  // Resolve first: a fromRef naming a slad/* branch must be pinned to a sha
  // before any cleanup can move it.
  const baseRef = await git(cwd, "rev-parse", "--verify", `${fromRef ?? "HEAD"}^{commit}`).catch(() => {
    throw new Error(`La ref base de integración no existe en este repo: ${fromRef ?? "HEAD"}`);
  });
  const integrationBranch = sessionBranch(sessionId, "integration");
  const integrationDir = path.join(sessionWorktreesRoot(cwd, sessionId), "_integration");
  // Both `worktree add -B` and `checkout -B` would silently move an existing
  // integration branch onto the new base, discarding merged work. That is the
  // one way this system could lose work (F5), so it refuses instead. A chain
  // continuation is unaffected: there, baseRef *is* the current tip.
  const existingTip = await branchTip(cwd, integrationBranch);
  if (existingTip !== null && existingTip !== baseRef) {
    throw new Error(
      `La rama de integración ${integrationBranch} ya tiene trabajo sin aplicar ` +
      `(tip ${existingTip.slice(0, 12)} ≠ base ${baseRef.slice(0, 12)}); ` +
      "resolvela con --review / --resume / --apply / --abort antes de arrancar un run nuevo.",
    );
  }
  if (options.recycleTasks?.length) {
    await removeTaskWorktrees(cwd, sessionId, options.recycleTasks);
  }
  const registered = await listSessionWorktreePaths(cwd, sessionId);
  const reusable = registered.some((candidate) =>
    candidate === integrationDir || candidate === safeRealpath(integrationDir));
  if (reusable) {
    await git(integrationDir, "checkout", "-q", "-B", integrationBranch, baseRef);
  } else {
    await git(cwd, "worktree", "add", "-B", integrationBranch, integrationDir, baseRef);
  }
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
