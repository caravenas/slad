// ─── MemoryProvider contract ──────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  namespace: string;
  content: unknown;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  namespace: string;
  filter?: Record<string, unknown>;
  limit?: number;
}

export interface MemoryProvider {
  /** Append a new entry to a namespace */
  append(opts: { namespace: string; content: unknown; metadata?: Record<string, unknown> }): Promise<MemoryEntry>;
  /** Query entries from a namespace */
  query(opts: MemoryQuery): Promise<MemoryEntry[]>;
  /** Remove all entries from a namespace */
  clear(namespace: string): Promise<void>;
}
