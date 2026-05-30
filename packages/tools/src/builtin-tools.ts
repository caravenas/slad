import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { LocalFileSystem, LocalShell } from "./io.js";
import type { FileSystem, Shell } from "./io.js";

// ─── IO helpers (kept internal) ──────────────────────────────────────────────

function resolveFs(cwd: string, external?: FileSystem): FileSystem {
  return external ?? new LocalFileSystem(cwd);
}

function resolveShell(cwd: string, external?: Shell): Shell {
  return external ?? new LocalShell(cwd);
}

// ─── fs.readFile ─────────────────────────────────────────────────────────────

export const readFileTool = defineTool({
  id: "fs.readFile",
  provider: "local-fs",
  description: "Lee el contenido de un archivo. Retorna el texto completo. Si supera 500 líneas, trunca a 200.",

  permissions: ["workspace:read"],

  input: z.object({
    path: z.string().describe("Path relativo al proyecto"),
  }),

  output: z.object({
    content: z.string(),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    const fs = resolveFs(ctx.workspace.root);
    const content = await fs.readFile(input.path);
    const lines = content.split("\n");
    const result = lines.length > 500
      ? lines.slice(0, 200).join("\n") + `\n... [TRUNCADO: ${lines.length} líneas totales, mostrando 200]`
      : content;
    return { content: result };
  },
});

// ─── fs.writeFile ────────────────────────────────────────────────────────────

export const writeFileTool = defineTool({
  id: "fs.writeFile",
  provider: "local-fs",
  description: "Escribe contenido a un archivo. Crea directorios intermedios si no existen.",

  permissions: ["workspace:write"],

  input: z.object({
    path: z.string().describe("Path relativo al proyecto"),
    content: z.string().describe("Contenido a escribir"),
  }),

  output: z.object({
    written: z.string(),
    bytes: z.number(),
  }),

  risk: "medium",
  requiresApproval: false,

  async run(ctx, input) {
    await ctx.harness.assertPermission("workspace:write");
    const fs = resolveFs(ctx.workspace.root);
    await fs.writeFile(input.path, input.content);
    ctx.audit.emit("tool.file.written", { path: input.path, bytes: input.content.length });
    return { written: input.path, bytes: input.content.length };
  },
});

// ─── fs.listDir ──────────────────────────────────────────────────────────────

export const listDirTool = defineTool({
  id: "fs.listDir",
  provider: "local-fs",
  description: "Lista archivos y directorios en un path.",

  permissions: ["workspace:read"],

  input: z.object({
    path: z.string().describe("Path relativo al proyecto"),
    recursive: z.boolean().optional().default(false).describe("Incluir subdirectorios"),
    maxDepth: z.number().optional().default(5).describe("Profundidad máxima"),
  }),

  output: z.object({
    entries: z.array(z.object({
      path: z.string(),
      isDirectory: z.boolean(),
    })),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    const fs = resolveFs(ctx.workspace.root);
    const entries = await fs.listDir(input.path, { recursive: input.recursive, maxDepth: input.maxDepth });
    return { entries };
  },
});

// ─── fs.grep ─────────────────────────────────────────────────────────────────

export const grepTool = defineTool({
  id: "fs.grep",
  provider: "local-fs",
  description: "Busca un patrón regex en archivos del proyecto. Retorna líneas con matches.",

  permissions: ["workspace:read"],

  input: z.object({
    pattern: z.string().describe("Regex pattern a buscar"),
    glob: z.string().optional().default("src/**/*.ts").describe("Glob de archivos"),
  }),

  output: z.object({
    matches: z.string(),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    const sh = resolveShell(ctx.workspace.root);
    const include = input.glob.replace("**/*", "*").replace(/"/g, '\\"');
    const pattern = input.pattern.replace(/"/g, '\\"');
    const result = await sh.exec(`grep -rn --include="${include}" -E "${pattern}" .`, { timeoutMs: 10000 });
    if (result.exitCode === 1 || result.exitCode !== 0) return { matches: "(sin matches)" };
    return { matches: result.stdout.trim().split("\n").slice(0, 50).join("\n") || "(sin matches)" };
  },
});

// ─── shell.exec ──────────────────────────────────────────────────────────────

export const shellExecTool = defineTool({
  id: "shell.exec",
  provider: "local-shell",
  description: "Ejecuta un comando shell en el directorio del proyecto.",

  permissions: ["process:exec", "workspace:write"],

  input: z.object({
    command: z.string().describe("Comando a ejecutar"),
    cwd: z.string().optional().describe("Working directory (default: workspace root)"),
    timeoutMs: z.number().optional().default(30_000).describe("Timeout en ms"),
  }),

  output: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }),

  risk: "high",
  requiresApproval: true,

  async run(ctx, input) {
    await ctx.harness.assertPermission("process:exec");
    const sh = resolveShell(input.cwd ?? ctx.workspace.root);
    const result = await sh.exec(input.command, { timeoutMs: input.timeoutMs });

    ctx.audit.emit("tool.executed", {
      toolId: "shell.exec",
      command: input.command,
      exitCode: result.exitCode,
    });

    return result;
  },
});

// ─── git.status ──────────────────────────────────────────────────────────────

export const gitStatusTool = defineTool({
  id: "git.status",
  provider: "git",
  description: "Muestra el estado actual de git (archivos modificados, staged, untracked).",

  permissions: ["workspace:read"],

  input: z.object({
    cwd: z.string().optional().describe("Working directory"),
  }),

  output: z.object({
    status: z.string(),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    const sh = resolveShell(input.cwd ?? ctx.workspace.root);
    const result = await sh.exec("git status --short");
    return { status: result.stdout || "(sin cambios)" };
  },
});

// ─── git.diff ────────────────────────────────────────────────────────────────

export const gitDiffTool = defineTool({
  id: "git.diff",
  provider: "git",
  description: "Muestra el diff de cambios (staged o unstaged).",

  permissions: ["workspace:read"],

  input: z.object({
    cwd: z.string().optional().describe("Working directory"),
    staged: z.boolean().optional().default(false).describe("Mostrar diff staged"),
  }),

  output: z.object({
    diff: z.string(),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    const sh = resolveShell(input.cwd ?? ctx.workspace.root);
    const cmd = input.staged ? "git diff --staged" : "git diff";
    const result = await sh.exec(cmd);
    const output = result.stdout || "(sin diff)";
    const lines = output.split("\n");
    return { diff: lines.length > 200 ? lines.slice(0, 200).join("\n") + `\n... [TRUNCADO: ${lines.length} líneas]` : output };
  },
});

// ─── git.add ─────────────────────────────────────────────────────────────────

export const gitAddTool = defineTool({
  id: "git.add",
  provider: "git",
  description: "Hace git add de archivos para staging.",

  permissions: ["workspace:write"],

  input: z.object({
    cwd: z.string().optional().describe("Working directory"),
    paths: z.array(z.string()).describe("Archivos a stagear (o ['.'] para todos)"),
  }),

  output: z.object({
    added: z.string(),
  }),

  risk: "low",
  requiresApproval: false,

  async run(ctx, input) {
    await ctx.harness.assertPermission("workspace:write");
    const sh = resolveShell(input.cwd ?? ctx.workspace.root);
    const paths = input.paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
    const result = await sh.exec(`git add ${paths}`);
    if (result.exitCode !== 0) throw new Error(`git add failed (exit ${result.exitCode}): ${result.stderr}`);
    ctx.audit.emit("tool.git.add", { paths: input.paths });
    return { added: input.paths.join(", ") };
  },
});

// ─── git.commit ──────────────────────────────────────────────────────────────

export const gitCommitTool = defineTool({
  id: "git.commit",
  provider: "git",
  description: "Crea un commit git local. No hace push.",

  permissions: ["workspace:write"],

  input: z.object({
    cwd: z.string().optional().describe("Working directory"),
    message: z.string().describe("Mensaje del commit"),
  }),

  output: z.object({
    result: z.string(),
  }),

  risk: "medium",
  requiresApproval: false,

  async run(ctx, input) {
    await ctx.harness.assertPermission("workspace:write");
    const sh = resolveShell(input.cwd ?? ctx.workspace.root);
    const msg = input.message.replace(/'/g, "'\\''");
    const r = await sh.exec(`git commit -m '${msg}'`);
    ctx.audit.emit("tool.git.commit", { message: input.message, exitCode: r.exitCode });
    if (r.exitCode !== 0) throw new Error(`git commit failed (exit ${r.exitCode}): ${r.stderr}\n${r.stdout}`);
    return { result: r.stdout };
  },
});

// ─── Convenience exports ─────────────────────────────────────────────────────

/** All built-in tools as an array, ready for createAgent({ tools: [...builtinTools] }) */
export const builtinTools = [
  readFileTool,
  writeFileTool,
  listDirTool,
  grepTool,
  shellExecTool,
  gitStatusTool,
  gitDiffTool,
  gitAddTool,
  gitCommitTool,
] as const;
