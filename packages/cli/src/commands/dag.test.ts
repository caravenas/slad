import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getParallelRunnableTasks, autoSkipDependents, type TaskStatus } from "./dag.js";
import type { PlanTask } from "../core/types.js";

function task(id: string, opts: { dependsOn?: string[]; priority?: PlanTask["priority"] } = {}): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    type: "implementation",
    acceptanceCriteria: ["done"],
    files: [],
    dependsOn: opts.dependsOn ?? [],
    priority: opts.priority ?? "medium",
  };
}

function stateOf(entries: Record<string, TaskStatus>): Map<string, TaskStatus> {
  return new Map(Object.entries(entries));
}

describe("getParallelRunnableTasks", () => {
  it("retorna todas las tareas pendientes sin dependencias", () => {
    const tasks = [task("t1"), task("t2"), task("t3")];
    const state = stateOf({ t1: "pending", t2: "pending", t3: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 3);
    const ids = runnable.map((t) => t.id);
    assert.ok(ids.includes("t1"));
    assert.ok(ids.includes("t2"));
    assert.ok(ids.includes("t3"));
  });

  it("no retorna tareas con dependencias pendientes", () => {
    const tasks = [task("t1"), task("t2", { dependsOn: ["t1"] })];
    const state = stateOf({ t1: "pending", t2: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 1);
    assert.equal(runnable[0]!.id, "t1");
  });

  it("retorna tarea cuando su dependencia está done", () => {
    const tasks = [task("t1"), task("t2", { dependsOn: ["t1"] })];
    const state = stateOf({ t1: "done", t2: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 1);
    assert.equal(runnable[0]!.id, "t2");
  });

  it("no retorna tareas con dependencias skipped o failed", () => {
    const tasks = [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
      task("t3", { dependsOn: ["t1"] }),
    ];
    const state = stateOf({ t1: "skipped", t2: "pending", t3: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 0);
  });

  it("ordena por prioridad: high antes que medium antes que low", () => {
    const tasks = [
      task("t1", { priority: "low" }),
      task("t2", { priority: "high" }),
      task("t3", { priority: "medium" }),
    ];
    const state = stateOf({ t1: "pending", t2: "pending", t3: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 3);
    assert.equal(runnable[0]!.id, "t2"); // high
    assert.equal(runnable[1]!.id, "t3"); // medium
    assert.equal(runnable[2]!.id, "t1"); // low
  });

  it("retorna array vacío cuando no hay tareas pending", () => {
    const tasks = [task("t1"), task("t2")];
    const state = stateOf({ t1: "done", t2: "done" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 0);
  });

  it("ramas independientes del DAG son todas retornadas", () => {
    // t1 → t2, t3 → t4 (dos cadenas independientes)
    const tasks = [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
      task("t3"),
      task("t4", { dependsOn: ["t3"] }),
    ];
    const state = stateOf({ t1: "done", t2: "pending", t3: "done", t4: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 2);
    const ids = runnable.map((t) => t.id);
    assert.ok(ids.includes("t2"));
    assert.ok(ids.includes("t4"));
  });

  it("tarea con múltiples dependencias: solo retorna si TODAS están done", () => {
    const tasks = [
      task("t1"),
      task("t2"),
      task("t3", { dependsOn: ["t1", "t2"] }),
    ];
    // solo t1 done, t2 pending → t3 no es runnable
    const state = stateOf({ t1: "done", t2: "pending", t3: "pending" });
    const runnable = getParallelRunnableTasks(tasks, state);
    assert.equal(runnable.length, 1);
    assert.equal(runnable[0]!.id, "t2");
  });
});

describe("autoSkipDependents", () => {
  it("skipea dependientes directos de una tarea fallida", () => {
    const tasks = [task("t1"), task("t2", { dependsOn: ["t1"] })];
    const state = stateOf({ t1: "failed", t2: "pending" });
    const skipped = autoSkipDependents(tasks, state, "t1");
    assert.deepEqual(skipped, ["t2"]);
    assert.equal(state.get("t2"), "skipped");
  });

  it("cascada: skipea transitivamente", () => {
    const tasks = [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
      task("t3", { dependsOn: ["t2"] }),
    ];
    const state = stateOf({ t1: "failed", t2: "pending", t3: "pending" });
    const skipped = autoSkipDependents(tasks, state, "t1");
    assert.equal(skipped.length, 2);
    assert.ok(skipped.includes("t2"));
    assert.ok(skipped.includes("t3"));
    assert.equal(state.get("t2"), "skipped");
    assert.equal(state.get("t3"), "skipped");
  });

  it("no toca tareas que no dependen de la fallida", () => {
    const tasks = [task("t1"), task("t2"), task("t3", { dependsOn: ["t2"] })];
    const state = stateOf({ t1: "failed", t2: "pending", t3: "pending" });
    autoSkipDependents(tasks, state, "t1");
    assert.equal(state.get("t2"), "pending");
    assert.equal(state.get("t3"), "pending");
  });

  it("retorna array vacío si no hay dependientes", () => {
    const tasks = [task("t1"), task("t2")];
    const state = stateOf({ t1: "failed", t2: "pending" });
    const skipped = autoSkipDependents(tasks, state, "t1");
    assert.equal(skipped.length, 0);
  });
});
