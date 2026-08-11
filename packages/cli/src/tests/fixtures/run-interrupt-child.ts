/**
 * Child entry point for the real-SIGINT E2E (`e2e-run-interrupt-resume.test.ts`).
 *
 * The test spawns this with tsx so no build step is needed, sends a real
 * SIGINT to it, and asserts on the exit code and the state it left on disk.
 * It lives inside the package so `@slad/*` workspace imports resolve.
 */
import path from "node:path";
import { runCommand } from "../../commands/run.js";
import { resetDocsRootCache } from "../../persistence/layout.js";

const fixtureDir = process.env.SLAD_FIXTURE_DIR;
if (!fixtureDir) throw new Error("SLAD_FIXTURE_DIR is required");

process.chdir(fixtureDir);
process.env.SLAD_DOCS_PATH = path.join(fixtureDir, "docs");
resetDocsRootCache();

const resume = process.env.SLAD_FIXTURE_RESUME;
await runCommand(
  resume
    ? { resume, harness: "off" }
    : { parallel: true, worktrees: true, strictOwnership: true, maxParallel: 3, harness: "off" },
);

process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
