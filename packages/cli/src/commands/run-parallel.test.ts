import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanOutput, PlanTask, RunOutput } from "../core/types.js";
import {
  buildHandoffPrompt,
  buildWorkerScript,
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

  it("incluye la memoria global del proyecto cuando se entrega", () => {
    const memory = "# SLAD\n\nConvención de runtime: .slad-os/.";
    const prompt = buildHandoffPrompt(task("T1", ["src/a.ts"]), plan([task("T1", ["src/a.ts"])]), memory);
    assert.ok(prompt.includes("Memoria global del proyecto"));
    assert.ok(prompt.includes("Convención de runtime: .slad-os/."));
  });

  it("omite la sección de memoria cuando no hay entrada", () => {
    const prompt = buildHandoffPrompt(task("T1", ["src/a.ts"]), plan([task("T1", ["src/a.ts"])]), null);
    assert.ok(!prompt.includes("Memoria global del proyecto"));
  });
});

describe("buildWorkerScript", () => {
  const ENV_KEYS = ["SLAD_CLI_BINARY", "SLAD_CLI_ARGS", "SLAD_CLI_PROMPT_MODE", "CLI_MODEL", "SLAD_CLI_MODEL_ARG"];

  function withEnv(env: Record<string, string>, fn: () => void): void {
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("en modo arg pone el modelo antes de los args base para que el prompt siga al flag de print", () => {
    withEnv(
      {
        SLAD_CLI_BINARY: "agy",
        SLAD_CLI_ARGS: "--print",
        SLAD_CLI_PROMPT_MODE: "arg",
        CLI_MODEL: "Gemini 3.5 Flash (Low)",
        SLAD_CLI_MODEL_ARG: "--model",
      },
      () => {
        const script = buildWorkerScript("/ws", "/worker");
        assert.ok(script.includes(`'--model' 'Gemini 3.5 Flash (Low)' '--print' "$(cat`));
      },
    );
  });

  it("sustituye {workspace} en los args por la ruta del workspace de la tarea", () => {
    withEnv(
      {
        SLAD_CLI_BINARY: "agy",
        SLAD_CLI_ARGS: "--dangerously-skip-permissions --add-dir {workspace} --print",
        SLAD_CLI_PROMPT_MODE: "arg",
      },
      () => {
        const script = buildWorkerScript("/tmp/task-worktree", "/worker");
        assert.ok(script.includes("'--add-dir' '/tmp/task-worktree' '--print'"));
        assert.ok(!script.includes("{workspace}"));
      },
    );
  });

  it("en modo stdin mantiene el modelo después de los args base", () => {
    withEnv(
      {
        SLAD_CLI_BINARY: "codex",
        SLAD_CLI_ARGS: "exec --sandbox workspace-write",
        SLAD_CLI_PROMPT_MODE: "stdin",
        CLI_MODEL: "gpt-5-codex",
        SLAD_CLI_MODEL_ARG: "--model",
      },
      () => {
        const script = buildWorkerScript("/ws", "/worker");
        assert.ok(script.includes("'exec' '--sandbox' 'workspace-write' '--model' 'gpt-5-codex' <"));
      },
    );
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
      runWorker: async ({ task: t }) => {
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
      runWorker: async ({ task: t }) => ({ exitCode: t.id === "T1" ? 1 : 0, stdout: "" }),
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
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
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
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
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
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
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

describe("runParallel — worktrees", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  function makeRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-wt-"));
    git(cwd, "init", "-q");
    fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    return cwd;
  }

  /** Worker that writes its owned files inside its (isolated) workspace. */
  function writingWorker(observed: Record<string, string[]>) {
    return async ({ task, workspace }: { task: PlanTask; workspace: string }) => {
      observed[task.id] = fs.readdirSync(workspace).filter((f) => f !== ".git").sort();
      for (const file of task.files) {
        fs.writeFileSync(path.join(workspace, file), `${task.id} wrote ${file}\n`);
      }
      return { exitCode: 0, stdout: workerJson(task.id) };
    };
  }

  it("aísla tareas, propaga olas previas y aplica squash sin commitear", async () => {
    const cwd = makeRepo();
    const headBefore = git(cwd, "rev-parse", "HEAD");
    const observed: Record<string, string[]> = {};

    const result = await runParallel({
      plan: plan([
        task("T1", ["a.txt"]),
        task("T2", ["b.txt"]),
        task("T3", ["c.txt"], ["T1", "T2"]),
      ]),
      sessionId: "wt1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      runWorker: writingWorker(observed) as never,
    });

    assert.equal(result.status, "completed");
    // Isolation: T1's worktree did not contain T2's file while running.
    assert.deepEqual(observed["T1"], [".gitignore", "README.md"]);
    // Propagation: T3's worktree (wave 2) contains wave 1 results.
    assert.deepEqual(observed["T3"], [".gitignore", "README.md", "a.txt", "b.txt"]);
    // Squash: files landed in the main worktree, staged, without new commits.
    assert.equal(git(cwd, "rev-parse", "HEAD"), headBefore);
    assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "T1 wrote a.txt\n");
    const staged = git(cwd, "diff", "--cached", "--name-only").split("\n").sort();
    assert.deepEqual(staged, ["a.txt", "b.txt", "c.txt"]);
    // changedFiles attributed per task from its commit.
    assert.deepEqual(result.outputs.find((o) => o.taskId === "T3")!.changedFiles, ["c.txt"]);
    // Cleanup: only the main worktree remains, no slad branches.
    assert.equal(git(cwd, "worktree", "list").split("\n").length, 1);
    assert.equal(git(cwd, "for-each-ref", "refs/heads/slad/", "--format=%(refname)"), "");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("strict ownership: la tarea infractora falla y su trabajo no se integra", async () => {
    const cwd = makeRepo();
    const result = await runParallel({
      plan: plan([task("T1", ["a.txt"])]),
      sessionId: "wt2",
      cwd,
      maxParallel: 3,
      strictOwnership: true,
      useWorktrees: true,
      print: () => undefined,
      runWorker: (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
        fs.writeFileSync(path.join(workspace, "a.txt"), "ok\n");
        fs.writeFileSync(path.join(workspace, "rogue.txt"), "not mine\n");
        return { exitCode: 0, stdout: workerJson(t.id) };
      }) as never,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.outputs[0]!.status, "failed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("rogue.txt")));
    assert.ok(!fs.existsSync(path.join(cwd, "a.txt")), "el trabajo infractor no debe integrarse");
    assert.ok(!fs.existsSync(path.join(cwd, "rogue.txt")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("una tarea sin cambios completa sin generar merge", async () => {
    const cwd = makeRepo();
    const headBefore = git(cwd, "rev-parse", "HEAD");
    const result = await runParallel({
      plan: plan([task("T1", ["a.txt"])]),
      sessionId: "wt3",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: () => undefined,
      runWorker: (async ({ task: t }: { task: PlanTask }) => ({ exitCode: 0, stdout: workerJson(t.id) })) as never,
    });

    assert.equal(result.status, "completed");
    assert.equal(git(cwd, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("un rerun de la misma sesión limpia worktrees y ramas anteriores", async () => {
    const cwd = makeRepo();
    const opts = {
      plan: plan([task("T1", ["a.txt"])]),
      sessionId: "wt4",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      keepWorktrees: true, // leave leftovers on purpose
      print: () => undefined,
      runWorker: writingWorker({}) as never,
    };
    assert.equal((await runParallel(opts)).status, "completed");
    // Reset the staged squash so the second run starts clean.
    git(cwd, "reset", "-q", "--hard", "HEAD");
    const second = await runParallel({ ...opts, keepWorktrees: false });
    assert.equal(second.status, "completed");
    assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "T1 wrote a.txt\n");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
