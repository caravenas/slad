import { execSync } from "node:child_process";
import type { ToolDefinition } from "../types.js";

function run(cmd: string, cwd: string, timeout = 15000): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || "(sin output)";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || "git error");
  }
}

export const gitStatusDef: ToolDefinition = {
  name: "gitStatus",
  description: "Muestra el estado actual de git (archivos modificados, staged, untracked).",
  parameters: [],
  permissionLevel: "read",
};

export async function gitStatusExec(_args: Record<string, unknown>, cwd: string): Promise<string> {
  return run("git status --short", cwd);
}

export const gitDiffDef: ToolDefinition = {
  name: "gitDiff",
  description: "Muestra el diff de cambios no staged (o de un archivo específico).",
  parameters: [
    { name: "file", type: "string", description: "Path del archivo (opcional, default: todos)", required: false },
    { name: "staged", type: "boolean", description: "Mostrar diff staged (default: false)", required: false },
  ],
  permissionLevel: "read",
};

export async function gitDiffExec(args: { file?: string; staged?: boolean }, cwd: string): Promise<string> {
  const staged = args.staged ? "--cached" : "";
  const file = args.file ? `-- "${args.file}"` : "";
  const output = run(`git diff ${staged} ${file}`.trim(), cwd);
  const lines = output.split("\n");
  if (lines.length > 200) return lines.slice(0, 200).join("\n") + `\n... [TRUNCADO: ${lines.length} líneas]`;
  return output;
}

export const gitAddDef: ToolDefinition = {
  name: "gitAdd",
  description: "Hace git add de archivos para staging. Usa '.' para agregar todos los cambios.",
  parameters: [{ name: "files", type: "string", description: "Archivos a stagear (espacio-separados o '.' para todos)", required: true }],
  permissionLevel: "workspace",
};

export async function gitAddExec(args: { files: string }, cwd: string): Promise<string> {
  run(`git add ${args.files}`, cwd);
  return run("git status --short", cwd);
}

export const gitCommitDef: ToolDefinition = {
  name: "gitCommit",
  description: "Hace un commit local con el mensaje dado. No hace push.",
  parameters: [{ name: "message", type: "string", description: "Mensaje del commit", required: true }],
  permissionLevel: "workspace",
};

export async function gitCommitExec(args: { message: string }, cwd: string): Promise<string> {
  return run(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, cwd);
}
