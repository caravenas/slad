import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

const PROJECT_METADATA_DIR = ".slad-os";
const PROJECT_METADATA_FILE = "project-id.json";
const PROJECT_REGISTRATIONS_DIR = "registrations";
const CACHE_ROOT_SEGMENTS = [".slad-os", "cache", "v1"] as const;
const PROJECT_METADATA_VERSION = 2;
const PROJECT_REGISTRATIONS_ROOT_ENV = "SLAD_PROJECT_REGISTRATIONS_ROOT";
const LOCAL_PROJECT_MARKERS = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  ".slad-session",
] as const;

export type ProjectKind = "git" | "directory";

export interface ProjectIdMetadata {
  version: 2;
  localProjectUid: string;
  projectId: string;
  projectKind: ProjectKind;
  rootFingerprint: string;
  lastKnownProjectRoot: string;
  createdAt: string;
  gitRemoteUrl?: string;
}

interface ProjectRegistration {
  version: 2;
  localProjectUid: string;
  projectId: string;
  projectKind: ProjectKind;
  rootFingerprint: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  gitRemoteUrl?: string;
}

export interface ResolvedProjectId {
  projectId: string;
  projectRoot: string;
  metadataPath: string;
  registrationPath: string;
  metadata: ProjectIdMetadata;
  projectKind: ProjectKind;
}

export interface ResolveProjectIdOptions {
  cwd?: string;
}

export function resolveProjectId(options: ResolveProjectIdOptions = {}): ResolvedProjectId {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRoot = findProjectRoot(cwd);
  const projectKind: ProjectKind = hasGitMarker(projectRoot) ? "git" : "directory";
  const metadataPath = resolveProjectMetadataPath(projectRoot);
  const registrationPath = resolveProjectRegistrationPath({
    projectRoot,
    projectKind,
    gitRemoteUrl: projectKind === "git" ? readGitRemoteUrl(projectRoot) : undefined,
  });
  const metadata = loadOrCreateProjectMetadata({
    metadataPath,
    registrationPath,
    projectRoot,
    projectKind,
  });

  return {
    projectId: metadata.projectId,
    projectRoot,
    metadataPath,
    registrationPath,
    metadata,
    projectKind,
  };
}

export function resolveProjectMetadataPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE);
}

export function resolveProjectRegistrationPath({
  projectRoot,
  projectKind,
  gitRemoteUrl,
}: {
  projectRoot: string;
  projectKind: ProjectKind;
  gitRemoteUrl?: string;
}): string {
  const rootFingerprint = buildRootFingerprint({ projectRoot, projectKind, gitRemoteUrl });
  return path.join(defaultProjectRegistrationRoot(), `${stableHash(rootFingerprint, 32)}.json`);
}

export function findProjectRoot(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  let current = resolvedCwd;
  let metadataRoot: string | undefined;
  let markerRoot: string | undefined;

  while (true) {
    if (hasGitMarker(current)) return current;
    if (!metadataRoot && hasProjectMetadata(current)) metadataRoot = current;
    if (!markerRoot && hasLocalProjectMarker(current)) markerRoot = current;

    const parent = path.dirname(current);
    if (parent === current) {
      // Non-git directories reuse persisted metadata when present. Otherwise we
      // fall back to the nearest conventional project marker, or finally the
      // provided cwd to keep local-only projects isolated.
      return metadataRoot ?? markerRoot ?? resolvedCwd;
    }
    current = parent;
  }
}

function hasGitMarker(directory: string): boolean {
  return fs.existsSync(path.join(directory, ".git"));
}

function hasProjectMetadata(directory: string): boolean {
  return fs.existsSync(resolveProjectMetadataPath(directory));
}

function hasLocalProjectMarker(directory: string): boolean {
  return LOCAL_PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(directory, marker)));
}

function loadOrCreateProjectMetadata({
  metadataPath,
  registrationPath,
  projectRoot,
  projectKind,
}: {
  metadataPath: string;
  registrationPath: string;
  projectRoot: string;
  projectKind: ProjectKind;
}): ProjectIdMetadata {
  const gitRemoteUrl = projectKind === "git" ? readGitRemoteUrl(projectRoot) : undefined;
  const existing = readProjectMetadata(metadataPath);
  if (existing) {
    const normalized = normalizeProjectMetadata(existing, projectRoot, projectKind, gitRemoteUrl);
    persistProjectIdentity({ metadataPath, registrationPath, metadata: normalized, projectRoot });
    return normalized;
  }

  const registration = readProjectRegistration(registrationPath);
  if (registration) {
    const metadata = registrationToMetadata(registration, projectRoot);
    persistProjectIdentity({ metadataPath, registrationPath, metadata, projectRoot });
    return metadata;
  }

  const metadata = createProjectMetadata(projectRoot, projectKind, gitRemoteUrl);
  persistProjectIdentity({ metadataPath, registrationPath, metadata, projectRoot });
  return metadata;
}

function readProjectMetadata(metadataPath: string): ProjectIdMetadata | LegacyProjectIdMetadata | null {
  if (!fs.existsSync(metadataPath)) return null;

  try {
    const raw = fs.readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (
      parsed.version === PROJECT_METADATA_VERSION &&
      typeof parsed.localProjectUid === "string" &&
      typeof parsed.projectId === "string" &&
      (parsed.projectKind === "git" || parsed.projectKind === "directory") &&
      typeof parsed.rootFingerprint === "string" &&
      typeof parsed.lastKnownProjectRoot === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        version: PROJECT_METADATA_VERSION,
        localProjectUid: parsed.localProjectUid,
        projectId: parsed.projectId,
        projectKind: parsed.projectKind,
        rootFingerprint: parsed.rootFingerprint,
        lastKnownProjectRoot: parsed.lastKnownProjectRoot,
        createdAt: parsed.createdAt,
        gitRemoteUrl: typeof parsed.gitRemoteUrl === "string" ? parsed.gitRemoteUrl : undefined,
      };
    }

    if (
      parsed.version === 1 &&
      typeof parsed.localId === "string" &&
      (parsed.projectKind === "git" || parsed.projectKind === "directory") &&
      typeof parsed.rootFingerprint === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        version: 1,
        localId: parsed.localId,
        projectKind: parsed.projectKind,
        rootFingerprint: parsed.rootFingerprint,
        createdAt: parsed.createdAt,
        gitRemoteUrl: typeof parsed.gitRemoteUrl === "string" ? parsed.gitRemoteUrl : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}

interface LegacyProjectIdMetadata {
  version: 1;
  localId: string;
  projectKind: ProjectKind;
  rootFingerprint: string;
  createdAt: string;
  gitRemoteUrl?: string;
}

function createProjectMetadata(
  projectRoot: string,
  projectKind: ProjectKind,
  gitRemoteUrl?: string,
): ProjectIdMetadata {
  const rootFingerprint = buildRootFingerprint({ projectRoot, projectKind, gitRemoteUrl });
  const localProjectUid = randomUUID();
  const projectId = buildProjectId({
    localProjectUid,
    projectKind,
    gitRemoteUrl,
  });

  return {
    version: PROJECT_METADATA_VERSION,
    localProjectUid,
    projectId,
    projectKind,
    rootFingerprint,
    lastKnownProjectRoot: fs.realpathSync.native(projectRoot),
    createdAt: new Date().toISOString(),
    gitRemoteUrl,
  };
}

function normalizeProjectMetadata(
  metadata: ProjectIdMetadata | LegacyProjectIdMetadata,
  projectRoot: string,
  projectKind: ProjectKind,
  gitRemoteUrl?: string,
): ProjectIdMetadata {
  const rootFingerprint = buildRootFingerprint({ projectRoot, projectKind, gitRemoteUrl });

  if (metadata.version === PROJECT_METADATA_VERSION) {
    return {
      ...metadata,
      projectKind,
      rootFingerprint,
      lastKnownProjectRoot: fs.realpathSync.native(projectRoot),
      gitRemoteUrl,
    };
  }

  const localProjectUid = metadata.localId;
  return {
    version: PROJECT_METADATA_VERSION,
    localProjectUid,
    projectId: buildProjectId({ localProjectUid, projectKind, gitRemoteUrl }),
    projectKind,
    rootFingerprint,
    lastKnownProjectRoot: fs.realpathSync.native(projectRoot),
    createdAt: metadata.createdAt,
    gitRemoteUrl,
  };
}

function buildProjectId({
  localProjectUid,
  projectKind,
  gitRemoteUrl,
}: {
  localProjectUid: string;
  projectKind: ProjectKind;
  gitRemoteUrl?: string;
}): string {
  return `${projectKind}:${stableHash(
    JSON.stringify({
      version: PROJECT_METADATA_VERSION,
      localProjectUid,
      projectKind,
      gitRemoteUrl: gitRemoteUrl ?? null,
    }),
    24,
  )}`;
}

function buildRootFingerprint({
  projectRoot,
  projectKind,
  gitRemoteUrl,
}: {
  projectRoot: string;
  projectKind: ProjectKind;
  gitRemoteUrl?: string;
}): string {
  const root = fs.realpathSync.native(projectRoot);
  return JSON.stringify({
    projectKind,
    root,
    gitRemoteUrl: gitRemoteUrl ?? null,
  });
}

function readGitRemoteUrl(projectRoot: string): string | undefined {
  const configPath = path.join(projectRoot, ".git", "config");
  if (!fs.existsSync(configPath)) return undefined;

  const raw = fs.readFileSync(configPath, "utf8");
  const match = raw.match(/\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*(.+)\n/i);
  return match?.[1]?.trim() || undefined;
}

function readProjectRegistration(registrationPath: string): ProjectRegistration | null {
  if (!fs.existsSync(registrationPath)) return null;

  try {
    const raw = fs.readFileSync(registrationPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectRegistration>;
    if (
      parsed.version === PROJECT_METADATA_VERSION &&
      typeof parsed.localProjectUid === "string" &&
      typeof parsed.projectId === "string" &&
      (parsed.projectKind === "git" || parsed.projectKind === "directory") &&
      typeof parsed.rootFingerprint === "string" &&
      typeof parsed.projectRoot === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        version: PROJECT_METADATA_VERSION,
        localProjectUid: parsed.localProjectUid,
        projectId: parsed.projectId,
        projectKind: parsed.projectKind,
        rootFingerprint: parsed.rootFingerprint,
        projectRoot: parsed.projectRoot,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        gitRemoteUrl: typeof parsed.gitRemoteUrl === "string" ? parsed.gitRemoteUrl : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function registrationToMetadata(
  registration: ProjectRegistration,
  projectRoot: string,
): ProjectIdMetadata {
  return {
    version: PROJECT_METADATA_VERSION,
    localProjectUid: registration.localProjectUid,
    projectId: registration.projectId,
    projectKind: registration.projectKind,
    rootFingerprint: registration.rootFingerprint,
    lastKnownProjectRoot: fs.realpathSync.native(projectRoot),
    createdAt: registration.createdAt,
    gitRemoteUrl: registration.gitRemoteUrl,
  };
}

function persistProjectIdentity({
  metadataPath,
  registrationPath,
  metadata,
  projectRoot,
}: {
  metadataPath: string;
  registrationPath: string;
  metadata: ProjectIdMetadata;
  projectRoot: string;
}): void {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  fs.mkdirSync(path.dirname(registrationPath), { recursive: true });
  const existing = readProjectRegistration(registrationPath);
  const now = new Date().toISOString();
  const registration: ProjectRegistration = {
    version: PROJECT_METADATA_VERSION,
    localProjectUid: metadata.localProjectUid,
    projectId: metadata.projectId,
    projectKind: metadata.projectKind,
    rootFingerprint: metadata.rootFingerprint,
    projectRoot: fs.realpathSync.native(projectRoot),
    createdAt: existing?.createdAt ?? metadata.createdAt,
    updatedAt: now,
    gitRemoteUrl: metadata.gitRemoteUrl,
  };
  fs.writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
}

function defaultProjectRegistrationRoot(): string {
  const override = process.env[PROJECT_REGISTRATIONS_ROOT_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ...CACHE_ROOT_SEGMENTS, PROJECT_REGISTRATIONS_DIR);
}

function stableHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
