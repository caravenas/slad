import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunLog } from "@slad/shared";
import { parseAgentRunLog } from "@slad/pipeline";
import { getDocsRoot } from "./layout.js";

async function telemetryPath(): Promise<string> {
  const root = await getDocsRoot();
  return path.join(root, "log", "telemetry", "agent-run-log.ldjson");
}

/**
 * Appends one AgentRunLog entry to the LDJSON telemetry file.
 * Best-effort — never throws.
 */
export async function appendAgentRunLog(entry: AgentRunLog): Promise<void> {
  try {
    const filePath = await telemetryPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // telemetry is best-effort
  }
}

/**
 * Reads and parses all AgentRunLog entries from the LDJSON file.
 * Skips corrupt lines. Returns [] if the file doesn't exist.
 */
export async function readAgentRunLog(): Promise<AgentRunLog[]> {
  try {
    const filePath = await telemetryPath();
    const text = await readFile(filePath, "utf8");
    return parseAgentRunLog(text);
  } catch {
    return [];
  }
}
