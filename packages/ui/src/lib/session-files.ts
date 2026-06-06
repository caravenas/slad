import { archiveSessionFile, findSessionFilePath as findPipelineSessionFilePath } from "@slad/pipeline/session";
import { SESSION_DIR } from "./slad-server";

export function resolveSessionDir(): string {
  return SESSION_DIR;
}

export function findSessionFilePath(sessionId: string): string | null {
  const sessionDir = resolveSessionDir();
  return findPipelineSessionFilePath(sessionDir, sessionId);
}

export function archiveSessionById(sessionId: string): { archivedAt: string; filePath: string } {
  return archiveSessionFile(resolveSessionDir(), sessionId);
}
