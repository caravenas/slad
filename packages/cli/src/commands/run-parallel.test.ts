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
  isPhantomCompletion,
  parseGitStatusPorcelainZ,
  parseWorkerOutput,
  renderStatusTable,
  runParallel,
} from "./run-parallel.js";
import { commitTaskWork, removeSessionWorktrees } from "./worktrees.js";

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

  it("exit 0 sin JSON produce failed/unverified", () => {
    const output = parseWorkerOutput(t1, "did stuff, no json", 0);
    assert.equal(output.status, "failed");
    assert.deepEqual(output.reviewerNotes, ["missing-run-output-json"]);
  });
});

describe("parseGitStatusPorcelainZ", () => {
  it("preserva espacios, comillas y rutas de destino en renames", () => {
    const parsed = parseGitStatusPorcelainZ(
      " M file with spaces.ts\0?? \\\"quoted\\\".ts\0R  new name.ts\0old name.ts\0",
    );
    assert.deepEqual([...parsed], ["file with spaces.ts", "\\\"quoted\\\".ts", "new name.ts"]);
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

describe("isPhantomCompletion", () => {
  function output(status: RunOutput["status"], changedFiles: string[] = []): RunOutput {
    return {
      taskId: "T1",
      status,
      summary: "",
      changedFiles,
      decisions: [],
      questions: [],
      humanAnswers: {},
      followUps: [],
      assumptions: [],
      verification: [],
      reviewerNotes: [],
    };
  }

  it("detecta completed con archivos declarados y cero cambios en git", () => {
    assert.equal(isPhantomCompletion(task("T1", ["src/a.ts"]), output("completed"), []), true);
  });

  it("detecta changedFiles reclamados que git no respalda", () => {
    assert.equal(isPhantomCompletion(task("T1", []), output("completed", ["src/a.ts"]), ["otro.ts"]), true);
  });

  it("no marca cuando git respalda al menos un archivo esperado", () => {
    assert.equal(isPhantomCompletion(task("T1", ["src/a.ts"]), output("completed"), ["src/a.ts"]), false);
  });

  it("no marca tareas fallidas ni tareas sin archivos esperados", () => {
    assert.equal(isPhantomCompletion(task("T1", ["src/a.ts"]), output("failed"), []), false);
    assert.equal(isPhantomCompletion(task("T1", []), output("completed"), []), false);
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
        await new Promise<void>((resolve) => { setImmediate(resolve); });
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

  it("marca phantom-completion cuando el worker reporta éxito sin cambios en git", async () => {
    const cwd = tmpCwd();
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => new Set(),
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.equal(result.outputs[0]!.status, "completed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("phantom-completion")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("con strict ownership la phantom-completion falla la tarea", async () => {
    const cwd = tmpCwd();
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: true,
      print: () => undefined,
      listChangedFiles: async () => new Set(),
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.outputs[0]!.status, "failed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("phantom-completion")));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("la suciedad previa a la ola no respalda una phantom-completion", async () => {
    const cwd = tmpCwd();
    // a.ts ya estaba sucio antes de la ola; el worker no escribe nada.
    const result = await runParallel({
      plan: plan([task("T1", ["a.ts"])]),
      sessionId: "s1",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      print: () => undefined,
      listChangedFiles: async () => new Set(["a.ts"]),
      runWorker: async ({ task: t }) => ({ exitCode: 0, stdout: workerJson(t.id) }),
    });

    assert.equal(result.outputs[0]!.status, "completed");
    assert.ok(result.outputs[0]!.reviewerNotes.some((n) => n.includes("phantom-completion")));
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

describe("runParallel — workspace compartido con git real", () => {
  it("strict ownership acepta un archivo declarado dentro de un directorio nuevo", async () => {
    const cwd = makeRepo();
    const result = await runParallel({
      plan: plan([task("T1", ["newdir/file.txt"])]),
      sessionId: "sh1",
      cwd,
      maxParallel: 3,
      strictOwnership: true,
      print: () => undefined,
      runWorker: async ({ task: t, workspace }) => {
        fs.mkdirSync(path.join(workspace, "newdir"), { recursive: true });
        fs.writeFileSync(path.join(workspace, "newdir", "file.txt"), `${t.id} ok\n`);
        return { exitCode: 0, stdout: workerJson(t.id) };
      },
    });

    assert.equal(result.status, "completed");
    // Sin -uall, git colapsa el directorio nuevo en "newdir/": falso
    // ownership-violation y falsa phantom-completion.
    assert.deepEqual(result.outputs[0]!.reviewerNotes, []);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("runParallel — worktrees", () => {
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

  it("strict ownership acepta archivos declarados bajo un directorio nuevo y los integra", async () => {
    const cwd = makeRepo();
    const result = await runParallel({
      plan: plan([task("T1", ["newdir/file.txt"])]),
      sessionId: "wt7",
      cwd,
      maxParallel: 3,
      strictOwnership: true,
      useWorktrees: true,
      print: () => undefined,
      runWorker: (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
        fs.mkdirSync(path.join(workspace, "newdir"), { recursive: true });
        fs.writeFileSync(path.join(workspace, "newdir", "file.txt"), `${t.id} ok\n`);
        return { exitCode: 0, stdout: workerJson(t.id) };
      }) as never,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.outputs[0]!.reviewerNotes, []);
    assert.deepEqual(result.outputs[0]!.changedFiles, ["newdir/file.txt"]);
    // El squash dejó el archivo staged en el worktree principal.
    assert.equal(fs.readFileSync(path.join(cwd, "newdir", "file.txt"), "utf8"), "T1 ok\n");
    assert.deepEqual(git(cwd, "diff", "--cached", "--name-only").split("\n"), ["newdir/file.txt"]);
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

  it("rechaza el modo worktrees si el worktree principal está sucio", async () => {
    const cwd = makeRepo();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "uncommitted\n");
    await assert.rejects(
      runParallel({
        plan: plan([task("T1", ["a.txt"])]),
        sessionId: "wt5",
        cwd,
        maxParallel: 3,
        strictOwnership: false,
        useWorktrees: true,
        print: () => undefined,
        runWorker: (async () => ({ exitCode: 0, stdout: workerJson("T1") })) as never,
      }),
      /worktree principal limpio/,
    );
    // Nada quedó a medias: sin worktrees de sesión ni ramas slad.
    assert.equal(git(cwd, "worktree", "list").split("\n").length, 1);
    assert.equal(git(cwd, "for-each-ref", "refs/heads/slad/", "--format=%(refname)"), "");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("aborta el squash si el worktree principal se ensució durante el run", async () => {
    const cwd = makeRepo();
    const lines: string[] = [];
    const result = await runParallel({
      plan: plan([task("T1", ["a.txt"])]),
      sessionId: "wt6",
      cwd,
      maxParallel: 3,
      strictOwnership: false,
      useWorktrees: true,
      print: (line) => { lines.push(line); },
      runWorker: (async ({ task: t, workspace }: { task: PlanTask; workspace: string }) => {
        fs.writeFileSync(path.join(workspace, "a.txt"), "ok\n");
        // Simula una edición del usuario en el worktree principal a mitad del run.
        fs.writeFileSync(path.join(cwd, "user-edit.txt"), "manual\n");
        return { exitCode: 0, stdout: workerJson(t.id) };
      }) as never,
    });

    // El squash no llegó al worktree principal: el run falla aunque las tareas
    // hayan completado, y sus outputs se preservan para diagnóstico.
    assert.equal(result.status, "failed");
    assert.equal(result.outputs[0]!.status, "completed");
    assert.ok(lines.some((line) => line.includes("No se pudo aplicar")));
    // La edición manual queda intacta y el resultado no se mezcló encima.
    assert.equal(fs.readFileSync(path.join(cwd, "user-edit.txt"), "utf8"), "manual\n");
    assert.ok(!fs.existsSync(path.join(cwd, "a.txt")));
    // La rama de integración sobrevive para recuperación manual.
    assert.ok(git(cwd, "for-each-ref", "refs/heads/slad/wt6/", "--format=%(refname)").includes("integration"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("worktrees — helpers", () => {
  it("commitTaskWork preserva el primer path completo y nombres con espacios", async () => {
    const cwd = makeRepo();
    // README.md ordena primero: su entrada " M README.md" arranca con espacio,
    // que un trim global corrompía cortando la primera letra del path.
    fs.writeFileSync(path.join(cwd, "README.md"), "# repo edited\n");
    fs.writeFileSync(path.join(cwd, "new file.txt"), "spaces\n");
    const result = await commitTaskWork(cwd, "T1", "primer path");
    assert.equal(result.committed, true);
    assert.deepEqual([...result.changedFiles].sort(), ["README.md", "new file.txt"]);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("commitTaskWork reporta rutas completas de archivos bajo un directorio nuevo", async () => {
    const cwd = makeRepo();
    fs.mkdirSync(path.join(cwd, "newdir"));
    fs.writeFileSync(path.join(cwd, "newdir", "file.txt"), "x\n");
    const result = await commitTaskWork(cwd, "T1", "dir nuevo");
    assert.equal(result.committed, true);
    assert.deepEqual(result.changedFiles, ["newdir/file.txt"]);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("commitTaskWork sin cambios no genera commit", async () => {
    const cwd = makeRepo();
    const head = git(cwd, "rev-parse", "HEAD");
    const result = await commitTaskWork(cwd, "T1", "noop");
    assert.deepEqual(result, { committed: false, changedFiles: [] });
    assert.equal(git(cwd, "rev-parse", "HEAD"), head);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("removeSessionWorktrees no toca hermanos que comparten prefijo de ruta", async () => {
    const cwd = makeRepo();
    const sessionRoot = path.join(cwd, ".slad-os", "sessions", "wtX");
    const insideDir = path.join(sessionRoot, "worktrees", "T1");
    const siblingDir = path.join(sessionRoot, "worktrees-keep");
    git(cwd, "worktree", "add", "-q", "-B", "slad/wtX/T1", insideDir, "HEAD");
    git(cwd, "worktree", "add", "-q", "-B", "keep-me", siblingDir, "HEAD");

    await removeSessionWorktrees(cwd, "wtX");

    assert.ok(!fs.existsSync(insideDir), "el worktree de la sesión debe eliminarse");
    assert.ok(fs.existsSync(path.join(siblingDir, ".git")), "el hermano con prefijo compartido debe sobrevivir");
    assert.ok(git(cwd, "for-each-ref", "refs/heads/keep-me", "--format=%(refname)").includes("keep-me"));
    git(cwd, "worktree", "remove", "--force", siblingDir);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
