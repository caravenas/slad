import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry, MemoryProvider, MemoryQuery } from "./types.js";

/**
 * Persists memory entries as LDJSON files under a wiki directory.
 * Each namespace maps to a <namespace>.ldjson file.
 */
export class WikiMemoryProvider implements MemoryProvider {
  constructor(private readonly root: string) {}

  async append(opts: { namespace: string; content: unknown; metadata?: Record<string, unknown> }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `${opts.namespace}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      namespace: opts.namespace,
      content: opts.content,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
    const filePath = this.nsPath(opts.namespace);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  async query(opts: MemoryQuery): Promise<MemoryEntry[]> {
    const filePath = this.nsPath(opts.namespace);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    let results: MemoryEntry[] = lines.map((l) => JSON.parse(l) as MemoryEntry);
    if (opts.filter) {
      results = results.filter((e) =>
        Object.entries(opts.filter!).every(([k, v]) => (e.metadata as Record<string, unknown>)?.[k] === v),
      );
    }
    if (opts.limit !== undefined) {
      results = results.slice(-opts.limit);
    }
    return results;
  }

  async clear(namespace: string): Promise<void> {
    const filePath = this.nsPath(namespace);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  private nsPath(namespace: string): string {
    const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.root, `${safe}.ldjson`);
  }
}
