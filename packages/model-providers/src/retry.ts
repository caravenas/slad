import { isRetryable } from "./errors.js";
import { log } from "./logger.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_MAX_DELAY_MS = 16_000;
const DEFAULT_JITTER_FACTOR = 0.25;

function computeDelay(attempt: number, opts: RetryOptions): number {
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = opts.jitterFactor ?? DEFAULT_JITTER_FACTOR;
  const base = opts.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(base, maxDelay);
  // ±jitter aleatorio para evitar thundering herd
  const spread = capped * jitter;
  return Math.round(capped + (Math.random() * 2 - 1) * spread);
}

/**
 * Wraps an async function with exponential backoff retry logic.
 * Only retries on ProviderErrors marked as retryable (429/529/500).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (!isRetryable(err) || attempt >= opts.maxRetries) {
        throw err;
      }

      const delayMs = computeDelay(attempt + 1, opts);
      opts.onRetry?.(err, attempt + 1, delayMs);

      log.debug(`retry: attempt ${attempt + 1}/${opts.maxRetries}, delay ${delayMs}ms`);

      if (delayMs > 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      }
    }
  }

  throw lastErr;
}
