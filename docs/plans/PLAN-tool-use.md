# Plan: Tool Use / Code Execution Bridge

## Objetivo

Convertir `slad run` de un sistema advisory (produce JSON describiendo qué haría) a un sistema autónomo que ejecuta código real — lee archivos, escribe archivos, corre comandos — todo pasando por el Harness como safety layer.

## Contexto Arquitectónico

Actualmente:
- `ModelProvider.complete()` retorna `string` (texto plano del LLM)
- El Builder agent produce un `RunOutput` JSON describiendo lo que haría
- El Harness clasifica los `verification[].command` post-facto pero no intercepta ejecución real

Después de este feature:
- `ModelProvider` soporta `completeWithTools()` que maneja el loop tool_use
- El Builder agent puede invocar tools (readFile, writeFile, exec, etc.) durante la generación
- Cada tool call pasa por el Harness ANTES de ejecutar
- El output final sigue siendo un `RunOutput` validado por Zod

## Diseño

### Nuevos archivos a crear

```
src/
  tools/
    types.ts           # ToolDefinition, ToolCall, ToolResult schemas
    registry.ts        # Tool registry (registro de tools disponibles)
    executor.ts        # Tool executor con harness integration
    definitions/
      filesystem.ts    # readFile, writeFile, listDir, grep
      shell.ts         # exec (sandboxed)
      git.ts           # gitStatus, gitDiff, gitAdd, gitCommit
  models/
    tool-loop.ts       # Generic tool-use loop (provider-agnostic)
```

### Archivos a modificar

```
src/models/index.ts       # Agregar completeWithTools() a ModelProvider
src/models/anthropic.ts   # Implementar tool_use con Anthropic SDK
src/models/openai.ts      # Implementar function_calling con OpenAI SDK
src/commands/run.ts        # Usar completeWithTools() cuando tools habilitado
src/core/types.ts          # Agregar ToolCall/ToolResult a schemas
src/agents/prompts.ts      # Actualizar BUILDER_REVIEWER_SYSTEM con instrucciones de tools
src/harness/classifier.ts  # Clasificar tool calls (no solo verification strings)
src/harness/types.ts       # Agregar ToolCallClassification
```

---

## Tareas de Implementación (en orden)

### T1: Tool Types & Schemas (`src/tools/types.ts`)

Crear los tipos base:

```typescript
import { z } from "zod";

export const ToolParameter = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "array"]),
  description: z.string(),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
});
export type ToolParameter = z.infer<typeof ToolParameter>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(ToolParameter),
  /** Permission level required to execute this tool */
  permissionLevel: z.enum(["read", "workspace", "full"]),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  toolCallId: z.string(),
  success: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

/** What the provider returns when it wants to use a tool */
export interface ProviderToolResponse {
  type: "tool_use";
  toolCalls: ToolCall[];
  /** Partial text before/after tool calls (for Anthropic's mixed content) */
  textParts: string[];
}

/** What the provider returns when it's done (final text) */
export interface ProviderTextResponse {
  type: "text";
  content: string;
}

export type ProviderResponse = ProviderToolResponse | ProviderTextResponse;
```

**Criterio de aceptación:** `npm run typecheck` pasa. Schemas exportados correctamente.

---

### T2: Tool Definitions (`src/tools/definitions/`)

Implementar las herramientas concretas. Cada una exporta un `ToolDefinition` + una función `execute`.

#### `src/tools/definitions/filesystem.ts`

```typescript
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

export const readFileDef: ToolDefinition = {
  name: "readFile",
  description: "Lee el contenido de un archivo. Retorna el texto completo.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
  ],
  permissionLevel: "read",
};

export async function readFileExec(args: { path: string }, cwd: string): Promise<string> {
  const fullPath = path.resolve(cwd, args.path);
  // Seguridad: no salir del cwd
  if (!fullPath.startsWith(path.resolve(cwd))) {
    throw new Error(`Path traversal detectado: ${args.path}`);
  }
  return fs.readFileSync(fullPath, "utf8");
}

export const writeFileDef: ToolDefinition = {
  name: "writeFile",
  description: "Escribe contenido a un archivo. Crea directorios intermedios si no existen.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
    { name: "content", type: "string", description: "Contenido a escribir", required: true },
  ],
  permissionLevel: "workspace",
};

export async function writeFileExec(args: { path: string; content: string }, cwd: string): Promise<string> {
  const fullPath = path.resolve(cwd, args.path);
  if (!fullPath.startsWith(path.resolve(cwd))) {
    throw new Error(`Path traversal detectado: ${args.path}`);
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, args.content, "utf8");
  return `Escrito: ${args.path} (${args.content.length} chars)`;
}

export const listDirDef: ToolDefinition = {
  name: "listDir",
  description: "Lista archivos y directorios en un path.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
    { name: "recursive", type: "boolean", description: "Incluir subdirectorios", required: false },
  ],
  permissionLevel: "read",
};

export const grepDef: ToolDefinition = {
  name: "grep",
  description: "Busca un patrón regex en archivos del proyecto.",
  parameters: [
    { name: "pattern", type: "string", description: "Regex pattern", required: true },
    { name: "glob", type: "string", description: "Glob de archivos (default: **/*.ts)", required: false },
  ],
  permissionLevel: "read",
};
```

#### `src/tools/definitions/shell.ts`

```typescript
import { execSync } from "node:child_process";
import type { ToolDefinition } from "../types.js";

export const execDef: ToolDefinition = {
  name: "exec",
  description: "Ejecuta un comando shell en el directorio del proyecto. Timeout 30s.",
  parameters: [
    { name: "command", type: "string", description: "Comando a ejecutar", required: true },
    { name: "timeout", type: "number", description: "Timeout en ms (default 30000)", required: false },
  ],
  permissionLevel: "full", // Default full; el harness puede downgradear si el comando es safe
};

export async function execExec(args: { command: string; timeout?: number }, cwd: string): Promise<string> {
  const timeout = args.timeout ?? 30000;
  try {
    const output = execSync(args.command, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024, // 1MB
    });
    return output.trim() || "(sin output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `ERROR: ${e.stderr || e.message || "unknown"}\n${e.stdout || ""}`.trim();
  }
}
```

#### `src/tools/definitions/git.ts`

```typescript
// gitStatus, gitDiff, gitAdd, gitCommit
// Todos con permissionLevel "workspace" excepto gitStatus/gitDiff que son "read"
```

**Criterio de aceptación:** Cada herramienta tiene un `.test.ts` que valida path traversal prevention y ejecución básica.

---

### T3: Tool Registry (`src/tools/registry.ts`)

```typescript
import type { ToolDefinition, ToolCall, ToolResult } from "./types.js";

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

/** Factory que crea el registry con todas las tools built-in */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // ... registrar todas las tools de definitions/
  return registry;
}
```

**Criterio de aceptación:** `createDefaultRegistry()` retorna un registry con todas las tools built-in registradas.

---

### T4: Tool Executor con Harness (`src/tools/executor.ts`)

Este es el puente crítico entre tool calls y ejecución real:

```typescript
import type { ToolCall, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ExecutionHarness } from "../harness/types.js";
import { classifyCommand } from "../harness/classifier.js";
import { confirmDangerousAction } from "../harness/approval.js";

export interface ExecutorOpts {
  cwd: string;
  harness: ExecutionHarness | null;
  /** Si true, no pide aprobación (dry-run mode) */
  dryRun?: boolean;
}

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private opts: ExecutorOpts,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return { toolCallId: call.id, success: false, output: "", error: `Tool no encontrada: ${call.name}` };
    }

    // 1. Clasificar la tool call
    if (this.opts.harness) {
      const classification = this.classifyToolCall(call, tool.definition.permissionLevel);

      // 2. Si requiere aprobación, preguntar
      if (this.opts.harness.requiresApproval([classification])) {
        if (this.opts.dryRun) {
          return { toolCallId: call.id, success: false, output: "", error: `[dry-run] Bloqueado: ${call.name} requiere aprobación` };
        }
        const approved = await confirmDangerousAction(call.name, [classification]);
        if (!approved) {
          return { toolCallId: call.id, success: false, output: "", error: `Rechazado por el usuario: ${call.name}` };
        }
      }
    }

    // 3. Ejecutar
    try {
      const output = await tool.execute(call.arguments as Record<string, unknown>, this.opts.cwd);
      return { toolCallId: call.id, success: true, output };
    } catch (err) {
      return { toolCallId: call.id, success: false, output: "", error: (err as Error).message };
    }
  }

  private classifyToolCall(call: ToolCall, baseLevel: string) {
    // Para "exec", reclasificar según el contenido del comando
    if (call.name === "exec" && typeof call.arguments.command === "string") {
      return classifyCommand(call.arguments.command);
    }
    return { original: `${call.name}(${JSON.stringify(call.arguments)})`, level: baseLevel as any, reason: `Tool ${call.name}`, patterns: [] };
  }
}
```

**Criterio de aceptación:** Test que verifica: (1) tool read ejecuta sin harness, (2) tool workspace se bloquea en strict mode sin aprobación, (3) path traversal retorna error.

---

### T5: Extender ModelProvider (`src/models/index.ts` + providers)

Agregar método opcional `completeWithTools`:

```typescript
// En src/models/index.ts:
export interface ToolUseOptions extends CompletionOptions {
  tools: ToolDefinition[];
}

export interface ModelProvider {
  readonly name: ProviderName;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
  /** Optional: providers that support tool use implement this */
  completeWithTools?(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse>;
  /** Whether this provider supports tool use */
  supportsToolUse?: boolean;
}
```

#### Anthropic (`src/models/anthropic.ts`)

Agregar `completeWithTools` usando el SDK nativo de Anthropic que ya soporta `tools`:

```typescript
async completeWithTools(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse> {
  const system = opts.systemPrompt ?? undefined;
  const chat = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Convertir ToolDefinition[] a formato Anthropic
  const tools = opts.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        t.parameters.map(p => [p.name, { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])
      ),
      required: t.parameters.filter(p => p.required).map(p => p.name),
    },
  }));

  const res = await this.client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.2,
    ...(system ? { system } : {}),
    messages: chat,
    tools,
  });

  // Parse response: puede ser text, tool_use, o mix
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const block of res.content) {
    if (block.type === "text") textParts.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input as Record<string, unknown> });
    }
  }

  if (toolCalls.length > 0) {
    return { type: "tool_use", toolCalls, textParts };
  }
  return { type: "text", content: textParts.join("\n").trim() };
}

get supportsToolUse() { return true; }
```

#### OpenAI (`src/models/openai.ts`)

Similar pero con `functions` / `tools` de OpenAI:

```typescript
async completeWithTools(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse> {
  const tools = opts.tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          t.parameters.map(p => [p.name, { type: p.type, description: p.description }])
        ),
        required: t.parameters.filter(p => p.required).map(p => p.name),
      },
    },
  }));

  const res = await this.client.chat.completions.create({
    model: opts.model ?? DEFAULT_MODEL,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [...],
    tools,
  });

  // Parse tool_calls from response
  const choice = res.choices[0];
  if (choice?.message?.tool_calls?.length) {
    return {
      type: "tool_use",
      toolCalls: choice.message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
      textParts: choice.message.content ? [choice.message.content] : [],
    };
  }
  return { type: "text", content: choice?.message?.content?.trim() ?? "" };
}
```

**Criterio de aceptación:** `npm run typecheck` pasa. Interface backward-compatible (complete() sigue funcionando igual).

---

### T6: Tool Loop genérico (`src/models/tool-loop.ts`)

El loop que orquesta: LLM → tool_use → execute → result → LLM → ... → text final.

```typescript
import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage } from "../core/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ProviderResponse, ToolResult } from "../tools/types.js";
import { log } from "../core/logger.js";

export interface ToolLoopOpts extends ToolUseOptions {
  maxToolRounds?: number; // default 10
  onToolCall?: (name: string, args: Record<string, unknown>) => void; // callback para UI
  onToolResult?: (name: string, result: ToolResult) => void;
}

export async function toolLoop(
  provider: ModelProvider,
  messages: ChatMessage[],
  executor: ToolExecutor,
  opts: ToolLoopOpts,
): Promise<string> {
  if (!provider.completeWithTools) {
    // Fallback: provider sin tool use → complete normal
    return provider.complete(messages, opts);
  }

  const maxRounds = opts.maxToolRounds ?? 10;
  let currentMessages = [...messages];
  let rounds = 0;

  while (rounds < maxRounds) {
    const response: ProviderResponse = await provider.completeWithTools(currentMessages, opts);

    if (response.type === "text") {
      return response.content;
    }

    // Process tool calls
    const results: ToolResult[] = [];
    for (const call of response.toolCalls) {
      opts.onToolCall?.(call.name, call.arguments);
      const result = await executor.execute(call);
      results.push(result);
      opts.onToolResult?.(call.name, result);
    }

    // Append assistant message with tool calls + tool results to messages
    // (format depends on provider — this is the Anthropic format)
    currentMessages.push({
      role: "assistant",
      content: formatToolCallsAsAssistant(response), // serialización para el historial
    });
    currentMessages.push({
      role: "user",
      content: formatToolResults(results), // tool results como user message
    });

    rounds++;
  }

  // Si se agotan los rounds, pedir al LLM que cierre sin tools
  log.warn(`Tool loop: max ${maxRounds} rounds alcanzados, cerrando...`);
  return provider.complete(currentMessages, opts);
}
```

**Nota importante:** El formato de mensajes para tool results difiere entre Anthropic y OpenAI. Necesitarás un adapter por provider. Anthropic usa `tool_result` content blocks, OpenAI usa mensajes con `role: "tool"`.

Una opción más limpia: que `completeWithTools` reciba un callback `executeToolCall` y maneje el loop internamente (cada provider sabe su formato). Esto mueve la complejidad al provider pero simplifica el consumidor.

**Criterio de aceptación:** Test con mock provider que simula 2 rounds de tool_use → text final.

---

### T7: Integrar en `run.ts`

Modificar `executeTask` para usar tool loop cuando el provider lo soporte:

```typescript
// En executeTask(), reemplazar la llamada a provider.complete():

import { toolLoop } from "../models/tool-loop.js";
import { ToolExecutor } from "../tools/executor.js";
import { createDefaultRegistry } from "../tools/registry.js";

// Dentro de executeTask:
const registry = createDefaultRegistry();
const executor = new ToolExecutor(registry, {
  cwd: process.cwd(),
  harness,
});

// Reemplazar:
// raw = await provider.complete(messages, { ... });
// Con:
if (provider.supportsToolUse) {
  raw = await toolLoop(provider, messages, executor, {
    systemPrompt: BUILDER_REVIEWER_SYSTEM,
    temperature: 0.2,
    maxTokens: 4096,
    model,
    tools: registry.definitions(),
    maxToolRounds: 10,
    onToolCall: (name, args) => {
      spinner.text = `${task.id} · ${name}(${Object.values(args)[0] ?? ""})`;
    },
  });
} else {
  raw = await provider.complete(messages, { ... });
}
```

**Criterio de aceptación:** `slad run --task T1` con Anthropic provider ejecuta tools reales. Fallback a complete() si el provider no soporta tools.

---

### T8: Actualizar BUILDER_REVIEWER_SYSTEM prompt

Agregar instrucciones de tools al system prompt del Builder:

```typescript
// Append al BUILDER_REVIEWER_SYSTEM:
const TOOL_USE_INSTRUCTIONS = `
## Herramientas disponibles

Tienes acceso a herramientas para implementar la tarea directamente:
- readFile(path): Lee un archivo del proyecto
- writeFile(path, content): Escribe o crea un archivo
- listDir(path, recursive?): Lista contenido de un directorio
- grep(pattern, glob?): Busca texto en archivos
- exec(command, timeout?): Ejecuta un comando shell
- gitStatus(): Estado actual de git
- gitDiff(file?): Diff de cambios
- gitAdd(files): Stage archivos
- gitCommit(message): Commit local

Reglas de uso de herramientas:
- SIEMPRE lee los archivos relevantes antes de escribir (para no pisar contexto).
- Escribí solo los archivos que la tarea requiere. No hagas refactors fuera de scope.
- Ejecutá los comandos de verificación (typecheck, test) DESPUÉS de escribir.
- Si un comando falla, intentá corregir antes de reportar "failed".
- Reportá en "verification[]" todos los comandos que ejecutaste con su resultado real.
- Si no tienes herramientas disponibles, describí qué harías (modo advisory).
`;
```

**Criterio de aceptación:** El prompt actualizado incluye instrucciones de tools. El JSON output schema no cambia.

---

### T9: CLI Flag `--tools` / `--no-tools`

Agregar flag para opt-in/opt-out de tool use:

```typescript
// En src/cli.ts, comando run:
.option("--tools", "Habilitar tool use (ejecución real de código)", true)
.option("--no-tools", "Deshabilitar tool use (modo advisory)")
```

Cuando `--no-tools`: se usa `provider.complete()` como antes.
Cuando `--tools` (default si el provider soporta): se usa `toolLoop`.

**Criterio de aceptación:** `slad run --no-tools` funciona como antes. `slad run --tools` activa execution real.

---

### T10: Tests de integración

```
src/tools/definitions/filesystem.test.ts  # Path traversal, read/write correctos
src/tools/definitions/shell.test.ts       # Timeout, sandbox boundaries
src/tools/executor.test.ts                # Harness integration (mock harness)
src/models/tool-loop.test.ts              # Mock provider, verifica loop completo
```

**Criterio de aceptación:** `npm test` pasa con todos los tests nuevos.

---

## Orden de Dependencias (DAG)

```
T1 (types) ─────┐
                 ├── T3 (registry) ── T4 (executor) ── T7 (run.ts integration)
T2 (definitions) ┘                                          │
                                                            T9 (CLI flag)
T5 (ModelProvider) ── T6 (tool-loop) ──────────────────────┘

T8 (prompt update) ── T7

T10 (tests) depende de todos
```

Ejecución recomendada: T1 → T2 → T3 → T5 → T4 → T6 → T8 → T7 → T9 → T10

---

## Decisiones de Diseño

1. **Tool loop DENTRO del provider vs. genérico**: Recomiendo dentro del provider. Cada SDK tiene su propio formato para tool results y el loop es más natural ahí. El `tool-loop.ts` actúa como orquestador ligero que delega al provider.

2. **Backward compatibility**: `complete()` sigue igual. `completeWithTools()` es opt-in. Si el provider no lo implementa, run.ts cae a advisory mode automáticamente.

3. **Security by default**: El `exec` tool tiene `permissionLevel: "full"` por default. El Harness reclasifica comandos individuales (ej: `npm test` → workspace, `rm -rf /` → full). En mode `strict`, incluso `writeFile` requiere aprobación.

4. **CWD sandboxing**: Todas las operaciones de filesystem se resuelven contra `process.cwd()` con validación de path traversal. No se puede leer fuera del directorio del proyecto.

5. **Token budget**: El tool loop tiene `maxToolRounds: 10` default. Cada round consume tokens. El spinner muestra qué tool se está ejecutando para feedback visual.

---

## Riesgos

- **Token explosion**: Muchos tool rounds = muchos tokens. Mitigación: maxToolRounds + truncar outputs largos (ej: readFile de archivo > 500 líneas → primeras 200 + "...truncated").
- **Anthropic vs OpenAI message format divergence**: El formato de tool results en el historial es incompatible. Mitigación: cada provider maneja su propio formato internamente.
- **Gemini tool use**: Google Generative AI SDK tiene tool use pero con API diferente. Se puede implementar después (T5 es opcional para Gemini en primera iteración).
- **CLI provider no soporta tools**: Correcto. El CLIProvider (subprocess) no implementa completeWithTools, fallback a advisory.

---

## Notas para el ejecutor

- Usar `@anthropic-ai/sdk` ^0.30.0 que ya está en package.json — soporta tools nativamente.
- Usar `openai` ^4.67.0 que ya está — soporta function_calling.
- No agregar dependencias nuevas. Todo se resuelve con las existentes + node:fs/child_process.
- Mantener español en UI/prompts, inglés en código.
- Tests con `node:test`, no jest/vitest.
- Imports con `.js` extension (ESM).
