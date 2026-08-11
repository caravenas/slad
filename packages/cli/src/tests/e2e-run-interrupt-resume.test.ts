/**
 * E2E: real SIGINT during `run --parallel --worktrees`, then `--resume`.
 *
 * Everything here uses real processes, a real git repo and a real signal:
 * the point is to prove the class-A contract end to end (exit 130, no orphan
 * workers, an exact manifest, an untouched main worktree, a released lock),
 * that a fresh run then refuses instead of deleting the work (A2), and that
 * the resume merges each task exactly once.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createSession } from "../core/session.js";
import { resetDocsRootCache } from "../persistence/layout.js";
import { planCommand } from "../commands/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "run-interrupt-child.ts");
const TSX_LOADER = import.meta.resolve("tsx/esm");
const INTENT = "escribir tres archivos en dos olas";

const EXTERNAL_PLAN = {
  kind: "slad.external-plan",
  schemaVersion: 1,
  intent: INTENT,
  snapshot: { status: "completed", content: "# Snapshot\n\nTres archivos." },
  plan: {
    status: "completed",
    snapshot: "Tres archivos.",
    summary: "T1 primero; T2 y T3 dependen de T1.",
    tasks: [
      {
        id: "T1", title: "Escribir a.txt", description: "Crear a.txt", type: "implementation",
        priority: "high", dependsOn: [], files: ["a.txt"], acceptanceCriteria: ["a.txt existe"],
      },
      {
        id: "T2", title: "Escribir b.txt", description: "Crear b.txt", type: "implementation",
        priority: "medium", dependsOn: ["T1"], files: ["b.txt"], acceptanceCriteria: ["b.txt existe"],
      },
      {
        id: "T3", title: "Escribir c.txt", description: "Crear c.txt", type: "implementation",
        priority: "medium", dependsOn: ["T1"], files: ["c.txt"], acceptanceCriteria: ["c.txt existe"],
      },
    ],
    recommendedFirstTask: "T1",
  },
};

/**
 * Fake agent CLI. Reads the handoff prompt on stdin, extracts its task id,
 * writes its declared file and prints a valid RunOutput. Wave-2 tasks sleep
 * during the first run so the test can interrupt them mid-flight.
 */
const FAKE_AGENT = `#!/bin/sh
PROMPT=$(cat)
TASK=$(printf '%s' "$PROMPT" | sed -n 's/.*"taskId": "\\(T[0-9]*\\)".*/\\1/p' | tail -1)
case "$TASK" in
  T1) FILE=a.txt ;;
  T2) FILE=b.txt ;;
  T3) FILE=c.txt ;;
  *) echo "unknown task: $TASK" >&2; exit 1 ;;
esac
if [ -n "$SLAD_FIXTURE_SLOW" ] && [ "$TASK" != "T1" ]; then
  sleep 120
fi
printf '%s wrote %s\\n' "$TASK" "$FILE" > "$FILE"
printf '{"taskId":"%s","status":"completed","summary":"%s ok","changedFiles":["%s"],"verification":[],"reviewerNotes":[],"followUps":[],"assumptions":[],"decisions":[],"questions":[],"humanAnswers":{}}\\n' "$TASK" "$TASK" "$FILE"
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function readManifest(cwd: string, runId: string): Record<string, any> | null {
  const manifestPath = path.join(cwd, ".slad-os", "runs", runId, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function latestRunId(cwd: string, exclude: Set<string> = new Set()): string | null {
  const runsDir = path.join(cwd, ".slad-os", "runs");
  try {
    const ids = fs.readdirSync(runsDir).filter((id) => !exclude.has(id));
    if (ids.length === 0) return null;
    return ids
      .map((id) => ({ id, manifest: readManifest(cwd, id) }))
      .filter((entry) => entry.manifest !== null)
      .sort((a, b) => String(b.manifest!.startedAt).localeCompare(String(a.manifest!.startedAt)))[0]?.id ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function until<T>(
  label: string,
  probe: () => T | null | undefined | false,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function spawnChild(cwd: string, env: Record<string, string>): ChildProcess {
  const { TMUX: _tmux, ...clean } = process.env;
  return spawn(process.execPath, ["--import", TSX_LOADER, CHILD], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...clean,
      SLAD_FIXTURE_DIR: cwd,
      SLAD_DOCS_PATH: path.join(cwd, "docs"),
      SLAD_CLI_BINARY: path.join(cwd, "fake-agent.sh"),
      SLAD_CLI_ARGS: "",
      SLAD_CLI_PROMPT_MODE: "stdin",
      ...env,
    },
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

async function withFixture(fn: (cwd: string, sessionId: string, baseRef: string) => Promise<void>): Promise<void> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slad-e2e-sigint-")));
  const originalCwd = process.cwd();
  const originalDocs = process.env.SLAD_DOCS_PATH;
  const originalExitCode = process.exitCode;
  try {
    process.chdir(cwd);
    process.env.SLAD_DOCS_PATH = path.join(cwd, "docs");
    process.exitCode = undefined;
    resetDocsRootCache();

    git(cwd, "init", "-q");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Fixture\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\ndocs/\nplan.json\nfake-agent.sh\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const baseRef = git(cwd, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(cwd, "fake-agent.sh"), FAKE_AGENT, { mode: 0o755 });
    const session = createSession(INTENT);
    fs.writeFileSync(path.join(cwd, "plan.json"), JSON.stringify(EXTERNAL_PLAN), "utf8");
    await planCommand({ import: path.join(cwd, "plan.json") });
    await planCommand({ approve: true });
    process.exitCode = undefined;

    await fn(cwd, session.id, baseRef);
  } finally {
    resetDocsRootCache();
    process.exitCode = originalExitCode;
    if (originalDocs === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocs;
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("E2E: SIGINT real durante run --parallel --worktrees, y --resume", { concurrency: 1 }, () => {
  it("interrumpe en clase A, rechaza un run fresco sin borrar nada, y reanuda exactamente una vez", async () => {
    await withFixture(async (cwd, sessionId, baseRef) => {
      const branch = `slad/${sessionId}/integration`;
      const lockPath = path.join(cwd, ".slad-os", "sessions", sessionId, "run.lock");

      // ── 1. Run that will be interrupted during wave 2 ──────────────────
      const first = spawnChild(cwd, { SLAD_FIXTURE_SLOW: "1" });
      const firstExit = waitForExit(first);

      const parentRunId = await until("el manifest del run padre", () => latestRunId(cwd));
      // Wave 1 merged: the integration tip moved off the chain base.
      await until("el merge de la ola 1", () => {
        const manifest = readManifest(cwd, parentRunId);
        return manifest?.worktrees?.integration?.tip !== undefined &&
          manifest.worktrees.integration.tip !== baseRef;
      });
      // Wave 2 workers are up and sleeping.
      const waveTwoPids = await until("los sentinels de la ola 2", () => {
        const pids = ["T2", "T3"].map((taskId) => {
          const sentinelPath = path.join(cwd, ".slad-os", "sessions", sessionId, "tasks", taskId, "worker.json");
          try {
            return (JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as { pid: number }).pid;
          } catch {
            return null;
          }
        });
        return pids.every((pid) => typeof pid === "number") ? (pids as number[]) : null;
      });
      assert.equal(waveTwoPids.length, 2);

      // ── 2. A real SIGINT ───────────────────────────────────────────────
      first.kill("SIGINT");
      const { code, output } = await firstExit;

      assert.equal(code, 130, `el run interrumpido sale 130\n${output}`);

      // No orphan workers: every sentinel pid is gone.
      await until("que los workers mueran", () => waveTwoPids.every((pid) => !pidAlive(pid)), 15_000);

      // The manifest is exact and marked class A.
      const parent = readManifest(cwd, parentRunId)!;
      assert.equal(parent.status, "interrupted");
      assert.deepEqual(parent.recovery, { safe: true, reason: "signal", signal: "SIGINT" });
      assert.equal(parent.worktrees.integration.tip, git(cwd, "rev-parse", branch), "I0 end-to-end");
      assert.equal(parent.worktrees.integration.baseRef, baseRef);
      assert.equal(parent.tasks.find((task: any) => task.taskId === "T1").status, "completed");
      assert.equal(parent.policy.strictOwnership, true);
      assert.equal(parent.policy.taskDispatches, 3, "T1 más los dos workers de la ola 2");

      // The main worktree is untouched and the lock is released.
      assert.equal(git(cwd, "rev-parse", "HEAD"), baseRef);
      assert.equal(git(cwd, "status", "--porcelain"), "");
      assert.ok(!fs.existsSync(path.join(cwd, "a.txt")));
      assert.equal(fs.existsSync(lockPath), false, "run.lock liberado");

      // ── 3. A fresh run must refuse, and delete nothing (A2 / B2) ───────
      const refsBefore = git(cwd, "for-each-ref", `refs/heads/slad/${sessionId}/`, "--format=%(refname)").split("\n").sort();
      const worktreesBefore = git(cwd, "worktree", "list", "--porcelain");
      const fresh = spawnChild(cwd, {});
      const freshResult = await waitForExit(fresh);

      assert.notEqual(freshResult.code, 0, `un run fresco sobre residuo debe fallar\n${freshResult.output}`);
      assert.ok(freshResult.output.includes("residuo"), freshResult.output);
      assert.deepEqual(
        git(cwd, "for-each-ref", `refs/heads/slad/${sessionId}/`, "--format=%(refname)").split("\n").sort(),
        refsBefore,
        "ninguna ref de la sesión fue borrada",
      );
      assert.equal(git(cwd, "worktree", "list", "--porcelain"), worktreesBefore, "ningún worktree fue borrado");
      assert.equal(git(cwd, "rev-parse", branch), parent.worktrees.integration.tip);

      // ── 4. Resume: exactly-once across the chain ───────────────────────
      const known = new Set(fs.readdirSync(path.join(cwd, ".slad-os", "runs")));
      const resume = spawnChild(cwd, { SLAD_FIXTURE_RESUME: parentRunId });
      const resumeResult = await waitForExit(resume);
      assert.equal(resumeResult.code, 0, `el resume debe terminar limpio\n${resumeResult.output}`);

      const childRunId = latestRunId(cwd, known)!;
      const child = readManifest(cwd, childRunId)!;
      assert.equal(child.status, "review_pending");
      assert.equal(child.worktrees.integration.fromRun, parentRunId);
      assert.equal(child.policy.strictOwnership, true, "la política se hereda");
      assert.equal(child.policy.taskDispatches, 5, "3 del padre + T2 y T3 relanzados");
      assert.ok(child.tasks.every((task: any) => task.status === "completed"));

      // a.txt was merged by the parent and must not be re-merged: exactly one
      // commit touches it in the whole chain.
      const aCommits = git(cwd, "log", "--oneline", "--follow", `${baseRef}..${branch}`, "--", "a.txt")
        .split("\n").filter(Boolean);
      assert.equal(aCommits.length, 1, `a.txt se mergeó exactamente una vez:\n${aCommits.join("\n")}`);
      assert.equal(git(cwd, "show", `${branch}:a.txt`), "T1 wrote a.txt", "el contenido original se conserva");

      // ── 5. Apply: every file staged exactly once, no duplicates ────────
      const { applyRunAction } = await import("../commands/run.js");
      process.exitCode = undefined;
      await applyRunAction(childRunId, cwd);
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(
        git(cwd, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort(),
        ["a.txt", "b.txt", "c.txt"],
      );
      assert.equal(git(cwd, "rev-parse", "HEAD"), baseRef, "el apply no commitea");
      assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "T1 wrote a.txt\n");
    });
  });

  it("de dos --resume concurrentes procede exactamente uno", async () => {
    await withFixture(async (cwd, sessionId, baseRef) => {
      const branch = `slad/${sessionId}/integration`;

      // Interrupt a run to get a resumable parent.
      const first = spawnChild(cwd, { SLAD_FIXTURE_SLOW: "1" });
      const firstExit = waitForExit(first);
      const parentRunId = await until("el manifest del run padre", () => latestRunId(cwd));
      await until("el merge de la ola 1", () => {
        const manifest = readManifest(cwd, parentRunId);
        return manifest?.worktrees?.integration?.tip !== undefined &&
          manifest.worktrees.integration.tip !== baseRef;
      });
      first.kill("SIGINT");
      assert.equal((await firstExit).code, 130);

      // Two real resumes at the same time.
      const known = new Set(fs.readdirSync(path.join(cwd, ".slad-os", "runs")));
      const a = spawnChild(cwd, { SLAD_FIXTURE_RESUME: parentRunId });
      const b = spawnChild(cwd, { SLAD_FIXTURE_RESUME: parentRunId });
      const [resultA, resultB] = await Promise.all([waitForExit(a), waitForExit(b)]);

      const codes = [resultA.code, resultB.code];
      const winners = codes.filter((code) => code === 0);
      assert.equal(winners.length, 1, `exactamente uno procede; códigos: ${codes.join(", ")}`);
      const loser = resultA.code === 0 ? resultB : resultA;
      assert.ok(
        loser.output.includes("tomada por") || loser.output.includes("mismo instante"),
        `el perdedor nombra al tenedor del lock:\n${loser.output}`,
      );

      // The winner's work is intact and applies exactly once.
      const childRunId = latestRunId(cwd, known)!;
      assert.equal(readManifest(cwd, childRunId)!.status, "review_pending");
      const aCommits = git(cwd, "log", "--oneline", `${baseRef}..${branch}`, "--", "a.txt")
        .split("\n").filter(Boolean);
      assert.equal(aCommits.length, 1);
    });
  });
});
