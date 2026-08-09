import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DoctorReport, type DoctorReport as DoctorReportValue } from "@slad/shared";
import { doctorCommand } from "./doctor.js";

function makeWriter(): { write(s: string): void; value(): string } {
  let buf = "";
  return {
    write(s: string) { buf += s; },
    value() { return buf; },
  };
}

async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-doctor-unit-"));
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function report(status: DoctorReportValue["status"]): DoctorReportValue {
  const checks = status === "healthy"
    ? [{ name: "git:head", status: "healthy" as const, message: "HEAD OK", blocking: false, evidence: ["abc123"] }]
    : status === "warning"
      ? [{ name: "tmux", status: "warning" as const, message: "tmux missing", blocking: false, recommendation: "Install tmux" }]
      : [{ name: "git:head", status: "blocked" as const, message: "No HEAD", blocking: true, evidence: ["fatal"], recommendation: "Create a commit" }];

  return DoctorReport.parse({
    status,
    summary: {
      passed: checks.filter((check) => check.status === "healthy").length,
      warnings: checks.filter((check) => check.status === "warning").length,
      blockers: checks.filter((check) => check.status === "blocked").length,
    },
    checks,
  });
}

test("doctor --json prints parseable DoctorReport and exits 0 for warnings", async () => {
  const stdout = makeWriter();
  const stderr = makeWriter();
  let exitCode: number | undefined;

  await doctorCommand(
    { json: true },
    { stdout, stderr, run: async () => report("warning"), setExitCode: (code) => { exitCode = code; } },
  );

  assert.equal(stderr.value(), "");
  assert.equal(exitCode, 0);
  const parsed = DoctorReport.parse(JSON.parse(stdout.value()));
  assert.equal(parsed.status, "warning");
});

test("doctor prints stable human output with status, summary, checks, evidence, and recommendations", async () => {
  const stdout = makeWriter();
  let exitCode: number | undefined;

  await doctorCommand(
    {},
    { stdout, run: async () => report("blocked"), setExitCode: (code) => { exitCode = code; } },
  );

  const output = stdout.value();
  assert.equal(exitCode, 2);
  assert.match(output, /SLAD doctor/);
  assert.match(output, /Status: blocked/);
  assert.match(output, /Summary: passed=0 warnings=0 blockers=1/);
  assert.match(output, /- \[blocked\] git:head: No HEAD/);
  assert.match(output, /Evidence:/);
  assert.match(output, /- fatal/);
  assert.match(output, /Recommendation: Create a commit/);
});

test("doctor reports internal errors with non-zero exit code", async () => {
  const stdout = makeWriter();
  const stderr = makeWriter();
  let exitCode: number | undefined;

  await doctorCommand(
    {},
    { stdout, stderr, run: async () => { throw new Error("boom"); }, setExitCode: (code) => { exitCode = code; } },
  );

  assert.equal(stdout.value(), "");
  assert.equal(exitCode, 1);
  assert.match(stderr.value(), /doctor error: boom/);
});

test("doctor --json leaves stdout empty for internal errors", async () => {
  const stdout = makeWriter();
  const stderr = makeWriter();
  let exitCode: number | undefined;

  await doctorCommand(
    { json: true },
    { stdout, stderr, run: async () => { throw new Error("boom"); }, setExitCode: (code) => { exitCode = code; } },
  );

  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "");
  assert.equal(exitCode, 1);
});

test("doctor with injected run does not bootstrap persisted config", async () => {
  await withTempCwd(async (dir) => {
    fs.mkdirSync(path.join(dir, ".slad-os"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".slad-os", "config.json"), JSON.stringify({
      providers: { defaultAgent: "not-a-backend" },
    }), "utf8");

    const stdout = makeWriter();
    const stderr = makeWriter();
    let exitCode: number | undefined;

    await doctorCommand(
      { json: true },
      { stdout, stderr, run: async () => report("healthy"), setExitCode: (code) => { exitCode = code; } },
    );

    assert.equal(stderr.value(), "");
    assert.equal(exitCode, 0);
    assert.equal(DoctorReport.parse(JSON.parse(stdout.value())).status, "healthy");
  });
});

test("doctor --json leaves stdout empty when report validation fails", async () => {
  const stdout = makeWriter();
  const stderr = makeWriter();
  let exitCode: number | undefined;

  await doctorCommand(
    { json: true },
    { stdout, stderr, run: async () => ({ status: "blocked" }) as DoctorReportValue, setExitCode: (code) => { exitCode = code; } },
  );

  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "");
  assert.equal(exitCode, 1);
});
