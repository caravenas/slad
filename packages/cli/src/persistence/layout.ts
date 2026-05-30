import {
  artifactFilePath as pipelineArtifactFilePath,
  artifactLogDir as pipelineArtifactLogDir,
  artifactLogDirName as pipelineArtifactLogDirName,
  runArtifactFilePath as pipelineRunArtifactFilePath,
  timestampedArtifactFilePath as pipelineTimestampedArtifactFilePath,
  timestampedRunArtifactFilePath as pipelineTimestampedRunArtifactFilePath,
} from "@slad/pipeline";
import { loadProjectConfig, loadProjectConfigSync, resolveDocsRoot } from "../core/project-config.js";
import type { ArtifactKind } from "./index.js";

let _docsRoot: string | null = null;

export async function getDocsRoot(): Promise<string> {
  if (_docsRoot) return _docsRoot;
  const cfg = await loadProjectConfig();
  _docsRoot = resolveDocsRoot(cfg);
  return _docsRoot;
}

export function getDocsRootSync(projectRoot: string = process.cwd()): string {
  const cfg = loadProjectConfigSync(projectRoot);
  return resolveDocsRoot(cfg, projectRoot);
}

/** Only for tests — clears the cached docsRoot so env vars / configs are re-read. */
export function resetDocsRootCache(): void {
  _docsRoot = null;
}

export function artifactDirName(kind: ArtifactKind): string {
  return pipelineArtifactLogDirName(kind);
}

export async function artifactDir(kind: ArtifactKind): Promise<string> {
  const root = await getDocsRoot();
  return pipelineArtifactLogDir(root, kind);
}

export function artifactDirSync(kind: ArtifactKind, projectRoot: string = process.cwd()): string {
  return pipelineArtifactLogDir(getDocsRootSync(projectRoot), kind);
}

export async function pathForArtifact(
  kind: ArtifactKind,
  sessionId: string,
  key?: string,
): Promise<string> {
  return pipelineArtifactFilePath(await getDocsRoot(), kind, sessionId, key);
}

export async function timestampedPathForArtifact(
  kind: ArtifactKind,
  sessionId: string,
  isoTimestamp: string,
  key?: string,
): Promise<string> {
  return pipelineTimestampedArtifactFilePath(await getDocsRoot(), kind, sessionId, isoTimestamp, key);
}

export async function pathForRun(sessionId: string, taskId: string): Promise<string> {
  return pipelineRunArtifactFilePath(await getDocsRoot(), sessionId, taskId);
}

export async function timestampedPathForRun(
  sessionId: string,
  taskId: string,
  isoTimestamp: string,
): Promise<string> {
  return pipelineTimestampedRunArtifactFilePath(await getDocsRoot(), sessionId, taskId, isoTimestamp);
}

export async function listRunsDir(): Promise<string> {
  return artifactDir("run");
}
