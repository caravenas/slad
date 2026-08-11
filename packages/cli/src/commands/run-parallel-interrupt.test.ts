import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { PlanOutput, PlanTask } from "../core/types.js";
import {
  checkpointTaskIntegration,
  createRunManifest,
  readRunManifest,
  recordIntegration,
  reserveTaskDispatch,
  type RunManifestHandle,
} from "../persistence/manifest.js";
import { DurableWriteError, runParallel } from "./run-parallel.js";
import { sessionBranch } from "./worktrees.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-interrupt-"));
  git(cwd, "init", "-q");
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\n");
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return cwd;
}

function task(id: string, files: string[], dependsOn: string[] = []): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    type: "implementation",
    priority: "medium",
    dependsOn,
    files,
    acceptanceCriteria: ["done"],
  };
}

function plan(tasks: PlanTask[]): PlanOutput {
  return {
    status: "completed",
    snapshot: "snapshot",
    summary: "test plan",
    tasks,
    verification: [],
    risks: [],
    openQuestions: [],
    questions: [],
    decisions: [],
  };
}

function workerJson(taskId: string, status = "completed"): string {
  return JSON.stringify({ taskId, status, summary: `${taskId} ${status}` });
}

/** Creates the run manifest the way run.ts does, including record-before-create. */
async function makeManifest(cwd: string, sessionId: string, tasks: PlanTask[], maxTasks = 10) {
  const manifest = await createRunManifest({
    runId: `run_${sessionId}`,
    sessionId,
    intent: "test",
    command: "run-parallel",
    backend: { provider: "cli" },
    tasks: tasks.map((item) => ({ taskId: item.id, status: "pending" as const })),
    limits: { maxTasks, maxParallel: 3 },
    worktrees: { enabled: true, keep: false },
    policy: { strictOwnership: false, taskDispatches: 0 },
  }, cwd);
  const baseRef = git(cwd, "rev-parse", "HEAD");
  await recordIntegration(manifest, {
    branch: sessionBranch(sessionId, "integration"),
    baseRef,
    tip: baseRef,
  });
  return { manifest, baseRef };
}

/** Wires runParallel's durable seams exactly as run.ts does. */
function durableSeams(manifest: RunManifestHandle) {
  return {
    onDispatchReserve: async (taskId: string, { worktree }: { worktree?: string }) => {
      await reserveTaskDispatch(manifest, { taskId, worktree });
    },
    onTaskIntegrated: async (
      taskId: string,
      checkpoint: { status: "completed" | "blocked" | "failed" | "skipped"; integrationTip?: string },
    ) => {
      await checkpointTaskIntegration(manifest, { taskId, ...checkpoint });
    },
  };
}

/** Worker that writes its declared files inside its own worktree. */
function writingWorker(hook?: (taskId: string) => void) {
  return (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
    hook?.(t.id);
    for (const file of t.files) fs.writeFileSync(path.join(workspace, file), `${t.id} wrote ${file}\n`);
    return { exitCode: 0, stdout: workerJson(t.id) };
  }) as never;
}

describe("U1 — I0: el manifest describe exactamente la rama tras cada merge", () => {
  it("en cada checkpoint el tip persistido iguala el tip real y la tarea ya está completed", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"]), task("T3", ["c.txt"], ["T1", "T2"])];
    const { manifest } = await makeManifest(cwd, "i0", tasks);
    const seams = durableSeams(manifest);
    const branch = sessionBranch("i0", "integration");
    const observed: { taskId: string; tipMatches: boolean; status: string }[] = [];

    await runParallel({
      plan: plan(tasks),
      sessionId: "i0",
      runId: "run_i0",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      onDispatchReserve: seams.onDispatchReserve,
      onTaskIntegrated: async (taskId, checkpoint) => {
        await seams.onTaskIntegrated(taskId, checkpoint);
        // Read back from disk: the durable state, not the in-memory copy.
        const onDisk = (await readRunManifest(manifest.path)).value;
        observed.push({
          taskId,
          tipMatches: onDisk.worktrees.integration?.tip === git(cwd, "rev-parse", branch),
          status: onDisk.tasks.find((item) => item.taskId === taskId)!.status,
        });
      },
      runWorker: writingWorker(),
    });

    assert.deepEqual(observed.map((entry) => entry.taskId), ["T1", "T2", "T3"]);
    assert.ok(observed.every((entry) => entry.tipMatches), "el tip del manifest debe igualar el tip real tras cada merge");
    assert.ok(observed.every((entry) => entry.status === "completed"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("una tarea que no mergea igual pasa por el checkpoint y reescribe el tip vigente", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"])];
    const { manifest, baseRef } = await makeManifest(cwd, "i0b", tasks);
    const seams = durableSeams(manifest);
    const checkpoints: string[] = [];

    await runParallel({
      plan: plan(tasks),
      sessionId: "i0b",
      runId: "run_i0b",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      onDispatchReserve: seams.onDispatchReserve,
      onTaskIntegrated: async (taskId, checkpoint) => {
        checkpoints.push(taskId);
        await seams.onTaskIntegrated(taskId, checkpoint);
      },
      // Worker fails and writes nothing: no commit, no merge.
      runWorker: (async () => ({ exitCode: 1, stdout: "" })) as never,
    });

    assert.deepEqual(checkpoints, ["T1"]);
    const onDisk = (await readRunManifest(manifest.path)).value;
    assert.equal(onDisk.tasks[0]!.status, "failed");
    assert.equal(onDisk.worktrees.integration?.tip, baseRef);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("U1' — A1: el checkpoint está desacoplado del artefacto", () => {
  it("un artefacto que falla no rompe I0: la tarea queda completed y la ola siguiente corre", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"], ["T1"])];
    const { manifest } = await makeManifest(cwd, "a1", tasks);
    const seams = durableSeams(manifest);
    const branch = sessionBranch("a1", "integration");
    const ran: string[] = [];

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "a1",
      runId: "run_a1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      ...seams,
      // Stands in for run.ts's secondary block failing (disk full, EACCES...).
      onTaskOutput: async (output) => {
        const reason = "writeArtifact boom";
        await manifest.value.tasks.forEach(() => undefined);
        const { updateRunManifest } = await import("../persistence/manifest.js");
        await updateRunManifest(manifest, (current) => ({
          ...current,
          tasks: current.tasks.map((item) => item.taskId === output.taskId
            ? { ...item, artifactError: reason }
            : item),
        }));
      },
      runWorker: writingWorker((taskId) => ran.push(taskId)),
    });

    assert.deepEqual(ran, ["T1", "T2"], "la ola siguiente corre igual");
    assert.equal(result.status, "completed");
    const onDisk = (await readRunManifest(manifest.path)).value;
    assert.equal(onDisk.worktrees.integration?.tip, git(cwd, "rev-parse", branch), "I0 se mantiene");
    assert.ok(onDisk.tasks.every((item) => item.status === "completed"), "el merge define completitud, no la evidencia");
    assert.ok(onDisk.tasks.every((item) => item.artifactError === "writeArtifact boom"));
    assert.deepEqual(onDisk.artifacts, [], "artifacts[] no es señal de completitud (I9)");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("un checkpoint que falla es fatal: no se spawnea nada más y se propaga DurableWriteError", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"], ["T1"])];
    const { manifest } = await makeManifest(cwd, "a1b", tasks);
    const seams = durableSeams(manifest);
    const ran: string[] = [];

    await assert.rejects(
      runParallel({
        plan: plan(tasks),
        sessionId: "a1b",
        runId: "run_a1b",
        cwd,
        maxParallel: 3,
        strictOwnership: false,
        useWorktrees: true,
        print: () => undefined,
        onDispatchReserve: seams.onDispatchReserve,
        onTaskIntegrated: async () => { throw new Error("disco lleno"); },
        runWorker: writingWorker((taskId) => ran.push(taskId)),
      }),
      (error: unknown) => error instanceof DurableWriteError && error.kind === "checkpoint",
    );

    assert.deepEqual(ran, ["T1"], "no se lanza ningún worker más tras el checkpoint fallido");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("U4' — A3: taskDispatches cuenta spawns reales", () => {
  it("en un run limpio el contador iguala los spawns exactos", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"]), task("T3", ["c.txt"], ["T1"])];
    const { manifest } = await makeManifest(cwd, "a3", tasks);
    let spawns = 0;

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "a3",
      runId: "run_a3",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      ...durableSeams(manifest),
      runWorker: writingWorker(() => { spawns += 1; }),
    });

    assert.equal(spawns, 3);
    assert.equal(result.taskDispatches, 3);
    assert.equal((await readRunManifest(manifest.path)).value.policy?.taskDispatches, 3);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("una tarea cuyo armado de workspace falla no reserva", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"])];
    const { manifest } = await makeManifest(cwd, "a3b", tasks);
    // A task id git cannot turn into a branch makes addTaskWorktree throw.
    const brokenPlan = plan([{ ...tasks[0]!, id: "T1" }]);
    let reservations = 0;

    await assert.rejects(runParallel({
      plan: brokenPlan,
      sessionId: "a3b",
      runId: "run_a3b",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      onDispatchReserve: async (taskId, context) => {
        reservations += 1;
        await reserveTaskDispatch(manifest, { taskId, ...context });
      },
      onTaskIntegrated: durableSeams(manifest).onTaskIntegrated,
      runWorker: writingWorker(),
      // Make the workspace setup fail deterministically.
      fromIntegration: { ref: "0000000000000000000000000000000000000000", baseRef: "x" },
    }));

    assert.equal(reservations, 0, "el throw ocurre antes de la escritura de reserva");
    assert.equal((await readRunManifest(manifest.path)).value.policy?.taskDispatches, 0);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("la falla de la escritura de reserva es fatal y no spawnea nada en esa ola", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"])];
    const { manifest } = await makeManifest(cwd, "a3c", tasks);
    let spawns = 0;

    await assert.rejects(
      runParallel({
        plan: plan(tasks),
        sessionId: "a3c",
        runId: "run_a3c",
        cwd,
        maxParallel: 3,
        strictOwnership: false,
        useWorktrees: true,
        print: () => undefined,
        onDispatchReserve: async () => { throw new Error("disco lleno"); },
        onTaskIntegrated: durableSeams(manifest).onTaskIntegrated,
        runWorker: writingWorker(() => { spawns += 1; }),
      }),
      (error: unknown) => error instanceof DurableWriteError && error.kind === "reservation",
    );

    assert.equal(spawns, 0);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("el budget se mide en dispatches de la cadena, no en outputs de esta invocación", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"]), task("T3", ["c.txt"])];
    const { manifest } = await makeManifest(cwd, "a3d", tasks, 3);
    let spawns = 0;

    // The chain already spent 2 of its 3 dispatches: only one more may start.
    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "a3d",
      runId: "run_a3d",
      cwd,
      maxParallel: 3,
      maxTasks: 3,
      taskDispatches: 2,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      ...durableSeams(manifest),
      runWorker: writingWorker(() => { spawns += 1; }),
    });

    assert.equal(spawns, 1);
    assert.equal(result.taskDispatches, 3);
    assert.equal(result.budgetExhausted, true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("las tareas del skip set no reservan ni se re-ejecutan", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"], ["T1"])];
    const { manifest } = await makeManifest(cwd, "a3e", tasks);
    const ran: string[] = [];

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "a3e",
      runId: "run_a3e",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      alreadyDone: ["T1"],
      taskDispatches: 1,
      print: () => undefined,
      ...durableSeams(manifest),
      runWorker: writingWorker((taskId) => ran.push(taskId)),
    });

    assert.deepEqual(ran, ["T2"], "T1 no se re-ejecuta y su dependiente sí se agenda");
    assert.equal(result.taskDispatches, 2, "solo el spawn nuevo suma");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("U9/U12/U13/U14 — señal, olas y orden", () => {
  it("U9: abort antes del bloque de integración descarta la ola entera", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"])];
    const { manifest, baseRef } = await makeManifest(cwd, "u9", tasks);
    const controller = new AbortController();
    const checkpoints: string[] = [];

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "u9",
      runId: "run_u9",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      // Kept so the branch survives the "nothing merged" cleanup and the tip
      // can be asserted directly.
      keepWorktrees: true,
      signal: controller.signal,
      print: () => undefined,
      onDispatchReserve: durableSeams(manifest).onDispatchReserve,
      onTaskIntegrated: async (taskId, checkpoint) => {
        checkpoints.push(taskId);
        await durableSeams(manifest).onTaskIntegrated(taskId, checkpoint);
      },
      runWorker: (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
        for (const file of t.files) fs.writeFileSync(path.join(workspace, file), `${t.id}\n`);
        controller.abort(); // signal arrives while the wave is still running
        return { exitCode: 0, stdout: workerJson(t.id) };
      }) as never,
    });

    assert.equal(result.interrupted, true);
    assert.deepEqual(checkpoints, [], "sin commits, sin merges, sin checkpoints");
    assert.deepEqual(result.outputs, [], "sin RunOutput emitidos");
    assert.equal(result.integration, undefined, "nada pendiente de review: la ola se descartó");
    assert.equal(git(cwd, "rev-parse", sessionBranch("u9", "integration")), baseRef, "el tip no se movió");
    const onDisk = (await readRunManifest(manifest.path)).value;
    assert.ok(onDisk.tasks.every((item) => item.status === "running" || item.status === "pending"),
      "las tareas descartadas quedan running/pending hasta que el terminalizador las marque interrupted");
    assert.ok(!onDisk.tasks.some((item) => item.status === "completed"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("U9b: abort después de lanzar la ola alcanza a todos los workers antes de resolver", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"])];
    const { manifest } = await makeManifest(cwd, "u9b", tasks);
    const controller = new AbortController();
    const started: string[] = [];
    const settled: string[] = [];
    const outputs: string[] = [];

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "u9b",
      runId: "run_u9b",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      signal: controller.signal,
      print: () => undefined,
      onDispatchReserve: durableSeams(manifest).onDispatchReserve,
      onTaskOutput: async (output) => {
        outputs.push(output.taskId);
      },
      runWorker: async ({ task: t, signal }: { task: PlanTask; signal?: AbortSignal }) => {
        started.push(t.id);
        if (started.length === tasks.length) queueMicrotask(() => controller.abort());
        await new Promise<void>((resolve) => {
          const finish = () => {
            signal?.removeEventListener("abort", finish);
            settled.push(t.id);
            resolve();
          };
          signal?.addEventListener("abort", finish, { once: true });
        });
        return { exitCode: 0, stdout: workerJson(t.id) };
      },
    });

    assert.deepEqual(started.sort(), ["T1", "T2"]);
    assert.deepEqual(settled.sort(), ["T1", "T2"]);
    assert.equal(result.interrupted, true);
    assert.deepEqual(outputs, []);
    assert.deepEqual(result.outputs, []);
    assert.equal(result.integration, undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("U12: el orden por tarea es commit → merge → checkpoint → artefacto", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"])];
    const { manifest } = await makeManifest(cwd, "u12", tasks);
    const events: string[] = [];

    await runParallel({
      plan: plan(tasks),
      sessionId: "u12",
      runId: "run_u12",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      onDispatchReserve: async (taskId, context) => {
        events.push(`reserve:${taskId}`);
        await reserveTaskDispatch(manifest, { taskId, ...context });
      },
      onTaskIntegrated: async (taskId, checkpoint) => {
        events.push(`checkpoint:${taskId}`);
        await durableSeams(manifest).onTaskIntegrated(taskId, checkpoint);
      },
      onTaskOutput: async (output) => { events.push(`artifact:${output.taskId}`); },
      runWorker: (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
        events.push(`spawn:${t.id}`);
        fs.writeFileSync(path.join(workspace, "a.txt"), "x\n");
        return { exitCode: 0, stdout: workerJson(t.id) };
      }) as never,
    });

    assert.deepEqual(events, ["reserve:T1", "spawn:T1", "checkpoint:T1", "artifact:T1"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("U12: con señal durante la ola, todas las tareas de la ola completan su bloque", async () => {
    const cwd = makeRepo();
    // T1 and T2 run in the same wave; the signal lands during the integration
    // block of T1, and T2 must still be committed, merged and checkpointed.
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"]), task("T3", ["c.txt"], ["T1"])];
    const { manifest } = await makeManifest(cwd, "u12b", tasks);
    const controller = new AbortController();
    const checkpoints: string[] = [];
    const ran: string[] = [];

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "u12b",
      runId: "run_u12b",
      cwd,
      maxParallel: 2,
      strictOwnership: false,
      useWorktrees: true,
      signal: controller.signal,
      print: () => undefined,
      onDispatchReserve: durableSeams(manifest).onDispatchReserve,
      onTaskIntegrated: async (taskId, checkpoint) => {
        checkpoints.push(taskId);
        controller.abort(); // arrives once the integration block already started
        await durableSeams(manifest).onTaskIntegrated(taskId, checkpoint);
      },
      runWorker: writingWorker((taskId) => ran.push(taskId)),
    });

    assert.deepEqual(ran, ["T1", "T2"], "T3 (ola siguiente) nunca se lanza");
    assert.deepEqual(checkpoints, ["T1", "T2"], "el bloque de la ola completa entero");
    assert.equal(result.interrupted, true);
    const onDisk = (await readRunManifest(manifest.path)).value;
    assert.equal(onDisk.worktrees.integration?.tip, git(cwd, "rev-parse", sessionBranch("u12b", "integration")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("U13: señal antes de reservar ⇒ cero reservas y cero spawns para esa tarea y las siguientes", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"]), task("T3", ["c.txt"])];
    const { manifest } = await makeManifest(cwd, "u13", tasks);
    const controller = new AbortController();
    const reservations: string[] = [];
    let spawns = 0;

    const result = await runParallel({
      plan: plan(tasks),
      sessionId: "u13",
      runId: "run_u13",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      signal: controller.signal,
      print: () => undefined,
      onDispatchReserve: async (taskId, context) => {
        reservations.push(taskId);
        await reserveTaskDispatch(manifest, { taskId, ...context });
        if (taskId === "T1") controller.abort(); // before T2's own signal check
      },
      onTaskIntegrated: durableSeams(manifest).onTaskIntegrated,
      runWorker: writingWorker(() => { spawns += 1; }),
    });

    assert.deepEqual(reservations, ["T1"], "T2 y T3 no reservan");
    assert.equal(spawns, 0, "ni siquiera T1 se lanza: la señal se observa tras su reserva");
    assert.equal(result.interrupted, true);
    assert.equal(result.taskDispatches, 1, "la reserva ya persistida no se revierte");
    assert.equal((await readRunManifest(manifest.path)).value.policy?.taskDispatches, 1);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("U14: la reserva no gastada descuenta el budget del resume siguiente", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"])];
    const { manifest } = await makeManifest(cwd, "u14", tasks, 2);
    const controller = new AbortController();

    const first = await runParallel({
      plan: plan(tasks),
      sessionId: "u14",
      runId: "run_u14",
      cwd,
      maxParallel: 3,
      maxTasks: 2,
      strictOwnership: false,
      useWorktrees: true,
      signal: controller.signal,
      print: () => undefined,
      onDispatchReserve: async (taskId, context) => {
        await reserveTaskDispatch(manifest, { taskId, ...context });
        controller.abort();
      },
      onTaskIntegrated: durableSeams(manifest).onTaskIntegrated,
      runWorker: writingWorker(),
    });

    assert.equal(first.taskDispatches, 1);
    assert.equal(first.interrupted, true);
    // The chain now sees 1 of 2 dispatches spent, even though nothing spawned.
    assert.equal((await readRunManifest(manifest.path)).value.policy?.taskDispatches, 1);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("no se hereda el fracaso: failed y skipped del padre vuelven a correr", async () => {
    const cwd = makeRepo();
    const tasks = [task("T1", ["a.txt"]), task("T2", ["b.txt"], ["T1"]), task("T3", ["c.txt"])];
    const { manifest } = await makeManifest(cwd, "i6", tasks);
    const ran: string[] = [];

    // Parent left T3 completed; T1 failed and T2 was a mere cascade skip.
    await runParallel({
      plan: plan(tasks),
      sessionId: "i6",
      runId: "run_i6",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      alreadyDone: ["T3"],
      print: () => undefined,
      ...durableSeams(manifest),
      runWorker: writingWorker((taskId) => ran.push(taskId)),
    });

    assert.deepEqual(ran.sort(), ["T1", "T2"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
