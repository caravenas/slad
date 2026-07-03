import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanOutput, PlanTask, RunOutput } from "../core/types.js";
import {
  buildHandoffPrompt,
  computeOwnershipViolations,
  parseWorkerOutput,
  renderStatusTable,
  runParallel,
} from "./run-parallel.js";

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

function workerJson(taskId: string, status: RunOutput["status"] = "completed"): string {
  return JSON.stringify({ taskId, status, summary: `${taskId} ${status}` });
}

describe("buildHandoffPrompt", () => {
  it("incluye la lista de archivos propios y el contrato JSON", () => {
    const prompt = buildHandoffPrompt(task("T1", ["src/a.ts"]), plan([task("T1", ["src/a.ts"])]));
    assert.ok(prompt.includes("- src/a.ts"));
    assert.ok(prompt.includes('"taskId": "T1"'));
    assert.ok(prompt.includes("no toques nada fuera de tu lista"));
  });

  it("marca las tareas sin files como worker único", () => {
    const prompt = buildHandoffPrompt(task("T1", []), plan([task("T1", [])]));
    assert.ok(prompt.includes("único worker"));
  });
});

describe("parseWorkerOutput", () => {
  const t1 = task("T1", ["a.ts"]);

  it("extrae el último JSON válido después de prosa", () => {
    const stdout = `Working...\nDone with edits {not json}\n${workerJson("T1")}\n`;
    const output = parseWorkerOutput(t1, stdout, 0);
    assert.equal(output.status, "completed");
    assert.equal(output.summary, "T1 completed");
  });

  it("fuerza el taskId de la tarea aunque el worker reporte otro", () => {
    const output = parseWorkerOutput(t1, workerJson("T9"), 0);
    assert.equal(output.taskId, "T1");
  });

  it("exit != 0 sin JSON produce failed", () => {
    const output = parseWorkerOutput(t1, "boom", 3);
    assert.equal(output.status, "failed");
    assert.ok(output.summary.includes("code 3"));
  });

  it("exit 0 sin JSON produce completed con nota de falta de output estructurado", () => {
    const output = parseWorkerOutput(t1, "did stuff, no json", 0);
    assert.equal(output.status, "completed");
    assert.deepEqual(output.reviewerNotes, ["missing-run-output-json"]);
  });
});

describe("computeOwnershipViolations", () => {
  it("solo reporta archivos nuevos fuera del set declarado", () => {
    const before = new Set(["pre-existing.ts"]);
    const after = new Set(["pre-existing.ts", "owned.ts", "rogue.ts"]);
    const owned = new Set(["owned.ts"]);
    assert.deepEqual(computeOwnershipViolations(before, after, owned), ["rogue.ts"]);
  });

  it("retorna vacío cuando todo cambio es declarado o preexistente", () => {
    const before = new Set(["dirty.ts"]);
    const after = new Set(["dirty.ts", "owned.ts"]);
    assert.deepEqual(computeOwnershipViolations(before, after, new Set(["owned.ts"])), []);
  });
});

describe("renderStatusTable", () => {
  it("muestra estado y ola por tarea", () => {
    const tasks = [task("T1", ["a.ts"]), task("T2", ["b.ts"])];
    const state = new Map([["T1", "done" as const], ["T2", "pending" as const]]);
    const table = renderStatusTable(tasks, state, new Map([["T1", 1]]));
    assert.ok(table.includes("T1"));
    assert.ok(table.includes("done"));
    assert.ok(table.includes("w1"));
    assert.ok(table.includes("pending"));
  });
});

describe("runParallel", () => {
  function tmpCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "slad-parallel-"));
  }

  it("agenda olas disjuntas y ejecuta todo el plan", async () => {
    const cwd = tmpCwd();
    const executed: string[][] = [];
    let waveBuffer: string[] = [];

    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"]), task("T2", ["a.ts", "b.ts"]), task("T3", ["c.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => new Set(),
      runWorker: async (t) => {
        waveBuffer.push(t.id);
        await new Promise((resolve) => setImmediate(resolve));
        if (waveBuffer.length > 0) {
          executed.push([...waveBuffer].sort());
          waveBuffer = [];
        }
        return { exitCode: 0, stdout: workerJson(t.id) };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outputs.length, 3);
    // T1 y T3 comparten ola (files disjuntos); T2 corre después (solapa con T1)
    assert.deepEqual(executed[0], ["T1", "T3"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("una tarea fallida saltea a sus dependientes", async () => {
    const cwd = tmpCwd();
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"]), task("T2", ["b.ts"], ["T1"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => new Set(),
      runWorker: async (t) => ({ exitCode: t.id === "T1" ? 1 : 0, stdout: "" }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0]!.status, "failed");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("strict ownership marca la ola como failed ante archivos no declarados", async () => {
    const cwd = tmpCwd();
    let call = 0;
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: true,
      print: () => undefined,
      listChangedFiles: async () => (call++ === 0 ? new Set() : new Set(["rogue.ts"])),
      runWorker: async (t) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.outputs[0]!.status, "failed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("rogue.ts")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("sin strict ownership la violación solo deja nota", async () => {
    const cwd = tmpCwd();
    let call = 0;
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => (call++ === 0 ? new Set() : new Set(["rogue.ts"])),
      runWorker: async (t) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.equal(result.status, "completed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("rogue.ts")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("persiste el prompt del worker y llama onTaskOutput por tarea", async () => {
    const cwd = tmpCwd();
    const persisted: string[] = [];
    await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => new Set(),
      onTaskOutput: async (output) => {
        persisted.push(output.taskId);
      },
      runWorker: async (t) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.deepEqual(persisted, ["T1"]);
    const promptPath = path.join(cwd, ".slad-os", "sessions", "s1", "tasks", "T1", "prompt.txt");
    assert.ok(fs.existsSync(promptPath));
    assert.ok(fs.readFileSync(promptPath, "utf8").includes("Selected task"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("computeOwnershipViolations — exenciones", () => {
  it("ignora el estado propio de slad (.slad-os/, docs/)", () => {
    const after = new Set([".slad-os/", ".slad-os/sessions/x/tasks/T1/output.txt", "docs/log/runs/r.json", "rogue.ts"]);
    assert.deepEqual(computeOwnershipViolations(new Set(), after, new Set()), ["rogue.ts"]);
  });
});
