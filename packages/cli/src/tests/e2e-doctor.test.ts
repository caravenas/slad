import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DoctorReport } from "@slad/shared";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));
const TSX_LOADER = import.meta.resolve("tsx/esm");

type Fixture = { projectDir: string; binDir: string };
type FixtureOptions = { missingBinaries?: string[]; realGit?: boolean };

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-doctor-e2e-project-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-doctor-e2e-bin-"));
  fs.mkdirSync(path.join(projectDir, ".slad-os"), { recursive: true });

  const missing = new Set(options.missingBinaries ?? []);
  for (const binary of ["codex", "claude", "pi", "agy"]) {
    if (!missing.has(binary)) writeExecutable(path.join(binDir, binary), "#!/bin/sh\nexit 0\n");
  }

  writeExecutable(path.join(binDir, "tmux"), "#!/bin/sh\necho 'tmux 3.4'\n");
  if (options.realGit) {
    const realGit = execFileSync("/bin/sh", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    fs.symlinkSync(realGit, path.join(binDir, "git"));
  } else {
    writeExecutable(path.join(binDir, "git"), `#!/bin/sh
case "$*" in
  "rev-parse --verify HEAD") echo "0123456789abcdef0123456789abcdef01234567" ; exit 0 ;;
  "status --porcelain=v1") exit 0 ;;
  "worktree list --porcelain") echo "worktree ${projectDir}" ; echo "HEAD 0123456789abcdef0123456789abcdef01234567" ; exit 0 ;;
  *) echo "unexpected git args: $*" >&2 ; exit 1 ;;
esac
`);
  }

  return { projectDir, binDir };
}

function cliEnv(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: fixture.binDir,
    HOME: fixture.projectDir,
    SLAD_DOCS_PATH: path.join(fixture.projectDir, "docs"),
  };
  for (const key of [
    "CLI_MODEL",
    "SLAD_MODEL",
    "SLAD_DEFAULT_AGENT",
    "SLAD_DEFAULT_PROVIDER",
    "SLAD_CLI_BINARY",
    "SLAD_CLI_ARGS",
    "SLAD_CLI_PROMPT_MODE",
    "SLAD_CLI_MODEL_ARG",
    "SLAD_WORKSPACE",
    "SLAD_WIKI_PATH",
  ]) {
    delete env[key];
  }
  return { ...env, ...extraEnv };
}

async function runCli(args: string[], fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    cwd: fixture.projectDir,
    env: cliEnv(fixture, extraEnv),
    timeout: 30_000,
  });
}

async function runCliWithExit(args: string[], fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
      cwd: fixture.projectDir,
      env: cliEnv(fixture, extraEnv),
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitFixture(): Fixture {
  const fixture = makeFixture({ realGit: true });
  git(["init"], fixture.projectDir);
  git(["config", "user.email", "slad@example.test"], fixture.projectDir);
  git(["config", "user.name", "SLAD Test"], fixture.projectDir);
  fs.writeFileSync(path.join(fixture.projectDir, "README.md"), "fixture\n", "utf8");
  git(["add", "README.md"], fixture.projectDir);
  git(["commit", "-m", "fixture"], fixture.projectDir);
  assert.equal(git(["status", "--porcelain=v1"], fixture.projectDir), "");
  return fixture;
}

function listFixtureFiles(projectDir: string): string[] {
  const entries: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectDir, fullPath);
      entries.push(relativePath);
      if (entry.isDirectory()) walk(fullPath);
    }
  }
  walk(projectDir);
  return entries.sort();
}

describe("E2E: slad doctor", { concurrency: 1 }, () => {
  it("prints DoctorReport JSON without invoking agent CLIs or real git/tmux/PATH", async () => {
    const fixture = makeFixture();
    try {
      const { stdout, stderr } = await runCli(["doctor", "--json"], fixture);

      assert.equal(stderr, "");
      const parsed = DoctorReport.parse(JSON.parse(stdout));
      assert.equal(parsed.status, "healthy");
      assert.ok(parsed.checks.some((check) => check.name === "git:head"));
      assert.ok(parsed.checks.some((check) => check.name === "tmux"));
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
      fs.rmSync(fixture.binDir, { recursive: true, force: true });
    }
  });

  it("prints human-readable output for the top-level doctor command", async () => {
    const fixture = makeFixture();
    try {
      const { stdout, stderr } = await runCli(["doctor"], fixture);

      assert.equal(stderr, "");
      assert.match(stdout, /SLAD doctor/);
      assert.match(stdout, /Status: healthy/);
      assert.match(stdout, /Summary: passed=\d+ warnings=0 blockers=0/);
      assert.match(stdout, /Checks:/);
      assert.match(stdout, /Evidence:/);
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
      fs.rmSync(fixture.binDir, { recursive: true, force: true });
    }
  });

  it("reports a missing selected backend binary as a JSON blocker", async () => {
    const fixture = makeFixture({ missingBinaries: ["pi"] });
    try {
      const missingPi = path.join(fixture.projectDir, "missing-pi");
      const { stdout, stderr, code } = await runCliWithExit(["doctor", "--json"], fixture, { SLAD_DEFAULT_AGENT: "pi", SLAD_CLI_BINARY: missingPi });

      assert.equal(stderr, "");
      assert.equal(code, 2);
      const parsed = DoctorReport.parse(JSON.parse(stdout));
      assert.equal(parsed.status, "blocked");
      const check = parsed.checks.find((item) => item.name === "backend:pi:binary");
      assert.equal(check?.status, "blocked");
      assert.equal(check?.blocking, true);
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
      fs.rmSync(fixture.binDir, { recursive: true, force: true });
    }
  });

  it("bootstraps selected backend from persisted config before JSON doctor", async () => {
    const fixture = makeFixture({ missingBinaries: ["pi"] });
    try {
      fs.writeFileSync(path.join(fixture.projectDir, ".slad-os", "config.json"), JSON.stringify({
        providers: {
          defaultProvider: "cli",
          defaultAgent: "pi",
          models: { cli: "openai-codex/gpt-5.5" },
          agentModels: { pi: "openai-codex/gpt-5.5" },
        },
      }, null, 2), "utf8");

      const { stdout, stderr, code } = await runCliWithExit(["doctor", "--json"], fixture);

      assert.equal(stderr, "");
      assert.equal(code, 2);
      const parsed = DoctorReport.parse(JSON.parse(stdout));
      assert.equal(parsed.status, "blocked");
      const check = parsed.checks.find((item) => item.name === "backend:pi:binary");
      assert.equal(check?.status, "blocked");
      assert.equal(check?.blocking, true);
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
      fs.rmSync(fixture.binDir, { recursive: true, force: true });
    }
  });

  it("does not modify the fixture files or git working tree", async () => {
    const fixture = makeGitFixture();
    try {
      const filesBefore = listFixtureFiles(fixture.projectDir);
      const statusBefore = git(["status", "--porcelain=v1"], fixture.projectDir);

      const { stderr } = await runCli(["doctor"], fixture);

      assert.equal(stderr, "");
      assert.deepEqual(listFixtureFiles(fixture.projectDir), filesBefore);
      assert.equal(git(["status", "--porcelain=v1"], fixture.projectDir), statusBefore);
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
      fs.rmSync(fixture.binDir, { recursive: true, force: true });
    }
  });
});
