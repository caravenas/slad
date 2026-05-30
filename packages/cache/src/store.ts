import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface CacheStore<T = unknown> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttl?: number): void;
}

export interface CacheStoreOptions {
  projectId: string;
  objectType: string;
  rootDir?: string;
}

export interface ProjectCacheStoreOptions {
  cwd?: string;
  objectType: string;
  rootDir?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
}

interface PersistedCacheEntry<T> extends CacheEntry<T> {
  key: string;
  projectId: string;
  objectType: string;
  storedAt: string;
}

interface PersistedProjectNamespace {
  version: 1;
  projectId: string;
  namespace: string;
  createdAt: string;
  gcPolicy: "manual_delete_only";
  gcNotes: string;
}

interface PersistedObjectNamespace {
  version: 1;
  projectId: string;
  objectType: string;
  namespace: string;
  createdAt: string;
}

const DEFAULT_CACHE_ROOT_SEGMENTS = [".slad-os", "cache", "v1"] as const;

class InMemoryCacheStore<T = unknown> implements CacheStore<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (isExpired(entry)) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T, ttl?: number): void {
    this.entries.set(key, { value, expiresAt: toExpiresAt(ttl) });
  }
}

class FileSystemCacheStore<T = unknown> implements CacheStore<T> {
  constructor(
    private readonly projectId: string,
    private readonly objectType: string,
    private readonly rootDir: string,
  ) {}

  get(key: string): T | undefined {
    const filePath = resolveCacheEntryPath({
      rootDir: this.rootDir,
      projectId: this.projectId,
      objectType: this.objectType,
      key,
    });

    if (!fs.existsSync(filePath)) return undefined;

    const raw = fs.readFileSync(filePath, "utf8");
    const entry = JSON.parse(raw) as PersistedCacheEntry<T>;

    if (isExpired(entry)) {
      fs.rmSync(filePath, { force: true });
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T, ttl?: number): void {
    const filePath = resolveCacheEntryPath({
      rootDir: this.rootDir,
      projectId: this.projectId,
      objectType: this.objectType,
      key,
    });

    ensureCacheNamespace({
      rootDir: this.rootDir,
      projectId: this.projectId,
      objectType: this.objectType,
    });

    const entry: PersistedCacheEntry<T> = {
      key,
      projectId: this.projectId,
      objectType: this.objectType,
      value,
      expiresAt: toExpiresAt(ttl),
      storedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  }
}

function isExpired(entry: CacheEntry<unknown>): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
}

function toExpiresAt(ttl?: number): number | undefined {
  if (ttl === undefined) return undefined;
  if (!Number.isFinite(ttl) || ttl <= 0) return Date.now();
  return Date.now() + ttl;
}

function normalizeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return normalized || fallback;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function namespaceSegment(value: string, fallback: string): string {
  return `${normalizeSegment(value, fallback)}--${stableHash(value)}`;
}

export function resolveCacheRoot(rootDir = defaultCacheRootFromHome()): string {
  return path.resolve(rootDir);
}

export function resolveProjectCacheDir({
  rootDir,
  projectId,
}: {
  rootDir?: string;
  projectId: string;
}): string {
  return path.join(resolveCacheRoot(rootDir), "projects", namespaceSegment(projectId, "project"));
}

export function resolveProjectCacheMetadataPath({
  rootDir,
  projectId,
}: {
  rootDir?: string;
  projectId: string;
}): string {
  return path.join(resolveProjectCacheDir({ rootDir, projectId }), "project.json");
}

export function resolveCacheObjectDir({
  rootDir,
  projectId,
  objectType,
}: CacheStoreOptions): string {
  return path.join(
    resolveProjectCacheDir({ rootDir, projectId }),
    "objects",
    namespaceSegment(objectType, "object"),
  );
}

export function resolveCacheObjectMetadataPath(options: CacheStoreOptions): string {
  return path.join(resolveCacheObjectDir(options), "object.json");
}

export function resolveCacheEntriesDir(options: CacheStoreOptions): string {
  return path.join(resolveCacheObjectDir(options), "entries");
}

export function resolveCacheEntryPath({
  rootDir,
  projectId,
  objectType,
  key,
}: CacheStoreOptions & { key: string }): string {
  const fileName = `${namespaceSegment(key, "entry")}.json`;
  return path.join(resolveCacheEntriesDir({ rootDir, projectId, objectType }), fileName);
}

export function defaultCacheRootFromHome(): string {
  return path.join(os.homedir(), ...DEFAULT_CACHE_ROOT_SEGMENTS);
}

function ensureCacheNamespace(options: CacheStoreOptions): void {
  const projectDir = resolveProjectCacheDir(options);
  const objectDir = resolveCacheObjectDir(options);
  const entriesDir = resolveCacheEntriesDir(options);
  const projectMetadataPath = resolveProjectCacheMetadataPath(options);
  const objectMetadataPath = resolveCacheObjectMetadataPath(options);
  const now = new Date().toISOString();

  fs.mkdirSync(entriesDir, { recursive: true });

  if (!fs.existsSync(projectMetadataPath)) {
    const projectMetadata: PersistedProjectNamespace = {
      version: 1,
      projectId: options.projectId,
      namespace: path.basename(projectDir),
      createdAt: now,
      gcPolicy: "manual_delete_only",
      gcNotes:
        "v1 does not run active GC, TTL sweeps, or quotas; delete projects/<projectId>/ manually to reclaim space.",
    };
    fs.writeFileSync(projectMetadataPath, `${JSON.stringify(projectMetadata, null, 2)}\n`, "utf8");
  }

  if (!fs.existsSync(objectMetadataPath)) {
    const objectMetadata: PersistedObjectNamespace = {
      version: 1,
      projectId: options.projectId,
      objectType: options.objectType,
      namespace: path.basename(objectDir),
      createdAt: now,
    };
    fs.writeFileSync(objectMetadataPath, `${JSON.stringify(objectMetadata, null, 2)}\n`, "utf8");
  }
}

export function createCacheStore<T = unknown>(options?: CacheStoreOptions): CacheStore<T> {
  if (!options) {
    return new InMemoryCacheStore<T>();
  }

  return new FileSystemCacheStore<T>(
    options.projectId,
    options.objectType,
    resolveCacheRoot(options.rootDir),
  );
}

export function createProjectCacheStore<T = unknown>(
  options: ProjectCacheStoreOptions,
): CacheStore<T> {
  const projectId = resolveProjectIdFromCwd(options.cwd);

  return createCacheStore<T>({
    rootDir: options.rootDir,
    objectType: options.objectType,
    projectId,
  });
}

export function resolveProjectIdFromCwd(cwd = process.cwd()): string {
  const projectRoot = findProjectRoot(path.resolve(cwd));
  return `${path.basename(projectRoot) || "project"}-${stableHash(projectRoot)}`;
}

function findProjectRoot(cwd: string): string {
  let current = cwd;

  while (true) {
    if (hasProjectMarker(current)) return current;

    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function hasProjectMarker(directory: string): boolean {
  return [".git", "package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"].some(
    (marker) => fs.existsSync(path.join(directory, marker)),
  );
}
