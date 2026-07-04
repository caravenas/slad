import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError } from "./errors.js";
import {
  getCliBackend,
  listBackendModels,
  listSupportedBackends,
  parseModelList,
  resolveBackendBinary,
  serializeBackendSelectionToConfigPatch,
  validateBackendSelection,
  type CommandRunner,
} from "./backend-registry.js";

let tmpDir = "";
let previousPath: string | undefined;
let previousHome: string | undefined;

function makeExecutableIn(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeNonExecutableIn(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o644);
  return filePath;
}

function makeExecutable(name: string): string {
  return makeExecutableIn(tmpDir, name);
}

describe("backend-registry", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-backends-"));
    previousPath = process.env.PATH;
    previousHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("modela Codex, Claude Code, Pi y Agy como backends CLI soportados", () => {
    const backends = Object.fromEntries(listSupportedBackends().map((backend) => [backend.id, backend]));

    assert.deepEqual(Object.keys(backends).sort(), ["agy", "claude", "codex", "pi"]);
    assert.deepEqual(backends.codex, {
      id: "codex",
      label: "Codex",
      defaultBinary: "codex",
      defaultArgs: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never"],
      promptMode: "stdin",
      modelArg: "--model",
      modelQueryCommands: [
        ["models", "--json"],
        ["models", "list", "--json"],
        ["models"],
        ["model", "list"],
      ],
    });
    assert.deepEqual(backends.claude, {
      id: "claude",
      label: "Claude Code",
      defaultBinary: "claude",
      defaultArgs: ["--print"],
      promptMode: "arg",
      modelArg: "--model",
      modelQueryCommands: [
        ["models", "--json"],
        ["models", "list", "--json"],
        ["models"],
        ["model", "list"],
      ],
    });
    assert.deepEqual(backends.pi, {
      id: "pi",
      label: "Pi",
      defaultBinary: "pi",
      defaultArgs: ["--print", "--no-session"],
      promptMode: "arg",
      modelArg: "--model",
      modelQueryCommands: [["--list-models"]],
    });
    assert.deepEqual(backends.agy, {
      id: "agy",
      label: "Agy",
      defaultBinary: "agy",
      defaultArgs: ["--print"],
      promptMode: "arg",
      modelArg: "--model",
      modelQueryCommands: [["models"]],
    });
    assert.equal(getCliBackend("codex").defaultBinary, "codex");
    assert.equal(getCliBackend("claude").defaultBinary, "claude");
    assert.equal(getCliBackend("pi").defaultBinary, "pi");
    assert.equal(getCliBackend("agy").defaultBinary, "agy");
  });

  it("parsea modelos desde respuestas JSON y texto plano", () => {
    assert.deepEqual(
      parseModelList(JSON.stringify({ models: [{ id: "gpt-5-codex" }, { name: "gpt-5-mini" }] })).map((m) => m.id),
      ["gpt-5-codex", "gpt-5-mini"],
    );
    assert.deepEqual(
      parseModelList("Available models:\n- sonnet\n- opus  latest\n").map((m) => m.id),
      ["opus", "sonnet"],
    );
  });

  it("parsea listas de nombres con espacios simples como las de agy models", () => {
    const list = [
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.1 Pro (High)",
      "Claude Sonnet 4.6 (Thinking)",
    ].join("\n");
    assert.deepEqual(
      parseModelList(list).map((m) => m.id),
      ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.1 Pro (High)", "Gemini 3.5 Flash (Medium)"],
    );
  });

  it("parsea tablas provider/model como las de pi --list-models", () => {
    const table = [
      "provider      model                       context  max-out",
      "anthropic     claude-fable-5              1M       128K",
      "google        gemini-3-flash-preview      1M       64K",
    ].join("\n");
    assert.deepEqual(
      parseModelList(table).map((m) => m.id),
      ["anthropic/claude-fable-5", "google/gemini-3-flash-preview"],
    );
  });

  it("resuelve primero desde PATH aunque exista un candidato nvm", () => {
    const pathBinary = makeExecutable("codex");
    makeExecutableIn(path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin"), "codex");
    process.env.PATH = tmpDir;

    const result = resolveBackendBinary("codex");

    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedPath, pathBinary);
  });

  it("usa fallback nvm cuando PATH no contiene el binario", () => {
    const nvmBin = path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin");
    const nvmBinary = makeExecutableIn(nvmBin, "claude");
    process.env.PATH = path.join(tmpDir, "empty-path");

    const result = resolveBackendBinary("claude");

    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedPath, nvmBinary);
  });

  it("resuelve múltiples versiones nvm de forma determinista usando la versión más alta", () => {
    const olderBinary = makeExecutableIn(path.join(tmpDir, ".nvm", "versions", "node", "v18.19.0", "bin"), "codex");
    const latestBinary = makeExecutableIn(path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin"), "codex");
    const middleBinary = makeExecutableIn(path.join(tmpDir, ".nvm", "versions", "node", "v20.11.1", "bin"), "codex");
    process.env.PATH = path.join(tmpDir, "empty-path");

    const results = Array.from({ length: 3 }, () => resolveBackendBinary("codex"));

    assert.deepEqual(
      results.map((result) => result.resolvedPath),
      [latestBinary, latestBinary, latestBinary],
    );
    assert.notEqual(results[0]?.resolvedPath, olderBinary);
    assert.notEqual(results[0]?.resolvedPath, middleBinary);
  });

  it("ignora candidatos nvm anidados o no ejecutables", () => {
    const nvmBin = path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin");
    const nvmBinary = makeExecutableIn(nvmBin, "claude");
    const nestedBin = path.join(tmpDir, ".nvm", "versions", "node", "nested", "child", "bin");
    makeExecutableIn(nestedBin, "claude");
    const notExecutableBin = path.join(tmpDir, ".nvm", "versions", "node", "v23.0.0", "bin");
    makeNonExecutableIn(notExecutableBin, "claude");
    process.env.PATH = path.join(tmpDir, "empty-path");

    const result = resolveBackendBinary("claude");

    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedPath, nvmBinary);
  });

  it("no usa un candidato nvm cuando existe pero no es ejecutable", () => {
    makeNonExecutableIn(path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin"), "codex");
    process.env.PATH = path.join(tmpDir, "empty-path");

    const result = resolveBackendBinary("codex");

    assert.equal(result.status, "missing");
    assert.equal(result.resolvedPath, undefined);
    assert.match(result.reason ?? "", /PATH ni en ~\/\.nvm\/versions\/node\/\*\/bin/);
  });

  it("conserva missing cuando ~/.nvm no existe o no contiene el binario", () => {
    process.env.PATH = path.join(tmpDir, "empty-path");

    const withoutNvm = resolveBackendBinary("codex");
    fs.mkdirSync(path.join(tmpDir, ".nvm", "versions", "node", "v22.0.0", "bin"), { recursive: true });
    const withoutBinary = resolveBackendBinary("codex");

    assert.equal(withoutNvm.status, "missing");
    assert.equal(withoutNvm.resolvedPath, undefined);
    assert.equal(withoutBinary.status, "missing");
    assert.equal(withoutBinary.resolvedPath, undefined);
  });

  it("valida provider, binary y model con consulta dinámica al binario", async () => {
    const codexPath = makeExecutable("codex");
    const runner: CommandRunner = async (file, args) => {
      assert.equal(file, codexPath);
      assert.deepEqual(args, ["models", "--json"]);
      return { stdout: JSON.stringify({ models: [{ id: "gpt-5-codex" }] }), stderr: "" };
    };

    const result = await validateBackendSelection(
      { provider: "codex", binary: codexPath, model: "gpt-5-codex" },
      { runner },
    );

    assert.equal(result.binary.resolvedPath, codexPath);
    assert.equal(result.modelList?.models[0]?.id, "gpt-5-codex");
    assert.deepEqual(result.configPatch, {
      providers: {
        defaultProvider: "cli",
        defaultAgent: "codex",
        models: { cli: "gpt-5-codex" },
        agentModels: { codex: "gpt-5-codex" },
        binaries: { codex: codexPath },
      },
    });
  });

  it("permite provider + model sin binary cuando no hay ejecutable válido", async () => {
    process.env.PATH = tmpDir;

    const result = await validateBackendSelection({ provider: "claude", model: "sonnet" });

    assert.equal(result.binary.status, "missing");
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(result.configPatch, {
      providers: {
        defaultProvider: "cli",
        defaultAgent: "claude",
        models: { cli: "sonnet" },
        agentModels: { claude: "sonnet" },
      },
    });
  });

  it("serializa provider + model sin binary cuando la consulta dinámica falla", async () => {
    const claudePath = makeExecutable("claude");
    const runner: CommandRunner = async () => {
      throw new Error("subcommand not found");
    };

    let failure: unknown;
    try {
      await listBackendModels("claude", { binary: claudePath, runner });
    } catch (err) {
      failure = err;
    }

    assert.ok(failure instanceof ConfigError);
    assert.equal("configPatch" in failure, false);
    assert.deepEqual((failure as ConfigError).context, {
      provider: "claude",
      binary: claudePath,
      attempts: [
        "models --json: subcommand not found",
        "models list --json: subcommand not found",
        "models: subcommand not found",
        "model list: subcommand not found",
      ],
    });
    assert.deepEqual(
      serializeBackendSelectionToConfigPatch({ provider: "claude", model: "sonnet" }),
      {
        providers: {
          defaultProvider: "cli",
          defaultAgent: "claude",
          models: { cli: "sonnet" },
          agentModels: { claude: "sonnet" },
        },
      },
    );
  });

  it("rechaza paths explícitos inexistentes o no ejecutables", async () => {
    await assert.rejects(
      () => validateBackendSelection({ provider: "codex", binary: path.join(tmpDir, "missing"), model: "gpt-5-codex" }),
      ConfigError,
    );

    const notExecutable = path.join(tmpDir, "codex-not-exec");
    fs.writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(notExecutable, 0o644);

    await assert.rejects(
      () => validateBackendSelection({ provider: "codex", binary: notExecutable, model: "gpt-5-codex" }),
      ConfigError,
    );
  });

  it("rechaza modelos no retornados por la consulta dinámica", async () => {
    const codexPath = makeExecutable("codex");
    const runner: CommandRunner = async () => ({
      stdout: JSON.stringify({ models: [{ id: "gpt-5-codex" }] }),
      stderr: "",
    });

    await assert.rejects(
      () => validateBackendSelection({ provider: "codex", binary: codexPath, model: "missing-model" }, { runner }),
      (err: unknown) => err instanceof ConfigError && err.message.includes("no está disponible"),
    );
  });

  it("expone error accionable cuando falla la consulta de modelos", async () => {
    const claudePath = makeExecutable("claude");
    const runner: CommandRunner = async () => {
      throw new Error("subcommand not found");
    };

    await assert.rejects(
      () => validateBackendSelection({ provider: "claude", binary: claudePath, model: "sonnet" }, { runner }),
      (err: unknown) => err instanceof ConfigError && err.message.includes("ingresá un modelo manualmente"),
    );
  });
});
