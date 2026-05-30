import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReuseKey, type ReuseKey, type ReuseKeyParts } from "./keys.js";

export interface RelevantFileRecord {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface RelevantFileManifest {
  version: 1;
  files: RelevantFileRecord[];
}

export interface ReusableCacheMetadata {
  reuseKey: ReuseKey;
  relevantFiles?: RelevantFileManifest;
}

export interface ReuseEvaluation {
  reusable: boolean;
  reason:
    | "hit"
    | "key_mismatch"
    | "relevant_files_changed"
    | "relevant_files_missing"
    | "relevant_files_error";
}

export function captureRelevantFiles(
  filePaths: readonly string[],
  options?: { cwd?: string },
): RelevantFileManifest {
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const uniqueRelativePaths = [...new Set(filePaths.map((filePath) => normalizeManifestPath(filePath, cwd)))].sort(
    (left, right) => left.localeCompare(right),
  );

  return {
    version: 1,
    files: uniqueRelativePaths.map((filePath) => snapshotFile(path.join(cwd, filePath), filePath)),
  };
}

export function createReusableCacheMetadata(options: {
  snapshotHash: string;
  inputSignature: string;
  toolVersion: string;
  runtimeVersion: string;
  schemaVersion?: string;
  relevantFilePaths?: readonly string[];
  cwd?: string;
}): ReusableCacheMetadata {
  const reuseKey = createReuseKey({
    snapshotHash: options.snapshotHash,
    inputSignature: options.inputSignature,
    toolVersion: options.toolVersion,
    runtimeVersion: options.runtimeVersion,
    schemaVersion: options.schemaVersion,
  });

  return {
    reuseKey,
    relevantFiles:
      options.relevantFilePaths && options.relevantFilePaths.length > 0
        ? captureRelevantFiles(options.relevantFilePaths, { cwd: options.cwd })
        : undefined,
  };
}

export function evaluateReusableCacheEntry(options: {
  cached: ReusableCacheMetadata;
  current: ReuseKeyParts;
  cwd?: string;
}): ReuseEvaluation {
  const currentReuseKey = createReuseKey(options.current);

  if (options.cached.reuseKey.key !== currentReuseKey.key) {
    return { reusable: false, reason: "key_mismatch" };
  }

  if (!options.cached.relevantFiles) {
    return { reusable: true, reason: "hit" };
  }

  try {
    const cwd = path.resolve(options.cwd ?? process.cwd());

    for (const file of options.cached.relevantFiles.files) {
      const absolutePath = path.join(cwd, file.path);
      if (!fs.existsSync(absolutePath)) {
        return { reusable: false, reason: "relevant_files_missing" };
      }

      const currentSnapshot = snapshotFile(absolutePath, file.path);
      if (
        currentSnapshot.hash !== file.hash ||
        currentSnapshot.size !== file.size ||
        currentSnapshot.mtimeMs !== file.mtimeMs
      ) {
        return { reusable: false, reason: "relevant_files_changed" };
      }
    }
  } catch {
    return { reusable: false, reason: "relevant_files_error" };
  }

  return { reusable: true, reason: "hit" };
}

function snapshotFile(absolutePath: string, manifestPath: string): RelevantFileRecord {
  const stats = fs.statSync(absolutePath);
  const buffer = fs.readFileSync(absolutePath);

  return {
    path: manifestPath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

function normalizeManifestPath(filePath: string, cwd: string): string {
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Relevant file path "${filePath}" must stay within cwd.`);
  }

  return relativePath.split(path.sep).join(path.posix.sep);
}
