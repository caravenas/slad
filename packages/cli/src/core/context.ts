import fs from "node:fs";
import path from "node:path";
import { generateInventory } from "./inventory.js";
import type { ProjectInventory } from "./types.js";

const CONTEXT_FILE = "AGENTS.md";
const MAX_CHARS = 8000;

export function readProjectContext(cwd?: string): string | null {
  const filePath = path.join(cwd ?? process.cwd(), CONTEXT_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, MAX_CHARS);
  } catch {
    return null;
  }
}

function formatInventory(cwd?: string): string {
  try {
    const inv: ProjectInventory = generateInventory(cwd);
    const sections: string[] = ["## Project Inventory (auto-generated)\n"];

    // Providers
    sections.push("### Providers");
    for (const p of inv.providers) {
      sections.push(`- **${p.name}** (${p.type}) — ${p.file}`);
      for (const d of p.details) {
        sections.push(`  - ${d}`);
      }
    }

    // Commands
    sections.push("\n### Commands");
    for (const c of inv.commands) {
      const hitl = c.hasHitl ? " [HITL]" : "";
      const schemas = [c.inputSchema, c.outputSchema].filter(Boolean).join(" → ");
      sections.push(`- **${c.name}**${hitl} — ${c.file}${schemas ? ` (${schemas})` : ""}`);
    }

    // Schemas
    sections.push("\n### Schemas");
    for (const s of inv.schemas) {
      sections.push(`- **${s.name}**: ${s.fields.join(", ")}`);
    }

    // Infrastructure
    const cacheStatus = inv.cacheSystem.enabled
      ? `enabled (${inv.cacheSystem.strategy})`
      : "disabled";
    const harnessStatus = inv.harness.enabled
      ? `enabled (modes: ${inv.harness.modes.join(", ")})`
      : "disabled";

    sections.push(`\n### Infrastructure`);
    sections.push(`- Cache: ${cacheStatus}`);
    sections.push(`- Harness: ${harnessStatus}`);

    return sections.join("\n");
  } catch {
    return "";
  }
}

export function projectContextBlock(cwd?: string): string {
  const ctx = readProjectContext(cwd);
  const inv = formatInventory(cwd);
  const parts = [
    ctx ? `Project context (AGENTS.md):\n\n${ctx}` : "",
    inv,
  ].filter(Boolean);
  return parts.join("\n\n");
}
