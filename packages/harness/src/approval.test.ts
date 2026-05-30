import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { confirmDangerousAction, createHarness } from "./index.js";
import type { ApprovalIO, CommandClassification } from "./index.js";

const full: CommandClassification = { original: "rm -rf dist", level: "full", reason: "danger", patterns: ["rm -rf"] };

describe("@slad/harness ApprovalIO", () => {
  test("confirmDangerousAction delegates approval to injected IO", async () => {
    const calls: string[] = [];
    const io: ApprovalIO = {
      canAsk: () => true,
      confirm: async ({ taskId, dangerous }) => {
        calls.push(`${taskId}:${dangerous.length}`);
        return true;
      },
    };
    const approved = await confirmDangerousAction("T1", [full], io);
    assert.equal(approved, true);
    assert.deepEqual(calls, ["T1:1"]);
  });

  test("confirmDangerousAction rejects by default when IO cannot ask", async () => {
    const approved = await confirmDangerousAction("T1", [full], { canAsk: () => false, confirm: async () => true });
    assert.equal(approved, false);
  });

  test("createHarness keeps audit-log dependency and exposes approvalIO in config", async () => {
    const io: ApprovalIO = { canAsk: () => false, confirm: async () => false };
    const harness = await createHarness({ mode: "on", maxPermission: "workspace", alwaysApprove: [], allowedWritePaths: [], auditLog: false, auditLogPath: "", preTaskHooks: [], postTaskHooks: [], approvalIO: io });
    assert.equal(harness.config.approvalIO, io);
    assert.equal(harness.requiresApproval([full]), true);
  });
});
