# SLAD Monorepo Migration Plan

> Plan ejecutable para migrar `slad-os` (CLI) + `slad-ui` (Dashboard Next.js) a un monorepo con pnpm workspaces + Turborepo.
> Diseñado para ser implementado por Sonnet/Codex en pasos atómicos y verificables.

---

## Estado actual

### slad-os (CLI)
- **Package name**: `slad-os` v0.1.0
- **Module system**: ESM (`"type": "module"`)
- **TS config**: `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, strict
- **Build**: `tsc` → `dist/`
- **Entry**: `bin/slad-os.js` (aliases: `slad`, `dev`, `dev-agent`)
- **Deps principales**: zod, commander, @inquirer/prompts, ora, kleur, SDKs de LLM
- **Tests**: `node --import tsx/esm --test 'src/**/*.test.ts'`

### slad-ui (Dashboard)
- **Package name**: `dashboard` v0.1.0 (private)
- **Framework**: Next.js 16.2.6 + React 19.2.4
- **TS config**: `target: ES2017`, `module: esnext`, `moduleResolution: bundler`
- **Path alias**: `@/*` → `./src/*`
- **Data**: Mock data en `lib/data.ts` con `@ts-nocheck` — tipos implícitos que duplican los schemas Zod del CLI

### Punto de conexión
El UI define en `lib/data.ts` estructuras que son versiones sueltas de:
- `SessionArtifactKind` → `SLAD_STAGE_NAMES` (array hardcodeado)
- `PlanTask` → objetos en `SLAD_DETAILS["s-1"].plan.tasks`
- `RunOutput.verification` → `SLAD_DETAILS["s-2"].verify`
- `Question` / `QuestionKind` → `SLAD_DETAILS["s-3"].questions`
- `LearnOutput` categorías → `SLAD_DETAILS["s-5"].learn`
- `EvolveOutput.proposedUpdates` → `SLAD_DETAILS["s-4"].evolve`

Extraer estos tipos a un paquete compartido elimina la duplicación y permite que el UI compile con type safety real.

---

## Estructura objetivo

```
slad/                              # Nuevo repo root (o renombrar slad-os)
├── pnpm-workspace.yaml
├── turbo.json
├── package.json                   # Root: solo scripts de orquestación
├── tsconfig.base.json             # Config TS compartida (strict, paths)
├── .gitignore
├── .env.example
├── CLAUDE.md                      # Actualizado con estructura monorepo
├── AGENTS.md
│
├── packages/
│   ├── shared/                    # @slad/shared — contratos de datos
│   │   ├── package.json
│   │   ├── tsconfig.json          # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── index.ts           # Re-exports públicos
│   │       ├── schemas.ts         # Zod schemas (ExploreOutput, PlanTask, etc.)
│   │       ├── types.ts           # Types derivados + enums puros
│   │       └── constants.ts       # STAGE_NAMES, status enums
│   │
│   ├── cli/                       # @slad/cli — el CLI actual (slad-os)
│   │   ├── package.json           # deps: @slad/shared + commander, ora, etc.
│   │   ├── tsconfig.json          # extends ../../tsconfig.base.json
│   │   ├── bin/
│   │   │   └── slad-os.js
│   │   └── src/
│   │       ├── cli.ts
│   │       ├── commands/
│   │       ├── agents/
│   │       ├── models/
│   │       ├── core/
│   │       │   ├── types.ts       # RE-EXPORTA desde @slad/shared + tipos locales
│   │       │   ├── config.ts
│   │       │   ├── session.ts
│   │       │   └── ...
│   │       ├── cache/
│   │       ├── harness/
│   │       ├── tools/
│   │       ├── context/
│   │       ├── persistence/
│   │       ├── project/
│   │       └── templates/
│   │
│   └── ui/                        # @slad/ui — dashboard Next.js
│       ├── package.json           # deps: @slad/shared + next, react
│       ├── tsconfig.json          # extends ../../tsconfig.base.json
│       ├── next.config.ts
│       ├── public/
│       └── src/
│           ├── app/
│           ├── components/
│           └── lib/
│               └── data.ts        # Mock data TIPADO con schemas de @slad/shared
```

---

## Fases de implementación

### Fase 0 — Preparar el root del monorepo

**Objetivo**: Crear la estructura raíz sin mover código todavía.

**Archivos a crear**:

#### `package.json` (root)
```json
{
  "name": "slad",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "dev:cli": "pnpm --filter @slad/cli dev",
    "dev:ui": "pnpm --filter @slad/ui dev",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.6.0"
  }
}
```

#### `pnpm-workspace.yaml`
```yaml
packages:
  - "packages/*"
```

#### `turbo.json`
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "clean": {
      "cache": false
    }
  }
}
```

#### `tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "composite": true
  }
}
```

#### `.gitignore` (root)
```
node_modules/
dist/
.next/
.turbo/
*.tsbuildinfo
.env
.env.local
```

**Verificación**:
```bash
# Desde el root
pnpm install   # Debe resolver sin errores
ls packages/   # Debe estar vacío aún (o con carpetas stub)
```

---

### Fase 1 — Extraer `@slad/shared`

**Objetivo**: Mover los Zod schemas y tipos compartidos a su propio paquete.

**Qué va a `@slad/shared`** (desde `slad-os/src/core/types.ts`):

| Export | Razón |
|--------|-------|
| `SessionArtifactKind` | UI lo usa como `SLAD_STAGE_NAMES` |
| `ExploreOutput` | UI renderiza approaches, risks, openQuestions |
| `PlanTask`, `PlanOutput`, `TaskId` | UI renderiza el DAG de tasks |
| `RunOutput` | UI renderiza verification, changedFiles, thread |
| `LearnOutput` | UI renderiza decisions, patterns, errors |
| `EvolveOutput` | UI renderiza proposedUpdates diffs |
| `Question`, `QuestionKind` | UI renderiza el HITL form |
| `SessionState`, `SessionArtifact`, `SessionAnswer` | UI consume estado de sesión |
| `ProviderName`, `AgentName` | UI muestra provider chips |
| `ChatMessage`, `MessageRole` | Potencial chat view |

**Qué NO va a shared** (se queda en CLI):

| Export | Razón |
|--------|-------|
| `CompletionOptions` | Runtime del CLI (callbacks, no serializable) |
| `DevAgentConfig` | Config interna del CLI |
| `CliDiscoveryArtifact`, `CliCandidate`, `DiscoveryResult` | Lógica de discovery local |
| `ProjectInventory`, `InventoryProvider`, `InventoryCommand`, `InventorySchema` | Inventario interno |
| `ProjectConfig` | Config de proyecto local |

#### `packages/shared/package.json`
```json
{
  "name": "@slad/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

#### `packages/shared/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

#### `packages/shared/src/schemas.ts`
Mover los schemas listados arriba desde `slad-os/src/core/types.ts`. Mantener la misma estructura pero sin los tipos CLI-only.

#### `packages/shared/src/constants.ts`
```typescript
export const STAGE_NAMES = [
  "explore", "snapshot", "plan", "run", "learn", "evolve"
] as const;

export type StageName = (typeof STAGE_NAMES)[number];
```

#### `packages/shared/src/index.ts`
```typescript
export * from "./schemas.js";
export * from "./constants.js";
```

**Verificación**:
```bash
cd packages/shared && pnpm build
# Debe compilar sin errores y generar dist/ con .js + .d.ts
```

---

### Fase 2 — Mover slad-os → `packages/cli`

**Objetivo**: Reubicar el CLI como paquete del workspace y rewirear imports a `@slad/shared`.

**Pasos**:

1. **Copiar** todo el contenido de `slad-os/` a `packages/cli/` (excepto `node_modules`, `dist`, `.git`)

2. **Actualizar `packages/cli/package.json`**:
```json
{
  "name": "@slad/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "slad": "./bin/slad-os.js",
    "dev": "./bin/slad-os.js",
    "dev-agent": "./bin/slad-os.js"
  },
  "main": "dist/cli.js",
  "files": ["bin", "dist", "README.md", "package.json"],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "start": "node dist/cli.js",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist",
    "test": "node --import tsx/esm --test 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@slad/shared": "workspace:*",
    "@anthropic-ai/sdk": "^0.30.0",
    "@google/generative-ai": "^0.21.0",
    "@inquirer/prompts": "^8.4.2",
    "commander": "^12.1.0",
    "dotenv": "^16.4.5",
    "kleur": "^4.1.5",
    "openai": "^4.67.0",
    "ora": "^8.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

3. **Actualizar `packages/cli/tsconfig.json`**:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": false
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../shared" }
  ]
}
```

4. **Refactor de `packages/cli/src/core/types.ts`**:
   - Eliminar todos los schemas que ahora viven en `@slad/shared`
   - Re-exportar desde shared para no romper imports existentes:
   ```typescript
   // Re-export shared schemas (backward compat)
   export {
     ProviderName, AgentName, MessageRole, ChatMessage,
     Question, QuestionKind,
     ExploreOutput, SnapshotOutput,
     TaskId, LearnTaskId,
     PlanTask, PlanOutput,
     RunOutput, LearnOutput, EvolveOutput,
     SessionArtifactKind, SessionArtifact, SessionAnswer, SessionState,
   } from "@slad/shared";

   // CLI-only types stay here
   export const CompletionOptions = z.object({ /* ... */ });
   // ... CliDiscoveryArtifact, ProjectInventory, etc.
   ```

   > **Nota clave**: Esta estrategia de re-export evita tener que cambiar TODOS los imports internos del CLI de golpe. Los archivos en `commands/`, `agents/`, etc. siguen importando desde `./core/types.js` y funciona. En una segunda iteración se puede hacer el cambio gradual a imports directos de `@slad/shared`.

**Verificación**:
```bash
cd packages/cli && pnpm build    # Compila OK
pnpm dev -- explore "test"       # CLI funciona
pnpm test                        # Tests pasan
```

---

### Fase 3 — Mover slad-ui → `packages/ui`

**Objetivo**: Reubicar el dashboard y conectarlo a tipos reales via `@slad/shared`.

**Pasos**:

1. **Copiar** contenido de `slad-ui/dashboard/` a `packages/ui/`

2. **Actualizar `packages/ui/package.json`**:
```json
{
  "name": "@slad/ui",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@slad/shared": "workspace:*",
    "next": "16.2.6",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.6",
    "typescript": "^5"
  }
}
```

3. **Actualizar `packages/ui/tsconfig.json`**:
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"],
      "@slad/shared": ["../shared/src/index.ts"]
    }
  },
  "include": [
    "next-env.d.ts", "**/*.ts", "**/*.tsx",
    ".next/types/**/*.ts", ".next/dev/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

   > **Nota**: El path mapping `@slad/shared` apunta al source directamente para que Next.js lo transpile on-the-fly en dev. En build, pnpm resuelve via `workspace:*` al `dist/` compilado.

4. **Configurar `packages/ui/next.config.ts`** para transpilar el paquete:
```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@slad/shared"],
};

export default nextConfig;
```

5. **Refactor de `packages/ui/src/lib/data.ts`**:
   - Eliminar `@ts-nocheck`
   - Importar tipos desde `@slad/shared`:
   ```typescript
   import type {
     StageName,
     SessionArtifactKind,
     QuestionKind,
   } from "@slad/shared";
   ```
   - Tipar las estructuras mock progresivamente. **No intentar tipar todo de golpe**: el mock data del UI tiene campos extra (tokens, costUsd, provider, cacheHits) que no existen en `SessionState`. La estrategia es:
     - Crear interfaces UI-specific en `packages/ui/src/lib/types.ts` que **extienden** los tipos de shared
     - Ejemplo:
     ```typescript
     import type { SessionArtifactKind, PlanTask } from "@slad/shared";

     export type StageStatus = "done" | "progress" | "pending" | "await";

     export interface UISession {
       id: string;
       intent: string;
       updatedAt: string;
       stages: StageStatus[];
       activeStage: number;
       tokens: number;
       costUsd: number;
       provider: { vendor: string; model: string };
       cacheHits: number;
       cacheMisses: number;
       // Campos opcionales por estado
       runMode?: "live" | "hitl";
       tasksTotal?: number;
       tasksDone?: number;
       hitlRound?: number;
       hitlMax?: number;
     }
     ```
   - Los componentes siguen consumiendo `UISession` pero las piezas internas (questions, tasks, verification) son los tipos reales de `@slad/shared`

**Verificación**:
```bash
cd packages/ui && pnpm dev       # Next.js arranca sin errores
pnpm build                       # Build de producción OK
pnpm typecheck                   # Sin errores de tipos (gradual)
```

---

### Fase 4 — Actualizar docs y config

**Objetivo**: Que CLAUDE.md, AGENTS.md y configs reflejen la nueva estructura.

1. **Mover** `CLAUDE.md` y `AGENTS.md` al root del monorepo

2. **Actualizar CLAUDE.md** — secciones a cambiar:
   - Estructura del proyecto: reflejar `packages/shared`, `packages/cli`, `packages/ui`
   - Comandos útiles:
     ```bash
     pnpm dev:cli -- explore "intención"    # CLI en dev mode
     pnpm dev:ui                            # Dashboard en localhost:3000
     pnpm build                             # Build todos los paquetes
     pnpm test                              # Tests de todos los paquetes
     pnpm --filter @slad/cli test           # Tests solo del CLI
     ```
   - Convenciones: agregar regla de que schemas compartidos van en `@slad/shared`, no en `core/types.ts`
   - Cosas importantes: agregar nota sobre `workspace:*` y turbo task dependencies

3. **Crear `packages/cli/CLAUDE.md`** con instrucciones específicas del CLI

4. **Crear `packages/ui/CLAUDE.md`** con instrucciones específicas del UI

5. **Root `.env.example`**:
   ```
   ANTHROPIC_API_KEY=
   OPENAI_API_KEY=
   GOOGLE_API_KEY=
   SLAD_LOG_LEVEL=info
   ```

---

### Fase 5 — Verificación end-to-end

```bash
# Desde el root del monorepo
rm -rf node_modules packages/*/node_modules
pnpm install                              # ✓ Instala todo
pnpm build                                # ✓ turbo: shared → cli + ui en paralelo
pnpm typecheck                            # ✓ Sin errores de tipo
pnpm test                                 # ✓ Tests del CLI pasan
pnpm dev:cli -- explore "test intent"     # ✓ CLI funciona como antes
pnpm dev:ui                               # ✓ Dashboard arranca en :3000

# Verificar que el CLI sigue siendo linkable/publicable
cd packages/cli && pnpm pack              # ✓ Genera .tgz funcional
```

---

## Orden de ejecución (para el agente)

| Step | Fase | Descripción | Bloqueado por |
|------|------|-------------|---------------|
| 1 | 0 | Crear root: package.json, pnpm-workspace, turbo.json, tsconfig.base | — |
| 2 | 1 | Crear packages/shared con schemas extraídos de core/types.ts | 1 |
| 3 | 1 | Build de @slad/shared → verificar dist/ generado | 2 |
| 4 | 2 | Mover slad-os → packages/cli, rewirear package.json y tsconfig | 3 |
| 5 | 2 | Refactor core/types.ts → re-export desde @slad/shared | 4 |
| 6 | 2 | Verificar: pnpm build + pnpm test en cli | 5 |
| 7 | 3 | Mover slad-ui → packages/ui, actualizar package.json y tsconfig | 3 |
| 8 | 3 | Crear lib/types.ts con interfaces UI-specific | 7 |
| 9 | 3 | Refactor lib/data.ts: tipar con @slad/shared + UI types | 8 |
| 10 | 3 | Verificar: pnpm dev + pnpm build en ui | 9 |
| 11 | 4 | Actualizar CLAUDE.md, AGENTS.md, crear sub-CLAUDE.md | 6, 10 |
| 12 | 5 | Verificación e2e completa desde root | 11 |

---

## Decisiones de diseño

**¿Por qué re-export en core/types.ts en vez de reescribir todos los imports?**
Minimiza el blast radius del cambio. El CLI tiene ~30 archivos que importan de `./core/types.js`. Reescribirlos todos de golpe es riesgo innecesario. El re-export es un bridge: funciona idéntico, y después se puede migrar gradualmente.

**¿Por qué `composite: true` en shared pero `composite: false` en cli?**
Shared necesita ser referenciable (`references` en tsconfig). El CLI no necesita ser referenciado por nadie, y `composite: true` forzaría `declarationMap` y otras restricciones que pueden conflictuar con su build actual.

**¿Por qué el UI no hereda de tsconfig.base.json directamente?**
Next.js tiene requerimientos específicos de tsconfig (`module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`, `noEmit: true`) que contradicen la base de Node. Es más limpio mantener su config propia y solo alinear las opciones de strictness manualmente.

**¿Por qué no un `@slad/types` separado de `@slad/shared`?**
Hoy son lo mismo. Cuando shared necesite incluir utilidades runtime (formatters, validators, etc.) además de tipos, ya tiene el nombre correcto. Empezar con un paquete solo de tipos que luego hay que renombrar es churn innecesario.

**¿Por qué zod está en shared y también en cli?**
Ambos lo necesitan como dependency directa. Zod es runtime, no solo tipos. pnpm deduplicará la instalación si las versiones son compatibles.
