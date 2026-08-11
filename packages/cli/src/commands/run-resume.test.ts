import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createSession, getActiveSession, readSessionPlan } from "../core/session.js";
import { resetDocsRootCache } from "../persistence/layout.js";
import { createRunManifest, readRunManifest, updateRunManifest } from "../persistence/manifest.js";
import { writeWorkerSentinel } from "../core/worker-sentinels.js";
import { planCommand } from "./plan.js";
import { abortRunAction, applyRunAction, runCommand } from "./run.js";

const INTENT = "add math helpers";

const EXTERNAL_PLAN = {
  kind: "slad.external-plan",
  schemaVersion: 1,
  intent: INTENT,
  snapshot: { status: "completed", content: "# Snapshot\n\nAdd helpers." },
  plan: {
    status: "completed",
    snapshot: "Add helpers.",
    summary: "Two ordered tasks.",
    tasks: [
      {
        id: "T1", title: "Implement sum()", description: "Add sum()", type: "implementation",
        priority: "high", dependsOn: [], files: ["src/sum.ts"], acceptanceCriteria: ["sum works"],
      },
      {
        id: "T2", title: "Implement mean()", description: "Add mean()", type: "implementation",
        priority: "medium", dependsOn: ["T1"], files: ["src/mean.ts"], acceptanceCriteria: ["mean works"],
      },
    ],
    recommendedFirstTask: "T1",
  },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function branchExists(cwd: string, branch: string): boolean {
  return execFileSync("git", ["-C", cwd, "for-each-ref", `refs/heads/${branch}`, "--format=%(refname)"], {
    encoding: "utf8",
  }).trim().length > 0;
}

interface Fixture {
  cwd: string;
  sessionId: string;
  planHash: string;
  planId?: string;
  baseRef: string;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slad-resume-")));
  const originalCwd = process.cwd();
  const originalDocs = process.env.SLAD_DOCS_PATH;
  const originalExitCode = process.exitCode;
  try {
    process.chdir(cwd);
    process.env.SLAD_DOCS_PATH = path.join(cwd, "docs");
    process.exitCode = undefined;
    resetDocsRootCache();

    git(cwd, "init", "-q");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Project\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\ndocs/\nplan.json\n");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const baseRef = git(cwd, "rev-parse", "HEAD");

    const session = createSession(INTENT);
    fs.writeFileSync(path.join(cwd, "plan.json"), JSON.stringify(EXTERNAL_PLAN), "utf8");
    await planCommand({ import: path.join(cwd, "plan.json") });
    await planCommand({ approve: true });
    process.exitCode = undefined;

    const planRead = await readSessionPlan(getActiveSession()!);
    assert.ok(planRead, "el fixture necesita un plan aprobado");
    await fn({
      cwd,
      sessionId: session.id,
      planHash: planRead.value.approval.planHash,
      planId: planRead.value.planId,
      baseRef,
    });
  } finally {
    resetDocsRootCache();
    process.exitCode = originalExitCode;
    if (originalDocs === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocs;
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** An interrupted parent whose integration branch holds T1's merged work. */
async function interruptedParent(
  fixture: Fixture,
  overrides: {
    runId?: string;
    recovery?: { safe: boolean; reason: "signal" | "uncaught"; signal?: "SIGINT" | "SIGTERM" } | null;
    policy?: { strictOwnership: boolean; taskDispatches?: number } | null;
    maxTasks?: number;
    sessionId?: string;
    planHash?: string;
    approval?: "approved" | "pending";
    status?: "interrupted" | "review_pending";
  } = {},
) {
  const { cwd, baseRef } = fixture;
  const sessionId = overrides.sessionId ?? fixture.sessionId;
  const branch = `slad/${sessionId}/integration`;
  const worktreeDir = path.join(cwd, ".slad-os", "sessions", sessionId, "worktrees", "_integration");
  git(cwd, "worktree", "add", "-q", "-B", branch, worktreeDir, baseRef);
  fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "src", "sum.ts"), "export const sum = 1;\n");
  git(worktreeDir, "add", "-A");
  git(worktreeDir, "-c", "user.name=slad", "-c", "user.email=slad@local", "commit", "-qm", "slad T1: sum");
  const tip = git(worktreeDir, "rev-parse", "HEAD");

  const runId = overrides.runId ?? "run_parent";
  const handle = await createRunManifest({
    runId,
    sessionId,
    intent: INTENT,
    command: "run-parallel",
    plan: {
      planId: fixture.planId,
      hash: overrides.planHash ?? fixture.planHash,
      approval: overrides.approval ?? "approved",
    },
    backend: { provider: "cli" },
    tasks: [{ taskId: "T1", status: "completed" }, { taskId: "T2", status: "interrupted" }],
    limits: { maxTasks: overrides.maxTasks ?? 10, maxParallel: 3 },
    worktrees: { enabled: true, keep: false, integration: { branch, baseRef, tip } },
    ...(overrides.policy === null ? {} : { policy: overrides.policy ?? { strictOwnership: true, taskDispatches: 1 } }),
  }, cwd);
  await updateRunManifest(handle, {
    status: overrides.status ?? "interrupted",
    ...(overrides.recovery === null
      ? {}
      : { recovery: overrides.recovery ?? { safe: true, reason: "signal", signal: "SIGINT" } }),
  });
  return { runId, branch, tip, worktreeDir, manifestPath: handle.path, sessionId };
}

describe("--resume — guards de §7.1", () => {
  it("rechaza un padre de clase B con el diagnóstico de ambos tips", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { recovery: { safe: false, reason: "uncaught" } });
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await runCommand({ resume: parent.runId });
      } finally {
        console.error = original;
        console.log = originalLog;
      }

      assert.equal(process.exitCode, 1);
      const message = lines.join("\n");
      assert.ok(message.includes("sin handler de señal"));
      assert.ok(message.includes("tip registrado"));
      assert.ok(message.includes("tip real"));
      assert.ok(message.includes("--apply"));
      assert.ok(message.includes("--abort"));
      // Nothing executed, nothing deleted.
      assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "interrupted");
    });
  });

  it("un interrupted sin recovery (manifest viejo) se trata como no seguro", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { recovery: null });
      await runCommand({ resume: parent.runId });
      assert.equal(process.exitCode, 1);
      assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
    });
  });

  it("U2: un commit inyectado en la rama mueve el tip y el guard 8 rechaza", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      // Subject deliberately mimics a merge commit for a task that never ran:
      // no code may read it, and the tip check is what stops the resume.
      fs.writeFileSync(path.join(parent.worktreeDir, "sneaky.txt"), "x\n");
      git(parent.worktreeDir, "add", "-A");
      git(parent.worktreeDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "slad merge T9");

      await runCommand({ resume: parent.runId });

      assert.equal(process.exitCode, 1);
      assert.notEqual(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "interrupted");
    });
  });

  it("U6: un padre sin policy rechaza hasta que se pase la política explícita", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { policy: null });

      await runCommand({ resume: parent.runId });
      assert.equal(process.exitCode, 1);

      // With an explicit flag the guard passes; execution then fails for other
      // reasons in this fixture, but the policy guard is no longer the blocker.
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      process.exitCode = undefined;
      try {
        await runCommand({ resume: parent.runId, noStrictOwnership: true });
      } catch {
        // Worker execution is out of scope here.
      } finally {
        console.error = original;
      }
      assert.ok(!lines.join("\n").includes("política de ownership"));
    });
  });

  it("U6: un padre cuyo plan no quedó aprobado (--bypass) no es reanudable", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { approval: "pending" });
      await runCommand({ resume: parent.runId });
      assert.equal(process.exitCode, 1);
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "interrupted");
    });
  });

  it("rechaza un padre de otra sesión", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { sessionId: "otra-sesion" });
      await runCommand({ resume: parent.runId });
      assert.equal(process.exitCode, 1);
      assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
    });
  });

  it("rechaza un padre review_pending y redirige a --from-review", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { status: "review_pending" });
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await runCommand({ resume: parent.runId });
      } finally {
        console.error = original;
      }
      assert.equal(process.exitCode, 1);
      assert.ok(lines.join("\n").includes("--from-review"));
    });
  });

  it("U4': el budget agotado rechaza hasta que --max-tasks lo suba", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, {
        maxTasks: 2,
        policy: { strictOwnership: false, taskDispatches: 2 },
      });
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await runCommand({ resume: parent.runId });
        assert.equal(process.exitCode, 1);
        assert.ok(lines.join("\n").includes("agotó su budget"));

        // Lowering it is refused too.
        lines.length = 0;
        process.exitCode = undefined;
        await runCommand({ resume: parent.runId, maxTasks: 1 });
        assert.equal(process.exitCode, 1);
        assert.ok(lines.join("\n").includes("menor que el budget"));
      } finally {
        console.error = original;
      }
    });
  });

  it("U11: residuo no atribuible a ninguna tarea del padre rechaza sin borrar nada", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      git(fixture.cwd, "branch", `slad/${fixture.sessionId}/T9`, fixture.baseRef);

      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await runCommand({ resume: parent.runId });
      } finally {
        console.error = original;
      }

      assert.equal(process.exitCode, 1);
      assert.ok(lines.join("\n").includes(`git branch -D slad/${fixture.sessionId}/T9`));
      assert.equal(branchExists(fixture.cwd, `slad/${fixture.sessionId}/T9`), true, "nada se borró");
      assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
    });
  });

  it("rechaza cuando el worktree principal se movió desde el run", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      fs.writeFileSync(path.join(fixture.cwd, "other.txt"), "x\n");
      git(fixture.cwd, "add", "-A");
      git(fixture.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "user moved main");

      await runCommand({ resume: parent.runId });

      assert.equal(process.exitCode, 1);
      assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
    });
  });

  it("--resume no se combina con flags de ejecución", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      await runCommand({ resume: parent.runId, bypass: true });
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
      await runCommand({ resume: parent.runId, parallel: true });
      assert.equal(process.exitCode, 1);
    });
  });
});

describe("U3 — el guard de workers protege resume, apply y abort", () => {
  it("un worker vivo bloquea los tres comandos, sigue vivo y la rama no se mueve", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
      try {
        writeWorkerSentinel(fixture.cwd, fixture.sessionId, {
          runId: parent.runId, taskId: "T2", pid: child.pid!, mode: "child",
        });

        for (const action of [
          () => runCommand({ resume: parent.runId }),
          () => applyRunAction(parent.runId, fixture.cwd),
          () => abortRunAction(parent.runId, fixture.cwd),
        ]) {
          process.exitCode = undefined;
          await action();
          assert.equal(process.exitCode, 1);
        }

        // The assertion that proves no signal was sent.
        assert.equal(child.exitCode, null, "el worker vivo sigue vivo");
        assert.equal(child.killed, false);
        assert.equal(git(fixture.cwd, "rev-parse", parent.branch), parent.tip);
        assert.equal(git(fixture.cwd, "diff", "--cached", "--name-only"), "");
        assert.equal((await readRunManifest(parent.manifestPath)).value.status, "interrupted");
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  it("un pid inexistente clasifica dead, se borra el sentinel y el comando procede", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      writeWorkerSentinel(fixture.cwd, fixture.sessionId, {
        runId: parent.runId, taskId: "T2", pid: 2 ** 22, mode: "child",
      });

      await applyRunAction(parent.runId, fixture.cwd);

      assert.equal(process.exitCode, undefined);
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "applied");
      assert.deepEqual(git(fixture.cwd, "diff", "--cached", "--name-only").split("\n"), ["src/sum.ts"]);
    });
  });

  it("un sentinel de otro host bloquea, y --assume-workers-dead lo destraba sin señalizar", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture);
      writeWorkerSentinel(fixture.cwd, fixture.sessionId, {
        runId: parent.runId, taskId: "T2", pid: 4711, mode: "child", host: "otra-maquina",
      });

      await abortRunAction(parent.runId, fixture.cwd);
      assert.equal(process.exitCode, 1);
      assert.equal(branchExists(fixture.cwd, parent.branch), true);

      process.exitCode = undefined;
      await abortRunAction(parent.runId, fixture.cwd, { assumeWorkersDead: true });

      assert.equal(process.exitCode, undefined);
      assert.equal(branchExists(fixture.cwd, parent.branch), false);
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "aborted");
    });
  });

  it("--apply y --abort aceptan un run interrupted, no solo review_pending", async () => {
    await withFixture(async (fixture) => {
      const parent = await interruptedParent(fixture, { recovery: { safe: false, reason: "uncaught" } });

      await applyRunAction(parent.runId, fixture.cwd);

      assert.equal(process.exitCode, undefined, "clase B sigue siendo aplicable cuando los tips coinciden");
      assert.equal((await readRunManifest(parent.manifestPath)).value.status, "applied");
    });
  });
});
