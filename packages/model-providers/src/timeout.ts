import { ProviderError } from "./errors.js";

const DEFAULT_API_TIMEOUT_MS = 300_000; // 5 minutes

export function resolveApiTimeoutMs(): number {
  const raw = process.env["SLAD_API_TIMEOUT_MS"];
  if (!raw) return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_API_TIMEOUT_MS;
}

/**
 * Races a promise against a timeout. On timeout, throws a retryable ProviderError.
 * The timer is always cleared to prevent memory leaks.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ProviderError(
          `${provider} API timeout after ${timeoutMs}ms`,
          provider,
          { retryable: true },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
