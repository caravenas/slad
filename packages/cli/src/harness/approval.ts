export * from "@slad/harness";

import { confirmDangerousAction } from "@slad/harness";
import type { CommandClassification } from "@slad/tools";

export function createTTYApprovalIO(): {
  requestApproval(request: { taskId: string; classifications: CommandClassification[] }): Promise<boolean>;
} {
  return {
    async requestApproval(request) {
      return confirmDangerousAction(request.taskId, request.classifications);
    },
  };
}
