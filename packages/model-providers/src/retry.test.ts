import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff } from "./retry.js";
import { ProviderError } from "./errors.js";

function makeRetryable(status: number) {
  return new ProviderError("rate limited", "anthropic", { statusCode: status, retryable: true });
}

function makeNonRetryable() {
  return new ProviderError("bad request", "anthropic", { statusCode: 400, retryable: false });
}

describe("retryWithBackoff", () => {
  it("retorna el resultado en el primer intento si no falla", async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 0 });

    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("reintenta ante errores retryable y tiene éxito al segundo intento", async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      if (calls < 2) throw makeRetryable(429);
      return "recovered";
    }, { maxRetries: 3, baseDelayMs: 0 });

    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("no reintenta ante errores no-retryable y lanza inmediatamente", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await retryWithBackoff(async () => {
        calls++;
        throw makeNonRetryable();
      }, { maxRetries: 3, baseDelayMs: 0 });
    }, (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal((err as ProviderError).statusCode, 400);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("agota los reintentos y lanza el último error", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await retryWithBackoff(async () => {
        calls++;
        throw makeRetryable(429);
      }, { maxRetries: 2, baseDelayMs: 0 });
    }, (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal((err as ProviderError).retryable, true);
      return true;
    });
    // 1 intento original + 2 reintentos = 3 llamadas
    assert.equal(calls, 3);
  });

  it("no reintenta errores genéricos (no ProviderError)", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await retryWithBackoff(async () => {
        calls++;
        throw new Error("generic network error");
      }, { maxRetries: 3, baseDelayMs: 0 });
    }, Error);
    assert.equal(calls, 1);
  });

  it("aplica backoff exponencial entre reintentos", async () => {
    const delays: number[] = [];

    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw makeRetryable(429);
      return "done";
    }, {
      maxRetries: 3,
      baseDelayMs: 100,
      onRetry: (_err, _attempt, delayMs) => {
        delays.push(delayMs);
      },
    });

    assert.equal(result, "done");
    assert.equal(delays.length, 2);
    // El segundo delay debe ser mayor o igual al primero (backoff exponencial)
    assert.ok(delays[1]! >= delays[0]!, `delay[1]=${delays[1]} debe ser >= delay[0]=${delays[0]}`);
    // Con base 100ms: delay[0] debería ser ~100ms, delay[1] ~200ms (antes de jitter)
    assert.ok(delays[0]! >= 75, `primer delay demasiado corto: ${delays[0]}`);
    assert.ok(delays[1]! >= 150, `segundo delay demasiado corto: ${delays[1]}`);
  });

  it("llama onRetry con información del intento", async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;

    await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw makeRetryable(529);
      return "ok";
    }, {
      maxRetries: 3,
      baseDelayMs: 0,
      onRetry: (_err, attempt2, delayMs) => {
        retries.push({ attempt: attempt2, delayMs });
      },
    });

    assert.equal(retries.length, 2);
    assert.equal(retries[0]!.attempt, 1);
    assert.equal(retries[1]!.attempt, 2);
  });

  it("funciona con maxRetries: 0 (sin reintentos)", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await retryWithBackoff(async () => {
        calls++;
        throw makeRetryable(429);
      }, { maxRetries: 0, baseDelayMs: 0 });
    });
    assert.equal(calls, 1);
  });
});
