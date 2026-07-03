import fs from "node:fs";
import path from "node:path";

// ─── Audit event types ────────────────────────────────────────────────────────

export type AuditEventKind =
  | "task_start"
  | "task_end"
  | "hook_verdict"
  | "command_classified"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "policy_violation";

export interface AuditEvent {
  timestamp: string;       // ISO 8601
  sessionId: string | null;
  taskId: string;
  kind: AuditEventKind;
  data: Record<string, unknown>;
}

// ─── AuditLogger — LDJSON append-only ────────────────────────────────────────

export class AuditLogger {
  private fd: number | null = null;

  constructor(private logPath: string) {}

  private ensureOpen(): void {
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.fd = fs.openSync(this.logPath, "a"); // append-only
    }
  }

  log(event: AuditEvent): void {
    this.ensureOpen();
    const line = JSON.stringify(event) + "\n";
    fs.writeSync(this.fd!, Buffer.from(line));
    fs.fsyncSync(this.fd!); // immediate flush — integrity on crash
  }

  async flush(): Promise<void> {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
