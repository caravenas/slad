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
 * integration branch, and at the end the integration branch is squashed
 * into the main worktree WITHOUT committing — the user reviews and commits,
 * exactly like a shared-worktree run.
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
  const listing = await git(cwd, "worktree", "list", "--porcelain").catch(() => "");
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length);
    if (worktreePath.startsWith(root) || worktreePath.startsWith(rootReal)) {
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

export async function setupIntegration(cwd: string, sessionId: string): Promise<IntegrationSetup> {
  await removeSessionWorktrees(cwd, sessionId);
  const integrationBranch = sessionBranch(sessionId, "integration");
  const integrationDir = path.join(sessionWorktreesRoot(cwd, sessionId), "_integration");
  await git(cwd, "worktree", "add", "-B", integrationBranch, integrationDir, "HEAD");
  return { integrationBranch, integrationDir, baseRef: await git(cwd, "rev-parse", "HEAD") };
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
  const status = await git(worktreeDir, "status", "--porcelain");
  if (!status) return { committed: false, changedFiles: [] };

  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const pathPart = line.slice(3);
      const renamed = pathPart.split(" -> ");
      return (renamed[renamed.length - 1] ?? pathPart).trim();
    });

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

/**
 * Applies the integration branch onto the main worktree as staged,
 * uncommitted changes (`merge --squash`). Returns an error message on
 * failure; the integration branch is preserved for manual recovery.
 */
export async function squashIntoMain(cwd: string, setup: IntegrationSetup): Promise<string | null> {
  const tip = await integrationTip(setup);
  if (tip === setup.baseRef) return null; // nothing merged — nothing to apply
  try {
    await git(cwd, "merge", "--squash", setup.integrationBranch);
    return null;
  } catch (err) {
    return (err as Error).message.slice(0, 400);
  }
}
