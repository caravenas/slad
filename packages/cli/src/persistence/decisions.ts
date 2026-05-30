import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DecisionRecord } from "@slad/shared";
import { getDocsRoot } from "./layout.js";

interface DecisionsLog {
  kind: "decisions-log";
  schemaVersion: 1;
  sessionId: string;
  updatedAt: string;
  decisions: DecisionRecord[];
}

async function decisionsLogPath(sessionId: string): Promise<string> {
  const root = await getDocsRoot();
  return path.join(root, "log", "decisions", `${sessionId}.json`);
}

/**
 * Appends decisions from a stage to the session-scoped decisions log.
 * Creates the file if it doesn't exist; no-ops if decisions is empty.
 */
export async function appendSessionDecisions(
  sessionId: string,
  decisions: DecisionRecord[],
): Promise<void> {
  if (decisions.length === 0) return;

  const filePath = await decisionsLogPath(sessionId);
  const updatedAt = new Date().toISOString();

  let log: DecisionsLog = {
    kind: "decisions-log",
    schemaVersion: 1,
    sessionId,
    updatedAt,
    decisions: [],
  };

  if (existsSync(filePath)) {
    try {
      const text = await readFile(filePath, "utf8");
      const parsed = JSON.parse(text) as DecisionsLog;
      log = { ...parsed, updatedAt, decisions: parsed.decisions ?? [] };
    } catch {
      // corrupt file — start fresh
    }
  }

  log.decisions.push(...decisions);
  log.updatedAt = updatedAt;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(log, null, 2), "utf8");
}

/**
 * Returns all decisions logged for a session, or an empty array if none.
 */
export async function readSessionDecisions(sessionId: string): Promise<DecisionRecord[]> {
  const filePath = await decisionsLogPath(sessionId);
  if (!existsSync(filePath)) return [];

  try {
    const text = await readFile(filePath, "utf8");
    const log = JSON.parse(text) as DecisionsLog;
    return log.decisions ?? [];
  } catch {
    return [];
  }
}
