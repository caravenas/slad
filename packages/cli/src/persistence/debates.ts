import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { DebateResult, DebateStage } from "@slad/shared";
import { getDocsRoot } from "./layout.js";

function debatePath(sessionId: string, stage: DebateStage): Promise<string> {
  return getDocsRoot().then((root) =>
    path.join(root, "log", "debates", `${sessionId}_${stage}.json`),
  );
}

/**
 * Saves a DebateResult to log/debates/{sessionId}_{stage}.json.
 * Returns the path written.
 */
export async function saveDebateArtifact(
  sessionId: string,
  stage: DebateStage,
  result: DebateResult,
): Promise<string> {
  const filePath = await debatePath(sessionId, stage);
  const envelope = {
    kind: "debate-result",
    schemaVersion: 1,
    sessionId,
    stage,
    createdAt: new Date().toISOString(),
    value: result,
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(envelope, null, 2), "utf8");
  return filePath;
}
