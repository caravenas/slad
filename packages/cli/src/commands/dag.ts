import type { PlanTask } from "../core/types.js";

export type TaskStatus = "pending" | "done" | "skipped" | "failed";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Returns all tasks that are currently runnable in parallel:
 * pending status + all dependencies are done.
 * Sorted by priority (high first), then original plan order as tiebreak.
 */
export function getParallelRunnableTasks(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
): PlanTask[] {
  const runnable = tasks.filter(
    (t) =>
      (state.get(t.id) ?? "pending") === "pending" &&
      t.dependsOn.every((dep) => state.get(dep) === "done"),
  );

  return runnable.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      tasks.indexOf(a) - tasks.indexOf(b),
  );
}

/**
 * Selects the next wave of tasks safe to run concurrently in a shared
 * worktree: runnable tasks whose declared `files` are pairwise disjoint.
 *
 * A task with empty `files` conservatively owns everything: it only runs
 * alone, and never joins a wave that already has members.
 */
export function getNextWave(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
  maxParallel = Number.POSITIVE_INFINITY,
): PlanTask[] {
  const wave: PlanTask[] = [];
  const claimedFiles = new Set<string>();

  for (const task of getParallelRunnableTasks(tasks, state)) {
    if (wave.length >= maxParallel) break;
    if (task.files.length === 0) {
      if (wave.length === 0) return [task];
      continue;
    }
    if (task.files.some((file) => claimedFiles.has(file))) continue;
    wave.push(task);
    for (const file of task.files) claimedFiles.add(file);
  }

  return wave;
}

/**
 * Marks all transitive dependents of a skipped/failed task as skipped.
 * Returns the list of newly skipped task IDs.
 */
export function autoSkipDependents(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
  skippedId: string,
): string[] {
  const skipped: string[] = [];
  const cascade = (id: string) => {
    for (const t of tasks) {
      if (t.dependsOn.includes(id) && (state.get(t.id) ?? "pending") === "pending") {
        state.set(t.id, "skipped");
        skipped.push(t.id);
        cascade(t.id);
      }
    }
  };
  cascade(skippedId);
  return skipped;
}
