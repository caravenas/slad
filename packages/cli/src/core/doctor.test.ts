import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runDoctor, type RunDoctorOptions } from "./doctor.js";

type ExecCall = { file: string; args: string[]; timeoutMs: number };

type ExecBehavior =
  | { kind: "ok"; stdout?: string; stderr?: string }
  | { kind: "error"; message: string }
  | { kind: "timeout"; message?: string };

let tmpDir = "";

function makeExecutable(name: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: tmpDir,
    HOME: tmpDir,
    ...extra,
  };
}

function makeExec(behaviors: Record<string, ExecBehavior> = {}): { exec: NonNullable<RunDoctorOptions["exec"]>; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (file, args, opts) => {
      calls.push({ file, args, timeoutMs: opts.timeoutMs });
      const behavior = behaviors[[file, ...args].join(" ")] ?? behaviors[["*", ...args].join(" ")] ?? { kind: "ok", stdout: "" };
      if (behavior.kind === "timeout") {
        const error = new Error(behavior.message ?? "command timed out") as Error & { code: string; killed: boolean };
        error.code = "ETIMEDOUT";
        error.killed = true;
        throw error;
      }
      if (behavior.kind === "error") throw new Error(behavior.message);
      return { stdout: behavior.stdout ?? "", stderr: behavior.stderr ?? "" };
    },
  };
}

function healthyGitAndTmux(): Record<string, ExecBehavior> {
  return {
    "git rev-parse --verify HEAD": { kind: "ok", stdout: "0123456789abcdef\n" },
    "git status --porcelain=v1": { kind: "ok", stdout: "" },
    "git worktree list --porcelain": { kind: "ok", stdout: `worktree ${tmpDir}\nHEAD 0123456789abcdef\nbranch refs/heads/main\n` },
    "tmux -V": { kind: "ok", stdout: "tmux 3.4\n" },
  };
}

function makeValidManifest(runId: string, status = "completed"): void {
  const manifestDir = path.join(tmpDir, ".slad-os", "runs", runId);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    runId,
    traceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "s1",
    intent: "test",
    command: "run",
    status,
    backend: { provider: "cli" },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), "utf8");
}

function makeHealthyWorkspace(): void {
  for (const backend of ["codex", "claude", "pi", "agy"]) makeExecutable(backend);
  fs.mkdirSync(path.join(tmpDir, ".slad-os"), { recursive: true });
  makeValidManifest("run1");
}

describe("runDoctor", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-doctor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("devuelve healthy cuando todos los checks pasan", async () => {
    makeHealthyWorkspace();
    const { exec, calls } = makeExec(healthyGitAndTmux());

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec, timeoutMs: 123 });

    assert.equal(report.status, "healthy");
    assert.equal(report.summary.blockers, 0);
    assert.equal(report.summary.warnings, 0);
    assert.ok(report.checks.every((check) => check.status === "healthy"));
    assert.ok(calls.length >= 4);
    assert.ok(calls.every((call) => call.timeoutMs === 123));
  });

  it("agrega warning cuando hay advertencias sin blockers", async () => {
    makeHealthyWorkspace();
    const { exec } = makeExec({
      ...healthyGitAndTmux(),
      "git status --porcelain=v1": { kind: "ok", stdout: " M package.json\n" },
    });

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec });

    assert.equal(report.status, "warning");
    assert.equal(report.summary.blockers, 0);
    assert.ok(report.summary.warnings > 0);
    assert.ok(report.checks.some((check) => check.name === "git:status" && check.status === "warning"));
  });

  it("agrega blocked cuando un check bloqueante falla", async () => {
    makeHealthyWorkspace();
    const { exec } = makeExec({
      ...healthyGitAndTmux(),
      "git rev-parse --verify HEAD": { kind: "error", message: "fatal: not a git repository" },
    });

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec });

    assert.equal(report.status, "blocked");
    assert.ok(report.summary.blockers > 0);
    assert.ok(report.checks.some((check) => check.name === "git:head" && check.status === "blocked"));
  });

  it("reporta timeout de comando sin colgar el diagnóstico", async () => {
    makeHealthyWorkspace();
    const { exec } = makeExec({
      ...healthyGitAndTmux(),
      "git status --porcelain=v1": { kind: "timeout", message: "git status timed out" },
    });

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec, timeoutMs: 7 });

    assert.equal(report.status, "blocked");
    assert.ok(report.checks.some((check) => check.name === "git:status" && check.status === "blocked"));
  });

  it("clasifica el backend seleccionado ausente como blocker", async () => {
    for (const backend of ["codex", "claude", "agy"]) makeExecutable(backend);
    fs.mkdirSync(path.join(tmpDir, ".slad-os"), { recursive: true });
    makeValidManifest("run1");
    const { exec } = makeExec(healthyGitAndTmux());

    const report = await runDoctor({ cwd: tmpDir, env: env({ SLAD_DEFAULT_AGENT: "pi" }), exec });

    assert.equal(report.status, "blocked");
    assert.ok(report.checks.some((check) => check.name === "backend:pi:binary" && check.status === "blocked"));
  });

  it("clasifica backends no seleccionados ausentes como warning", async () => {
    makeExecutable("codex");
    fs.mkdirSync(path.join(tmpDir, ".slad-os"), { recursive: true });
    makeValidManifest("run1");
    const { exec } = makeExec(healthyGitAndTmux());

    const report = await runDoctor({ cwd: tmpDir, env: env({ SLAD_DEFAULT_AGENT: "codex" }), exec });

    assert.equal(report.status, "warning");
    assert.equal(report.summary.blockers, 0);
    assert.ok(report.checks.some((check) => check.name === "backend:claude:binary" && check.status === "warning"));
    assert.ok(report.checks.some((check) => check.name === "backend:pi:binary" && check.status === "warning"));
    assert.ok(report.checks.some((check) => check.name === "backend:agy:binary" && check.status === "warning"));
  });

  it("consulta versiones con timeout corto y degrada fallos sin bloquear", async () => {
    makeHealthyWorkspace();
    const { exec, calls } = makeExec({
      ...healthyGitAndTmux(),
      [`${path.join(tmpDir, "pi")} --version`]: { kind: "timeout", message: "pi version timed out" },
    });

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec, timeoutMs: 2_000 });

    assert.equal(report.status, "healthy");
    const piBinary = report.checks.find((check) => check.name === "backend:pi:binary");
    assert.equal(piBinary?.status, "healthy");
    assert.ok(piBinary?.evidence?.some((item) => item.includes("version:timeout")));
    assert.equal(calls.find((call) => call.file === path.join(tmpDir, "pi") && call.args.join(" ") === "--version")?.timeoutMs, 800);
  });

  it("reporta manifests válidos, activos, interrumpidos y corruptos en modo read-only", async () => {
    makeHealthyWorkspace();
    makeValidManifest("active-run", "running");
    makeValidManifest("interrupted-run", "interrupted");
    const corruptDir = path.join(tmpDir, ".slad-os", "runs", "bad-run");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "manifest.json"), "{ not json", "utf8");
    const { exec } = makeExec(healthyGitAndTmux());

    const report = await runDoctor({ cwd: tmpDir, env: env(), exec, recentManifestLimit: 10 });

    assert.equal(report.status, "warning");
    const manifests = report.checks.find((check) => check.name === "manifests:recent");
    assert.equal(manifests?.status, "warning");
    assert.match(manifests?.message ?? "", /válido\(s\).*activo\(s\).*interrumpido\(s\).*corrupto\(s\)\/ilegible\(s\)/);
    assert.ok(manifests?.evidence?.includes("valid:3"));
    assert.ok(manifests?.evidence?.includes("active:1"));
    assert.ok(manifests?.evidence?.includes("interrupted:1"));
    assert.ok(manifests?.evidence?.includes("corrupt:1"));
  });
});
