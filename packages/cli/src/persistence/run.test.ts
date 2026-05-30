import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeArtifact, readArtifact } from "./index.js";
import { ParseError } from "../core/errors.js";
import { resetDocsRootCache } from "./layout.js";
import type { RunOutput } from "../core/types.js";

const BASE_CTX = { sessionId: "2026-05-06_test-session", createdAt: "2026-05-06T12:00:00.000Z" };

function makeRunOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    taskId: "T1",
    status: "completed",
    summary: "Implemented the cache key generator with userId salt.",
    changedFiles: ["src/cache/store.ts", "src/cache/keys.ts"],
    verification: [
      { command: "npm test", status: "passed", notes: "" },
      { command: "npm run typecheck", status: "passed", notes: "No errors" },
    ],
    reviewerNotes: ["Verified no collisions with existing cache entries", "No performance regression"],
    followUps: ["Consider adding TTL-based eviction", "Document the new salt format"],
    questions: [],
    humanAnswers: {},
    decisions: [],
    ...overrides,
  };
}

describe("persistence/run", () => {
  let tmpDir: string;
  let previousDocspath: string | undefined;

  beforeEach(() => {
    resetDocsRootCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-run-test-"));
    previousDocspath = process.env.SLAD_DOCS_PATH;
    process.env.SLAD_DOCS_PATH = path.join(tmpDir, "docs");
  });

  afterEach(() => {
    resetDocsRootCache();
    if (previousDocspath === undefined) {
      delete process.env.SLAD_DOCS_PATH;
    } else {
      process.env.SLAD_DOCS_PATH = previousDocspath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. roundtrip happy-path: writeArtifact → readArtifact → deep-equal", async () => {
    const original = makeRunOutput();
    const ref = await writeArtifact("run", original, BASE_CTX);
    const { value, warnings } = await readArtifact("run", ref.path);

    assert.deepEqual(value, original);
    assert.equal(warnings.length, 0);
  });

  it("2. roundtrip con campos opcionales vacíos", async () => {
    const original = makeRunOutput({
      reviewerNotes: [],
      followUps: [],
      questions: [],
      humanAnswers: {},
      changedFiles: [],
      verification: [],
    });
    const ref = await writeArtifact("run", original, BASE_CTX);
    const { value, warnings } = await readArtifact("run", ref.path);

    assert.deepEqual(value, original);
    assert.equal(warnings.length, 0);
  });

  it("3. artifact path ends with .json", async () => {
    const original = makeRunOutput();
    const ref = await writeArtifact("run", original, BASE_CTX);
    assert.ok(ref.path.endsWith(".json"), `Expected .json path, got: ${ref.path}`);
  });

  it("4. envelope tiene kind, schemaVersion, sessionId, value", async () => {
    const original = makeRunOutput();
    const ref = await writeArtifact("run", original, BASE_CTX);
    const raw = JSON.parse(fs.readFileSync(ref.path, "utf8")) as Record<string, unknown>;
    assert.equal(raw.kind, "run");
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.sessionId, BASE_CTX.sessionId);
    assert.deepEqual(raw.value, original);
  });

  it("5. readArtifact falla con ParseError phase=filesystem si el archivo no existe", async () => {
    await assert.rejects(
      () => readArtifact("run", "/nonexistent/path/run.json"),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "filesystem");
        return true;
      },
    );
  });

  it("6. readArtifact falla con ParseError phase=json si JSON está malformado", async () => {
    const badPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(badPath, "{ not valid json", "utf8");
    await assert.rejects(
      () => readArtifact("run", badPath),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "json");
        return true;
      },
    );
  });

  it("7. readArtifact falla con ParseError phase=zod si value no pasa schema", async () => {
    const badPath = path.join(tmpDir, "bad-schema.json");
    fs.writeFileSync(
      badPath,
      JSON.stringify({ kind: "run", schemaVersion: 1, sessionId: "s", value: { taskId: "T1", status: "invalid_xyz" } }),
      "utf8",
    );
    await assert.rejects(
      () => readArtifact("run", badPath),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "zod");
        return true;
      },
    );
  });

  it("8. segunda escritura del mismo run genera path timestamped", async () => {
    const original = makeRunOutput();
    const ref1 = await writeArtifact("run", original, BASE_CTX);
    const ref2 = await writeArtifact("run", original, BASE_CTX);
    assert.notEqual(ref1.path, ref2.path);
    assert.ok(ref2.path.includes("__"), `Expected timestamped path, got: ${ref2.path}`);
  });

  it("9. idempotencia: readArtifact dos veces da el mismo value", async () => {
    const original = makeRunOutput();
    const ref = await writeArtifact("run", original, BASE_CTX);
    const first = await readArtifact("run", ref.path);
    const second = await readArtifact("run", ref.path);
    assert.deepEqual(first.value, second.value);
  });
});
