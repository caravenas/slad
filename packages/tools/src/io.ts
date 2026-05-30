import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface ShellExecOptions { timeoutMs?: number; }
export interface ShellResult { stdout: string; stderr: string; exitCode: number; }
export interface Shell { exec(command: string, options?: ShellExecOptions): Promise<ShellResult>; }

export interface DirectoryEntry { path: string; isDirectory: boolean; }
export interface FileSystem {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listDir(relativePath: string, options?: { recursive?: boolean; maxDepth?: number }): Promise<DirectoryEntry[]>;
}

export class LocalFileSystem implements FileSystem {
  constructor(readonly cwd: string) {}

  resolveSafe(relativePath: string): string {
    const root = path.resolve(this.cwd);
    const fullPath = path.resolve(root, relativePath);
    if (!fullPath.startsWith(root + path.sep) && fullPath !== root) throw new Error(`Path traversal detectado: ${relativePath}`);
    return fullPath;
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) throw new Error(`Archivo no existe: ${relativePath}`);
    return fs.readFileSync(fullPath, "utf8");
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafe(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  async exists(relativePath: string): Promise<boolean> {
    return fs.existsSync(this.resolveSafe(relativePath));
  }

  async listDir(relativePath: string, options: { recursive?: boolean; maxDepth?: number } = {}): Promise<DirectoryEntry[]> {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) throw new Error(`Directorio no existe: ${relativePath}`);
    const maxDepth = options.maxDepth ?? 5;
    const recursive = options.recursive ?? false;
    const walk = (dir: string, base: string, depth: number): DirectoryEntry[] => {
      if (depth > maxDepth) return [{ path: "... [MAX DEPTH]", isDirectory: false }];
      const result: DirectoryEntry[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = path.join(base, entry.name);
        result.push({ path: rel, isDirectory: entry.isDirectory() });
        if (entry.isDirectory() && recursive) result.push(...walk(path.join(dir, entry.name), rel, depth + 1));
      }
      return result;
    };
    return walk(fullPath, "", 0);
  }
}

export class LocalShell implements Shell {
  constructor(readonly cwd: string) {}

  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellResult> {
    try {
      const stdout = execSync(command, { cwd: this.cwd, encoding: "utf8", timeout: options.timeoutMs ?? 30000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
      return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? "", exitCode: e.status ?? 1 };
    }
  }
}
