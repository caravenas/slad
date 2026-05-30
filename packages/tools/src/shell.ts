import type { ToolDefinition } from "./types.js";
import type { Shell } from "./io.js";
import { LocalShell } from "./io.js";

export const execDef: ToolDefinition = { name: "exec", description: "Ejecuta un comando shell en el directorio del proyecto. Timeout 30s. El harness clasifica el nivel de riesgo real del comando.", parameters: [{ name: "command", type: "string", description: "Comando a ejecutar", required: true }, { name: "timeout", type: "number", description: "Timeout en ms (default 30000)", required: false }], permissionLevel: "full" };

export async function execExec(args: { command: string; timeout?: number }, cwd: string, sh?: Shell): Promise<string> {
  const shell = sh ?? new LocalShell(cwd);
  const result = await shell.exec(args.command, { timeoutMs: args.timeout ?? 30000 });
  if (result.exitCode === 0) return result.stdout || "(sin output)";
  const parts = [`ERROR (exit ${result.exitCode})`, result.stderr ? `stderr: ${result.stderr}` : null, result.stdout ? `stdout: ${result.stdout}` : null].filter(Boolean);
  return parts.join("\n");
}
