import type { ToolCall, ToolResult, ApprovalGate, ApprovalIO, CommandClassification, PermissionLevel } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import { classifyCommand } from "./classifier.js";

export interface ExecutorOpts {
  cwd: string;
  harness: ApprovalGate | null;
  dryRun?: boolean;
  approvalIO?: ApprovalIO;
}

export class ToolExecutor {
  constructor(private registry: ToolRegistry, private opts: ExecutorOpts) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) return { toolCallId: call.id, success: false, output: "", error: `Tool no encontrada: ${call.name}` };

    const classification = this.classifyToolCall(call, tool.definition.permissionLevel);
    if (this.opts.harness && this.opts.harness.requiresApproval([classification])) {
      if (this.opts.dryRun) {
        return {
          toolCallId: call.id,
          success: false,
          output: "",
          error: `[dry-run] Bloqueado: ${call.name} requiere aprobación (nivel ${classification.level})`,
        };
      }
      const approved = await this.requestApproval(`tool:${call.name}`, [classification]);
      if (!approved) return { toolCallId: call.id, success: false, output: "", error: `Rechazado por el usuario: ${call.name}` };
    }

    try {
      const output = await tool.execute(call.arguments as Record<string, unknown>, this.opts.cwd);
      return { toolCallId: call.id, success: true, output };
    } catch (err) {
      return { toolCallId: call.id, success: false, output: "", error: (err as Error).message };
    }
  }

  private async requestApproval(taskId: string, classifications: CommandClassification[]): Promise<boolean> {
    const approvalIO = this.opts.approvalIO as
      | ApprovalIO
      | { canAsk(): boolean; confirm(request: { taskId: string; dangerous: CommandClassification[]; classifications: CommandClassification[] }): Promise<boolean> }
      | undefined;
    if (!approvalIO) return false;
    if ("requestApproval" in approvalIO) return approvalIO.requestApproval({ taskId, classifications });
    const dangerous = classifications.filter((c) => c.level === "full");
    if (dangerous.length === 0) return true;
    if (!approvalIO.canAsk()) return false;
    return approvalIO.confirm({ taskId, dangerous, classifications });
  }

  private classifyToolCall(call: ToolCall, baseLevel: PermissionLevel): CommandClassification {
    if (call.name === "exec" && typeof call.arguments.command === "string") return classifyCommand(call.arguments.command);
    return {
      original: `${call.name}(${JSON.stringify(call.arguments)})`,
      level: baseLevel,
      reason: `Tool ${call.name} (permissionLevel: ${baseLevel})`,
      patterns: [],
    };
  }
}
