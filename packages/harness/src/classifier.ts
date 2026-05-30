import type { RunOutput } from "@slad/shared";
import type { CommandClassification, PermissionLevel } from "./types.js";

export const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  level: PermissionLevel;
  reason: string;
}> = [
  { pattern: /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)+/, level: "full", reason: "Borrado recursivo/forzado" },
  { pattern: /\bsudo\b/, level: "full", reason: "Elevación de privilegios" },
  { pattern: /\bchmod\s+[0-7]{3,4}/, level: "full", reason: "Cambio de permisos" },
  { pattern: /\bgit\s+push\s+.*--force/, level: "full", reason: "Push forzado" },
  { pattern: /\bnpm\s+publish\b/, level: "full", reason: "Publicación a registry" },
  { pattern: /\bDROP\s+(TABLE|DATABASE)/i, level: "full", reason: "Operación destructiva en DB" },
  { pattern: /\bshutdown\b|\breboot\b/, level: "full", reason: "Apagado del sistema" },
  { pattern: /\btouch\b|\bmkdir\b/, level: "workspace", reason: "Creación de archivos/dirs" },
  { pattern: /\bsed\s+-i\b|\bawk\b.*>/, level: "workspace", reason: "Edición in-place" },
  { pattern: /\bnpm\s+install\b/, level: "workspace", reason: "Instalación de dependencias" },
  { pattern: /\bgit\s+(commit|add|checkout|branch)\b/, level: "workspace", reason: "Operación git local" },
];

export function classifyCommand(command: string): CommandClassification {
  for (const { pattern, level, reason } of DANGEROUS_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      return { original: command, level, reason, patterns: [match[0]] };
    }
  }
  return {
    original: command,
    level: "read",
    reason: "Sin patrones peligrosos detectados",
    patterns: [],
  };
}

export function classifyRunOutput(output: RunOutput): CommandClassification[] {
  return output.verification.map((v) => classifyCommand(v.command));
}

export function highestLevel(classifications: CommandClassification[]): PermissionLevel {
  const order: PermissionLevel[] = ["read", "workspace", "full"];
  let max: PermissionLevel = "read";
  for (const c of classifications) {
    if (order.indexOf(c.level) > order.indexOf(max)) max = c.level;
  }
  return max;
}
