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
