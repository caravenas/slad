import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, SchemaError, ConfigError, SessionError, HarnessError, SladError, isRetryable } from "./errors.js";

describe("SladError", () => {
  it("tiene code y context", () => {
    const err = new SladError("test", "TEST_CODE", { key: "value" });
    assert.equal(err.code, "TEST_CODE");
    assert.deepEqual(err.context, { key: "value" });
    assert.equal(err.name, "SladError");
  });

  it("instanceof Error", () => {
    const err = new SladError("test", "X");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SladError);
  });
});

describe("ProviderError", () => {
  it("marca rate limit (429) como retryable", () => {
    const err = new ProviderError("rate limited", "anthropic", {
      statusCode: 429,
      retryable: true,
    });
    assert.equal(isRetryable(err), true);
    assert.equal(err.code, "PROVIDER_ERROR");
    assert.equal(err.provider, "anthropic");
    assert.equal(err.statusCode, 429);
  });

  it("marca overload (529) como retryable", () => {
    const err = new ProviderError("overloaded", "anthropic", {
      statusCode: 529,
      retryable: true,
    });
    assert.equal(isRetryable(err), true);
  });

  it("marca errores generales como no retryable por defecto", () => {
    const err = new ProviderError("bad request", "openai", { statusCode: 400 });
    assert.equal(isRetryable(err), false);
    assert.equal(err.retryable, false);
  });

  it("preserva cause", () => {
    const cause = new Error("original error");
    const err = new ProviderError("wrapped", "gemini", { cause });
    assert.equal(err.cause, cause);
  });
});

describe("SchemaError", () => {
  it("preserva raw output y issues de Zod", () => {
    const err = new SchemaError(
      "schema fail",
      '{"bad": true}',
      ["field.missing — Required"],
      "explore",
    );
    assert.equal(err.rawOutput, '{"bad": true}');
    assert.deepEqual(err.zodIssues, ["field.missing — Required"]);
    assert.equal(err.code, "SCHEMA_ERROR");
    assert.equal(err.context.stage, "explore");
    assert.equal(err.context.issueCount, 1);
  });
});

describe("ConfigError", () => {
  it("tiene code CONFIG_ERROR", () => {
    const err = new ConfigError("missing key", { key: "ANTHROPIC_API_KEY" });
    assert.equal(err.code, "CONFIG_ERROR");
    assert.equal(err.context.key, "ANTHROPIC_API_KEY");
  });
});

describe("SessionError", () => {
  it("tiene code SESSION_ERROR", () => {
    const err = new SessionError("session not found");
    assert.equal(err.code, "SESSION_ERROR");
  });
});

describe("HarnessError", () => {
  it("tiene code HARNESS_ERROR", () => {
    const err = new HarnessError("task blocked by harness");
    assert.equal(err.code, "HARNESS_ERROR");
  });
});

describe("isRetryable", () => {
  it("retorna false para errores no ProviderError", () => {
    assert.equal(isRetryable(new Error("generic")), false);
    assert.equal(isRetryable("string error"), false);
    assert.equal(isRetryable(null), false);
  });

  it("retorna false para ProviderError no retryable", () => {
    const err = new ProviderError("fail", "cli", { retryable: false });
    assert.equal(isRetryable(err), false);
  });
});
