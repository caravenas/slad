import { createHash } from "node:crypto";

export const CACHE_SCHEMA_VERSION = "1";

export interface ReuseKeyParts {
  snapshotHash: string;
  inputSignature: string;
  toolVersion: string;
  runtimeVersion: string;
  schemaVersion?: string;
}

export interface ReuseKey {
  key: string;
  scope: string;
  snapshotHash: string;
  inputSignature: string;
  toolVersion: string;
  runtimeVersion: string;
  schemaVersion: string;
}

export function createReuseKey(parts: ReuseKeyParts): ReuseKey {
  const normalized: Omit<ReuseKey, "key" | "scope"> = {
    snapshotHash: normalizeKeyPart(parts.snapshotHash, "snapshotHash"),
    inputSignature: normalizeKeyPart(parts.inputSignature, "inputSignature"),
    toolVersion: normalizeKeyPart(parts.toolVersion, "toolVersion"),
    runtimeVersion: normalizeKeyPart(parts.runtimeVersion, "runtimeVersion"),
    schemaVersion: normalizeKeyPart(parts.schemaVersion ?? CACHE_SCHEMA_VERSION, "schemaVersion"),
  };
  const scope = stableStringify(normalized);

  return {
    ...normalized,
    scope,
    key: createHash("sha256").update(scope).digest("hex"),
  };
}

function normalizeKeyPart(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`Cache reuse key field "${fieldName}" must be a non-empty string.`);
  }

  return normalized;
}

function stableStringify(value: Record<string, string>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}
