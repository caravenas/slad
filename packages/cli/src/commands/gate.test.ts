import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateJsonSchema } from "./gate.js";

describe("slad gate", () => {
  let dir: string;
  let schemaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "slad-gate-"));
    schemaPath = path.join(dir, "schema.json");
    await writeFile(schemaPath, JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string", minLength: 1 } },
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts valid input", async () => {
    const inputPath = path.join(dir, "valid.json");
    await writeFile(inputPath, JSON.stringify({ name: "SLAD" }));

    const result = await validateJsonSchema({ schema: schemaPath, input: inputPath });

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("returns machine-readable AJV errors for invalid input", async () => {
    const inputPath = path.join(dir, "invalid.json");
    await writeFile(inputPath, JSON.stringify({ name: "", extra: true }));

    const result = await validateJsonSchema({ schema: schemaPath, input: inputPath });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
    assert.ok(result.errors.some((error) => error.keyword === "minLength"));
  });

  it("surfaces schema and input I/O errors", async () => {
    await assert.rejects(
      () => validateJsonSchema({ schema: schemaPath, input: path.join(dir, "missing.json") }),
      /cannot read input file/,
    );
  });
});
