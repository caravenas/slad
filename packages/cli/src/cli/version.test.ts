import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

type PackageJson = {
  version?: unknown;
};

function repoRootFromTestFile(): string {
  const filePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filePath), "../..");
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const cwd = repoRootFromTestFile();
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function expectedVersionLine(): string {
  const cwd = repoRootFromTestFile();
  const raw = readFileSync(path.join(cwd, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as PackageJson;

  assert.equal(typeof parsed.version, "string", "package.json.version debe ser string para este test");
  return `slad ${parsed.version}\n`;
}

test("slad version y slad --version imprimen exactamente los mismos bytes", () => {
  const commandVersion = runCli(["version"]);
  const flagVersion = runCli(["--version"]);

  assert.equal(commandVersion.status, 0, `slad version falló: ${commandVersion.stderr}`);
  assert.equal(flagVersion.status, 0, `slad --version falló: ${flagVersion.stderr}`);
  assert.equal(commandVersion.stdout, flagVersion.stdout);
});

test("slad --version respeta formato exacto con newline final", () => {
  const output = runCli(["--version"]);

  assert.equal(output.status, 0, `slad --version falló: ${output.stderr}`);
  assert.match(output.stdout, /^slad \d+\.\d+\.\d+\n$/);
  assert.equal(output.stdout, expectedVersionLine());
});

test("error controlado para package.json inválido/sin versión (skip por path fijo del runtime)", { skip: "La CLI resuelve ../../package.json desde src/cli/version.ts; mutarlo en tests rompe aislamiento y requiere arnés/fixture de proceso." }, () => {
  // Cobertura pendiente deliberada: escenario de package.json inválido/sin version.
});
