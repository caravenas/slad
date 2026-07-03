import type { MemoryEntry, MemoryProvider, MemoryQuery } from "./types.js";

export class InMemoryProvider implements MemoryProvider {
  private entries: MemoryEntry[] = [];

  async append(opts: { namespace: string; content: unknown; metadata?: Record<string, unknown> }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `${opts.namespace}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      namespace: opts.namespace,
      content: opts.content,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
    this.entries.push(entry);
    return entry;
  }

  async query(opts: MemoryQuery): Promise<MemoryEntry[]> {
    let results = this.entries.filter((e) => e.namespace === opts.namespace);
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
    this.entries = this.entries.filter((e) => e.namespace !== namespace);
  }
}
