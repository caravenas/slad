/**
 * Token-efficient serialization helpers for pipeline artifacts and prompts.
 *
 * Stage output schemas declare `.default([])` / `.default({})` for their
 * collection fields, so empty collections can be dropped before serializing:
 * Zod restores them on read. This trims both the JSON injected back into
 * prompts (HITL rounds, learn input, worker handoffs) and the artifacts on
 * disk.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a deep copy of `value` without properties whose value is an empty
 * array or an empty plain object. Array elements are cleaned recursively but
 * never removed. Scalars (including empty strings) are preserved.
 */
export function stripEmptyCollections<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripEmptyCollections(item)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const cleanedEntry = stripEmptyCollections(entry);
    if (Array.isArray(cleanedEntry) && cleanedEntry.length === 0) continue;
    if (isPlainObject(cleanedEntry) && Object.keys(cleanedEntry).length === 0) continue;
    cleaned[key] = cleanedEntry;
  }
  return cleaned as T;
}

/** Compact JSON for prompt injection: no indentation, no empty collections. */
export function toCompactJson(value: unknown): string {
  return JSON.stringify(stripEmptyCollections(value));
}
