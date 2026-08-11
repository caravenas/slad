import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-session mutual exclusion for the mutating run commands.
 *
 * Git's own `worktree add` lock is per-operation, not per-session: without
 * this, two `--resume` of the same parent pass every guard concurrently and
 * the second one runs `removeSessionWorktrees` over worktrees the first is
 * still using.
 */

export type SessionLockCommand = "run" | "resume" | "apply" | "abort";

export interface SessionLockRecord {
  v: 1;
  epoch: number;
  runId: string;
  pid: number;
  host: string;
  user: string;
  startedAt: string;
  command: SessionLockCommand;
}

export interface SessionLockHandle {
  path: string;
  record: SessionLockRecord;
  /** Releases only if we are still the recorded holder. Idempotent. */
  release(): void;
}

export type SessionLockResult =
  | { ok: true; lock: SessionLockHandle }
  | { ok: false; reason: string; holder: SessionLockRecord | null };

export function sessionLockPath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".slad-os", "sessions", sessionId, "run.lock");
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown-user";
  }
}

/** Reads the current holder, or null when the lock is absent or unreadable. */
export function inspectLockHolder(cwd: string, sessionId: string): SessionLockRecord | null {
  return readRecord(sessionLockPath(cwd, sessionId));
}

function readRecord(lockPath: string): SessionLockRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<SessionLockRecord>;
    if (typeof raw?.runId !== "string" || typeof raw?.pid !== "number") return null;
    return {
      v: 1,
      epoch: typeof raw.epoch === "number" ? raw.epoch : 1,
      runId: raw.runId,
      pid: raw.pid,
      host: typeof raw.host === "string" ? raw.host : "unknown-host",
      user: typeof raw.user === "string" ? raw.user : "unknown-user",
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "unknown",
      command: (raw.command ?? "run") as SessionLockCommand,
    };
  } catch {
    return null;
  }
}

/**
 * A competing process creates the lock file before writing/fsyncing its JSON.
 * Seeing `EEXIST` in that window must not degrade into "ilegible": retry a
 * short, bounded time so the loser names the real holder instead of reporting
 * corruption for a lock that is merely still being persisted.
 */
function readRecordWithRetry(lockPath: string, timeoutMs = 200): SessionLockRecord | null {
  const deadline = Date.now() + timeoutMs;
  let record = readRecord(lockPath);
  while (record === null && fs.existsSync(lockPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    record = readRecord(lockPath);
  }
  return record;
}

/**
 * `ESRCH ⇒ dead` is the only direction that proves anything. A live pid does
 * not prove it is the same process (pid reuse), and `EPERM` or another host
 * prove nothing at all, so both reject.
 */
function provenDead(record: SessionLockRecord): boolean {
  if (record.host !== hostname()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function describeLockHolder(record: SessionLockRecord): string {
  return `${record.command} ${record.runId} (pid ${record.pid}, host ${record.host}, user ${record.user}, desde ${record.startedAt})`;
}

export interface AcquireSessionLockOptions {
  runId: string;
  command: SessionLockCommand;
  /** Escape hatch: the caller must copy the holder's runId from the error. */
  forceUnlock?: string;
}

export function acquireSessionLock(
  cwd: string,
  sessionId: string,
  { runId, command, forceUnlock }: AcquireSessionLockOptions,
): SessionLockResult {
  const lockPath = sessionLockPath(cwd, sessionId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const record = (epoch: number): SessionLockRecord => ({
    v: 1,
    epoch,
    runId,
    pid: process.pid,
    host: hostname(),
    user: currentUser(),
    startedAt: new Date().toISOString(),
    command,
  });

  const handle = (value: SessionLockRecord): SessionLockHandle => ({
    path: lockPath,
    record: value,
    release() {
      releaseSessionLock({ path: lockPath, record: value, release: () => undefined });
    },
  });

  try {
    const fd = fs.openSync(lockPath, "wx");
    const value = record(1);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, lock: handle(value) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const holder = readRecordWithRetry(lockPath);
  const forced = forceUnlock !== undefined && holder !== null && forceUnlock === holder.runId;
  if (!forced) {
    if (holder === null) {
      return {
        ok: false,
        holder: null,
        reason:
          `La sesión ${sessionId} tiene un ${lockPath} ilegible; otro proceso puede estar usándola. ` +
          "Verificá y borralo a mano si estás seguro de que nadie corre.",
      };
    }
    if (!provenDead(holder)) {
      return {
        ok: false,
        holder,
        reason:
          `La sesión ${sessionId} está tomada por ${describeLockHolder(holder)}.\n` +
          `  ps -p ${holder.pid} -o pid,ppid,lstart,command\n` +
          `  slad pipeline run --force-unlock ${holder.runId}   (solo si verificaste que ese proceso murió)`,
      };
    }
  }

  // Takeover by epoch CAS: `unlink` + `open` races into two holders
  // (A unlink · A open ok · B unlink removes A's · B open ok). Winning an
  // O_EXCL on the next epoch and renaming over the lock lets exactly one
  // taker through, and the lock never disappears (rename is atomic).
  const nextEpoch = (holder?.epoch ?? 1) + 1;
  const stagingPath = `${lockPath}.${nextEpoch}`;
  let fd: number;
  try {
    fd = fs.openSync(stagingPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return {
      ok: false,
      holder,
      reason: `Otro proceso está tomando la sesión ${sessionId} en este mismo instante; reintentá.`,
    };
  }
  const value = record(nextEpoch);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(stagingPath, lockPath);
  return { ok: true, lock: handle(value) };
}

/** Re-reads before unlinking: never releases a lock another taker now owns. */
export function releaseSessionLock(lock: SessionLockHandle): void {
  const current = readRecord(lock.path);
  if (current === null || current.runId !== lock.record.runId || current.epoch !== lock.record.epoch) return;
  try {
    fs.unlinkSync(lock.path);
  } catch {
    // Already gone.
  }
}
