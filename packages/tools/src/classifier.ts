import type { CommandClassification, PermissionLevel } from "./types.js";

export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; level: PermissionLevel; reason: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)+/, level: "full", reason: "Borrado recursivo/forzado" },
  { pattern: /sudo/, level: "full", reason: "Elevación de privilegios" },
  { pattern: /chmod\s+[0-7]{3,4}/, level: "full", reason: "Cambio de permisos" },
  { pattern: /git\s+push\s+.*--force/, level: "full", reason: "Push forzado" },
  { pattern: /npm\s+publish/, level: "full", reason: "Publicación a registry" },
  { pattern: /DROP\s+(TABLE|DATABASE)/i, level: "full", reason: "Operación destructiva en DB" },
  { pattern: /shutdown|reboot/, level: "full", reason: "Apagado del sistema" },
  { pattern: /touch|mkdir/, level: "workspace", reason: "Creación de archivos/dirs" },
  { pattern: /sed\s+-i|awk.*>/, level: "workspace", reason: "Edición in-place" },
  { pattern: /npm\s+install/, level: "workspace", reason: "Instalación de dependencias" },
  { pattern: /git\s+(commit|add|checkout|branch)/, level: "workspace", reason: "Operación git local" },
];

export function classifyCommand(command: string): CommandClassification {
  for (const { pattern, level, reason } of DANGEROUS_PATTERNS) {
    const match = command.match(pattern);
    if (match) return { original: command, level, reason, patterns: [match[0]] };
  }
  return { original: command, level: "read", reason: "Sin patrones peligrosos detectados", patterns: [] };
}
