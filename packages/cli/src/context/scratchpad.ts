import fs from "node:fs";
import path from "node:path";
import type { ScratchpadConfig, ScratchpadEntry } from "./types.js";
import type { ToolCall, ToolResult } from "@slad/tools";

/**
 * Scratchpad — filesystem-backed external memory para tool results.
 *
 * Flujo:
 *  1. Recibe un ToolResult del executor
 *  2. Si el output supera el threshold → escribe a disco, retorna summary
 *  3. Si no supera → retorna el output completo (queda en context)
 *
 * El LLM puede re-leer cualquier scratch file usando readFile() si necesita
 * el contenido completo de nuevo.
 */
export class Scratchpad {
  private entries: ScratchpadEntry[] = [];
  private config: Required<ScratchpadConfig>;
  private sessionDir: string;

  constructor(config: Partial<ScratchpadConfig> = {}, sessionId: string, cwd: string) {
    this.config = {
      scratchDir: config.scratchDir ?? ".slad-os/scratch",
      charThreshold: config.charThreshold ?? 2000,
      lineThreshold: config.lineThreshold ?? 100,
      maxFullRoundsInContext: config.maxFullRoundsInContext ?? 4,
      includeRereadHint: config.includeRereadHint ?? true,
    };
    this.sessionDir = path.join(cwd, this.config.scratchDir, sessionId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  /**
   * Procesa un tool result. Si es largo, lo guarda en scratch y retorna un summary.
   * Si es corto, retorna el output original tal cual.
   */
  processResult(call: ToolCall, result: ToolResult, round: number): string {
    if (!result.success) {
      // Errors siempre van completos en context (suelen ser cortos y críticos)
      return `ERROR: ${result.error ?? "unknown error"}`;
    }

    const output = result.output;
    const lines = output.split("\n").length;
    const chars = output.length;

    // Si no supera threshold → queda en context completo
    if (chars < this.config.charThreshold && lines < this.config.lineThreshold) {
      return output;
    }

    // Supera threshold → escribir a scratch
    const entry = this.writeToScratch(call, output, round);
    this.entries.push(entry);

    // Retornar summary para el context
    const hint = this.config.includeRereadHint
      ? `\n[Para ver el contenido completo: readFile("${entry.filePath}")]`
      : "";

    return `${entry.summary}${hint}`;
  }

  /**
   * Genera un summary inteligente basado en el tipo de tool y contenido.
   */
  summarize(call: ToolCall, output: string): string {
    const lines = output.split("\n");
    const lineCount = lines.length;
    const charCount = output.length;

    switch (call.name) {
      case "readFile": {
        // Para archivos: mostrar primeras líneas + exports/estructura detectada
        const filePath = call.arguments["path"] as string;
        const ext = filePath ? path.extname(filePath) : "";
        const preview = lines.slice(0, 10).join("\n");
        const exports = lines
          .filter((l) => /^export\s/.test(l))
          .map((l) => l.trim().slice(0, 80))
          .slice(0, 8);
        const exportsBlock =
          exports.length
            ? `\nExports detectados:\n${exports.map((e) => `  ${e}`).join("\n")}`
            : "";
        return `[readFile:${filePath}] ${lineCount} líneas, ${charCount} chars (${ext})\nPrimeras líneas:\n${preview}\n...${exportsBlock}`;
      }

      case "exec": {
        // Para comandos: primeras y últimas líneas (errores suelen estar al final)
        const cmd = call.arguments["command"] as string;
        const head = lines.slice(0, 5).join("\n");
        const tail = lines.slice(-5).join("\n");
        const hasError =
          output.toLowerCase().includes("error") || output.includes("ERR");
        const status = hasError ? "CON ERRORES" : "OK";
        return `[exec:${cmd}] ${status}, ${lineCount} líneas output\nInicio:\n${head}\n...\nFinal:\n${tail}`;
      }

      case "grep": {
        const pattern = call.arguments["pattern"] as string;
        const matchCount = lines.filter((l) => l.trim()).length;
        const preview = lines.slice(0, 10).join("\n");
        return `[grep:${pattern}] ${matchCount} matches encontrados\nPrimeros:\n${preview}\n...`;
      }

      case "listDir": {
        const dirPath = call.arguments["path"] as string;
        const fileCount = lines.filter((l) => l.trim()).length;
        const preview = lines.slice(0, 15).join("\n");
        return `[listDir:${dirPath}] ${fileCount} entradas\n${preview}\n...`;
      }

      default: {
        // Genérico: primeras N líneas
        const preview = lines.slice(0, 8).join("\n");
        return `[${call.name}] ${lineCount} líneas, ${charCount} chars\n${preview}\n...`;
      }
    }
  }

  /**
   * Escribe el output completo al scratch y retorna la entry.
   */
  private writeToScratch(call: ToolCall, output: string, round: number): ScratchpadEntry {
    const id = `r${round}-${call.name}-${Date.now()}`;
    const fileName = `${id}.txt`;
    const filePath = path.join(this.sessionDir, fileName);

    // Escribir con metadata header
    const header = [
      `# Scratchpad: ${call.name}`,
      `# Round: ${round}`,
      `# Args: ${JSON.stringify(call.arguments)}`,
      `# Timestamp: ${new Date().toISOString()}`,
      `# ---`,
      "",
    ].join("\n");

    fs.writeFileSync(filePath, header + output, "utf8");

    const summary = this.summarize(call, output);

    // Relative path from project root (2 levels up from sessionDir = .slad-os/scratch/<id>/)
    const relPath = path.relative(
      path.resolve(this.sessionDir, "../.."),
      filePath,
    );

    return {
      id,
      round,
      toolName: call.name,
      args: call.arguments as Record<string, unknown>,
      summary,
      filePath: relPath,
      originalSize: output.length,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Comprime rounds antiguos en el historial de mensajes.
   * Retorna un resumen de los rounds que exceden maxFullRoundsInContext.
   */
  compressOldRounds(currentRound: number): string | null {
    const threshold = this.config.maxFullRoundsInContext;
    const oldEntries = this.entries.filter((e) => e.round <= currentRound - threshold);

    if (oldEntries.length === 0) return null;

    const summary = oldEntries
      .map(
        (e) =>
          `  round ${e.round}: ${e.toolName}(${Object.values(e.args)[0] ?? ""}) → ${e.summary.split("\n")[0]}`,
      )
      .join("\n");

    return `[Contexto de rounds anteriores — ${oldEntries.length} tool calls comprimidos]\n${summary}`;
  }

  /** Retorna todas las entries para el report final */
  getEntries(): ScratchpadEntry[] {
    return [...this.entries];
  }

  /** Limpia archivos scratch de esta sesión */
  cleanup(): void {
    if (fs.existsSync(this.sessionDir)) {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    }
  }
}
