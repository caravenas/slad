import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, resolveApiTimeoutMs } from "./timeout.js";
import { ProviderError } from "./errors.js";

describe("withTimeout", () => {
  it("retorna el resultado si la promesa resuelve antes del timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      500,
      "anthropic",
    );
    assert.equal(result, "ok");
  });

  it("lanza ProviderError retryable si la promesa tarda más que el timeout", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    await assert.rejects(
      () => withTimeout(slow, 50, "anthropic"),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.provider, "anthropic");
        assert.ok(err.retryable, "timeout debe ser retryable");
        assert.ok(err.message.includes("timeout"), "mensaje debe mencionar timeout");
        return true;
      },
    );
  });

  it("propaga el error original si la promesa rechaza antes del timeout", async () => {
    const failing = Promise.reject(new ProviderError("rate limited", "openai", { statusCode: 429, retryable: true }));
    await assert.rejects(
      () => withTimeout(failing, 500, "openai"),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal((err as ProviderError).statusCode, 429);
        return true;
      },
    );
  });

  it("no produce memory leak: el timer se cancela cuando la promesa resuelve", async () => {
    const fast = Promise.resolve("fast");
    const result = await withTimeout(fast, 5000, "gemini");
    assert.equal(result, "fast");
  });
});

describe("resolveApiTimeoutMs", () => {
  it("retorna el default de 5 minutos cuando la env var no está seteada", () => {
    const saved = process.env["SLAD_API_TIMEOUT_MS"];
    delete process.env["SLAD_API_TIMEOUT_MS"];
    assert.equal(resolveApiTimeoutMs(), 300_000);
    if (saved !== undefined) process.env["SLAD_API_TIMEOUT_MS"] = saved;
  });

  it("respeta SLAD_API_TIMEOUT_MS cuando está seteada", () => {
    const saved = process.env["SLAD_API_TIMEOUT_MS"];
    process.env["SLAD_API_TIMEOUT_MS"] = "60000";
    assert.equal(resolveApiTimeoutMs(), 60_000);
    if (saved !== undefined) process.env["SLAD_API_TIMEOUT_MS"] = saved;
    else delete process.env["SLAD_API_TIMEOUT_MS"];
  });

  it("ignora valores inválidos y usa el default", () => {
    const saved = process.env["SLAD_API_TIMEOUT_MS"];
    process.env["SLAD_API_TIMEOUT_MS"] = "not-a-number";
    assert.equal(resolveApiTimeoutMs(), 300_000);
    if (saved !== undefined) process.env["SLAD_API_TIMEOUT_MS"] = saved;
    else delete process.env["SLAD_API_TIMEOUT_MS"];
  });
});
