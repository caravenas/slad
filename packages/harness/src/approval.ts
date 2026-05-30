import { confirm } from "@inquirer/prompts";
import kleur from "kleur";
import type { ApprovalIO, CommandClassification } from "./types.js";

export class TTYApprovalIO implements ApprovalIO {
  canAsk(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  async confirm(request: {
    taskId: string;
    dangerous: CommandClassification[];
    classifications: CommandClassification[];
  }): Promise<boolean> {
    console.log("");
    console.log(kleur.bold().red(`⚠ ${request.taskId} · Acción de alto riesgo detectada`));
    for (const c of request.dangerous) {
      console.log(kleur.red(`  ● ${c.reason}: `) + kleur.dim(c.original));
    }
    console.log("");

    return confirm({
      message: `¿Autorizás la ejecución de ${request.dangerous.length} acción(es) de nivel Full?`,
      default: false,
    });
  }
}

export function createTTYApprovalIO(): ApprovalIO {
  return new TTYApprovalIO();
}

const defaultApprovalIO = createTTYApprovalIO();

export async function confirmDangerousAction(
  taskId: string,
  classifications: CommandClassification[],
  approvalIO: ApprovalIO = defaultApprovalIO,
): Promise<boolean> {
  const dangerous = classifications.filter((c) => c.level === "full");
  if (dangerous.length === 0) return true;

  if (!approvalIO.canAsk()) {
    console.log(kleur.dim("  Entorno no interactivo detectado; se rechaza por defecto."));
    return false;
  }

  return approvalIO.confirm({ taskId, dangerous, classifications });
}
