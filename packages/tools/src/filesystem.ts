import type { ToolDefinition } from "./types.js";
import type { FileSystem, Shell } from "./io.js";
import { LocalFileSystem, LocalShell } from "./io.js";

export const readFileDef: ToolDefinition = { name: "readFile", description: "Lee el contenido de un archivo. Retorna el texto completo. Si el archivo supera 500 líneas, retorna las primeras 200 con indicador de truncado.", parameters: [{ name: "path", type: "string", description: "Path relativo al proyecto", required: true }], permissionLevel: "read" };
export const writeFileDef: ToolDefinition = { name: "writeFile", description: "Escribe contenido a un archivo. Crea directorios intermedios si no existen.", parameters: [{ name: "path", type: "string", description: "Path relativo al proyecto", required: true }, { name: "content", type: "string", description: "Contenido a escribir", required: true }], permissionLevel: "workspace" };
export const listDirDef: ToolDefinition = { name: "listDir", description: "Lista archivos y directorios en un path.", parameters: [{ name: "path", type: "string", description: "Path relativo al proyecto", required: true }, { name: "recursive", type: "boolean", description: "Incluir subdirectorios recursivamente", required: false }], permissionLevel: "read" };
export const grepDef: ToolDefinition = { name: "grep", description: "Busca un patrón regex en archivos del proyecto. Retorna líneas con matches y sus paths.", parameters: [{ name: "pattern", type: "string", description: "Regex pattern a buscar", required: true }, { name: "glob", type: "string", description: "Glob de archivos a buscar (default: src/**/*.ts)", required: false }], permissionLevel: "read" };

function fileSystem(cwd: string, fs?: FileSystem): FileSystem { return fs ?? new LocalFileSystem(cwd); }
function shell(cwd: string, sh?: Shell): Shell { return sh ?? new LocalShell(cwd); }

export async function readFileExec(args: { path: string }, cwd: string, fs?: FileSystem): Promise<string> {
  const content = await fileSystem(cwd, fs).readFile(args.path);
  const lines = content.split("\n");
  if (lines.length > 500) return lines.slice(0, 200).join("\n") + `\n... [TRUNCADO: ${lines.length} líneas totales, mostrando 200]`;
  return content;
}

export async function writeFileExec(args: { path: string; content: string }, cwd: string, fs?: FileSystem): Promise<string> {
  await fileSystem(cwd, fs).writeFile(args.path, args.content);
  return `Escrito: ${args.path} (${args.content.length} chars)`;
}

export async function listDirExec(args: { path: string; recursive?: boolean }, cwd: string, fs?: FileSystem): Promise<string> {
  const entries = await fileSystem(cwd, fs).listDir(args.path, { recursive: args.recursive, maxDepth: 5 });
  if (entries.length === 0) return "(directorio vacío)";
  return entries.map((entry) => entry.isDirectory ? `${entry.path}/` : entry.path).join("\n");
}

export async function grepExec(args: { pattern: string; glob?: string }, cwd: string, fs?: FileSystem, sh?: Shell): Promise<string> {
  void fs;
  const globPattern = args.glob ?? "src/**/*.ts";
  const include = globPattern.replace("**/*", "*").replace(/"/g, '\\"');
  const pattern = args.pattern.replace(/"/g, '\\"');
  const result = await shell(cwd, sh).exec(`grep -rn --include="${include}" -E "${pattern}" .`, { timeoutMs: 10000 });
  if (result.exitCode === 1) return "(sin matches)";
  if (result.exitCode !== 0) return `(sin matches para: ${args.pattern})`;
  return result.stdout.trim().split("\n").slice(0, 50).join("\n") || "(sin matches)";
}
