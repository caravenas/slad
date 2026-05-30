import type { ToolDefinition } from "./types.js";
import type { Shell } from "./io.js";
import { LocalShell } from "./io.js";

export const gitStatusDef: ToolDefinition = { name: "gitStatus", description: "Muestra git status --short.", parameters: [], permissionLevel: "read" };
export const gitDiffDef: ToolDefinition = { name: "gitDiff", description: "Muestra git diff.", parameters: [{ name: "staged", type: "boolean", description: "Usar --staged", required: false }], permissionLevel: "read" };
export const gitAddDef: ToolDefinition = { name: "gitAdd", description: "Agrega archivos a git index.", parameters: [{ name: "paths", type: "array", description: "Paths a agregar", required: true }], permissionLevel: "workspace" };
export const gitCommitDef: ToolDefinition = { name: "gitCommit", description: "Crea un commit git.", parameters: [{ name: "message", type: "string", description: "Mensaje de commit", required: true }], permissionLevel: "workspace" };

function getShell(cwd: string, sh?: Shell): Shell { return sh ?? new LocalShell(cwd); }
export async function gitStatusExec(_args: Record<string, unknown>, cwd: string, sh?: Shell): Promise<string> { return (await getShell(cwd, sh).exec("git status --short")).stdout || "(sin cambios)"; }
export async function gitDiffExec(args: { staged?: boolean }, cwd: string, sh?: Shell): Promise<string> { return (await getShell(cwd, sh).exec(args.staged ? "git diff --staged" : "git diff")).stdout || "(sin diff)"; }
export async function gitAddExec(args: { paths: string[] }, cwd: string, sh?: Shell): Promise<string> { const paths = args.paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" "); const r = await getShell(cwd, sh).exec(`git add ${paths}`); return r.exitCode === 0 ? `Agregado: ${args.paths.join(", ")}` : `ERROR (exit ${r.exitCode})\n${r.stderr}`; }
export async function gitCommitExec(args: { message: string }, cwd: string, sh?: Shell): Promise<string> { const msg = args.message.replace(/'/g, "'\\''"); const r = await getShell(cwd, sh).exec(`git commit -m '${msg}'`); return r.exitCode === 0 ? r.stdout : `ERROR (exit ${r.exitCode})\n${r.stderr}\n${r.stdout}`; }
