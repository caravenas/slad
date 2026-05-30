import { createHash } from "node:crypto";
import {
  createReusableCacheMetadata,
  evaluateReusableCacheEntry,
  type ReusableCacheMetadata,
} from "./invalidation.js";
import { createProjectCacheStore } from "./store.js";

const PACKAGE_VERSION = "0.1.0";

export interface CachedReusableEntry<T> {
  metadata: ReusableCacheMetadata;
  value: T;
}

export interface ReusableCacheResult<T> {
  value: T;
  cacheStatus: "hit" | "miss";
}

export interface ReusableCacheOptions<T> {
  cwd?: string;
  rootDir?: string;
  objectType: string;
  snapshotHash: string;
  inputSignature: string;
  runtimeVersion: string;
  relevantFilePaths?: readonly string[];
  producer: () => Promise<T> | T;
  isCacheable?: (value: T) => boolean;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashStructured(value: unknown): string {
  return hashText(stableStringify(value));
}

export function currentToolVersion(): string {
  return PACKAGE_VERSION;
}

export async function readOrCreateReusableValue<T>(
  options: ReusableCacheOptions<T>,
): Promise<ReusableCacheResult<T>> {
  const cwd = options.cwd ?? process.cwd();
  const metadata = createReusableCacheMetadata({
    snapshotHash: options.snapshotHash,
    inputSignature: options.inputSignature,
    toolVersion: currentToolVersion(),
    runtimeVersion: options.runtimeVersion,
    relevantFilePaths: options.relevantFilePaths,
    cwd,
  });
  const store = createProjectCacheStore<CachedReusableEntry<T>>({
    cwd,
    rootDir: options.rootDir,
    objectType: options.objectType,
  });
  const cached = store.get(metadata.reuseKey.key);

  if (cached) {
    const evaluation = evaluateReusableCacheEntry({
      cached: cached.metadata,
      current: {
        snapshotHash: options.snapshotHash,
        inputSignature: options.inputSignature,
        toolVersion: currentToolVersion(),
        runtimeVersion: options.runtimeVersion,
      },
      cwd,
    });

    if (evaluation.reusable) {
      return { value: cached.value, cacheStatus: "hit" };
    }
  }

  const value = await options.producer();
  if (options.isCacheable?.(value) ?? true) {
    store.set(metadata.reuseKey.key, { metadata, value });
  }

  return { value, cacheStatus: "miss" };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortValue(entryValue)]),
    );
  }

  return value;
}
