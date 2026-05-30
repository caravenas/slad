# SLAD OS Roadmap & Status

> Última actualización: 2026-05-12 (post JSON persistence refactor)

## Criterios de Madurez (Glosario)

- **[Stable]**: Código maduro, cobertura de tests >80% y validado en 10+ sesiones reales. Listo para uso en producción local.
- **[Beta]**: Funcional y probado unitariamente, pero requiere más validación en escenarios reales o carece de tests de integración complejos.
- **[Experimental]**: Prueba de concepto o funcionalidad en desarrollo activo. API sujeta a cambios drásticos y posibles fallos no detectados.
- **[Planned]**: Diseñado/conversado pero sin código. Existe brief, spec o decisión de arquitectura.

---

# Estado actual por fase

## Pipeline Core (Fases 1–3)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Fase 1 — Pipeline tipado** | [Stable] | Los 6 stages implementados (`explore` → `snapshot` → `plan` → `run` → `learn` → `evolve`) + `chat` REPL + `auto` (pipeline completo intent→código); schemas Zod completos en `core/types.ts`; extracción JSON fence-aware; persistence layer JSON puro (`persistence/`); `stats` command; **suite E2E sobre repo fixture con mock provider** (`src/tests/e2e-auto-dry-run.test.ts`). | Smoke test del binario `slad` compilado. | Alta |
| **Comando: explore** | [Stable] | Análisis de intención, reframing, enfoques con pros/cons, riesgos, open questions. Wiki context injection opcional (`SLAD_WIKI_PATH`). | Refinamiento de prompts según feedback de uso real. | Baja |
| **Comando: snapshot** | [Beta] | Generación de mini-spec `.md` a partir de explore o intención directa; template Markdown en `src/templates/`. | Template dinámico por lenguaje/stack; selección automática de approach. | Media |
| **Comando: plan** | [Stable] | Conversión de Snapshot a `PlanTask[]` con DAG de dependencias; `recommendedFirstTask`; plan-level verification y risks. | Validación de dependencias circulares; re-planning parcial tras fallos. | Baja |
| **Comando: run** | [Beta] | Builder + Reviewer loop con HITL; `--auto` con ejecución DAG topológica, resume detection, cascade de skips; follow-up execution; git change detection post-task; harness integration; **tool use real** (readFile, writeFile, listDir, grep, exec, git ops) vía tool-loop provider-agnostic; scratchpad para offloading de results grandes; **`--parallel` / `--max-parallel`** con `Promise.allSettled` sobre ramas independientes del DAG (`dag.ts`). | Streaming de resultados durante tool loops; timeout por tarea individual. | Alta |
| **Comando: learn** | [Beta] | Extracción de decisiones, errores, patrones, follow-ups; generación consolidada (`taskId: "all"`) para auto pipeline; output Markdown persistido. | Tests de integración robustos; wiki persistence automático (hoy depende de `evolve --apply-wiki`). | Media |
| **Comando: evolve** | [Beta] | Propuesta de updates a wiki/AGENTS.md; `--apply-wiki` para append automático; output Markdown con proposed changes. | Feedback loop para medir impacto real de las propuestas; diff preview interactivo antes de aplicar. | Media |
| **Comando: auto** | [Beta] | Pipeline completo intent→código en un solo comando; `--dry-run` (explore+snapshot+plan sin ejecutar); `--max-cost` budget cap; `--max-tasks` limit; `--skip-learn`; `--harness`; HITL auto-resolve con heurísticas (`hitl-auto-resolve.ts`); BudgetTracker con pricing por modelo; Scratchpad context offloading; AutoReport con status/stages/budget; **`--resume` / `--fresh`** con checkpoint por stage en `.slad-os/auto-checkpoint.json` (detecta pipeline interrumpido y retoma desde el último stage completo); **budget history** persistida en `.slad-os/budget-history.jsonl`. | Streaming feedback durante stages largos. | Alta |
| **Comando: chat** | [Stable] | REPL conversacional con parseAction/suggestNext; soporte español/inglés; gestión de sesión integrada. | Historial persistente cross-session; modo no-interactivo (pipe input). | Baja |
| **Comando: stats** | [Beta] | Totales de sesiones, runs y learnings por proyecto; output `--json`; **Budget history**: total de auto runs, tokens y costo estimado acumulado leído desde `budget-history.jsonl`. | Breakdown por provider/modelo; timeline de runs. | Baja |

## Infraestructura (Fases 2–5)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Fase 2 — Multi-provider** | [Stable] | `ModelProvider` interface + factory; providers `anthropic`, `openai`, `gemini`, `cli` (codex/claude subprocess); `ProviderError` con `retryable` flag (429/529/500); `CliCandidate` discovery (`cli-discovery.ts`) con cache; `completeWithTools()` para Anthropic y OpenAI; `supportsToolUse` flag por provider; **retry con backoff exponencial** (`retry.ts`: jitter ±25%, cap 16 s, solo en errores retryable); **timeouts configurables** por llamada API vía `SLAD_API_TIMEOUT_MS` (`timeout.ts`). | Fallback automático provider-to-provider; streaming para feedback en vivo. | Media |
| **Fase 3 — Sesiones y HITL** | [Beta] | `SessionState` CRUD + `appendArtifact()`; loop HITL universal con `@inquirer/prompts`; `hitl-loop.ts` genérico para auto pipeline; `hitl-auto-resolve.ts` con heurísticas por stage; `AGENTS.md` injection; `inventory.ts` para proyecto; `humanAnswers` acumulativos en sesión; `session start/list/use/show`. | `session restore` robusto; `session diff`; branch/fork de sesión; persistencia multi-proceso. | Media |
| **Fase 4 — Cache & observabilidad** | [Stable] | Cache content-based en `~/.slad-os/cache/v1` (store, keys, invalidation, reusable); logger configurable (`SLAD_LOG_LEVEL`, timestamps, debug); `project-id` determinista; `BudgetTracker` con token/cost tracking por stage y modelo. | Métricas de hit rate persistidas; instrumentación OTEL; correlation IDs cross-stage; export de trazas. | Media |
| **Fase 5 — Harness de seguridad** | [Beta] | Clasificador 3-tier (`read`/`workspace`/`full`) en `classifier.ts`; `AuditLogger` LDJSON append-only; `approval.ts` HITL para acciones peligrosas; modes `off`/`on`/`strict` vía `--harness`; config loader `.slad-os/harness.json`; integración con `ToolExecutor` (el harness intercepta tool calls). | Sandboxing real (Docker/Firejail); DSL de políticas declarativas; allowlist/blocklist por proyecto; tests de evasión. | Alta |

## Tool System (nueva fase)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Tool definitions** | [Beta] | Schema Zod para `ToolDefinition`, `ToolCall`, `ToolResult`, `ProviderResponse`; permission levels integrados con harness. | Validación de argumentos contra schema antes de ejecutar; tool timeout por definición. | Media |
| **Tool registry** | [Beta] | `ToolRegistry` con register/get/definitions; factory `createDefaultRegistry()` con 9 tools built-in: `readFile`, `writeFile`, `listDir`, `grep`, `exec`, `gitStatus`, `gitDiff`, `gitAdd`, `gitCommit`. | API para registrar tools de terceros (plugins); tool discovery dinámico. | Alta |
| **Tool executor** | [Beta] | `ToolExecutor` con dispatch, harness gating, cwd scoping. | Sandbox por tool; rate limiting; tool result caching. | Media |
| **Tool loop** | [Beta] | Loop genérico provider-agnostic (`toolLoop()`); max rounds configurable; `onToolCall`/`onToolResult` callbacks; Scratchpad integration para offloading de results grandes. | Streaming de tool results; parallel tool execution cuando no hay dependencias. | Media |

## Context Management (nueva fase)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Scratchpad** | [Beta] | Filesystem-backed external memory; threshold por chars/lines; summary generation; re-read hint para el LLM; session-scoped storage en `.slad-os/scratch/`. | Compresión de rounds antiguos (`maxFullRoundsInContext`); cleanup automático post-sesión. | Media |
| **Budget tracker** | [Beta] | Token counting por stage; cost estimation con pricing table (Anthropic/OpenAI/Gemini/MiniMax); warnings al 80%; abort on exceed; desglose `byStage`; **`initialState` para restaurar budget desde checkpoint**. | Pricing auto-update; alertas configurables. | Media |
| **Project context** | [Stable] | `AGENTS.md` injection automática (limit 8K chars); `projectContextBlock()` para todos los agentes; `core/inventory.ts` para describir el proyecto al LLM. | Indexación dinámica del codebase (inyectar archivos relevantes por tarea automáticamente sin depender de `AGENTS.md` manual). | Alta |

## Persistence Layer (nueva fase)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Artifact persistence** | [Stable] | Sistema unificado **JSON puro** con envelope `{kind, schemaVersion, sessionId, createdAt, taskId?, value}`; `writeArtifact`/`readArtifact` API con validación Zod; layout configurable (`SLAD_DOCS_PATH`, `.slad-os/config.json`); 19 archivos de render/parse Markdown eliminados; dependencia `yaml` removida. | Validación de integridad de artifacts; migración de artifacts `.md` legacy. | Baja |
| **Project config** | [Beta] | `.slad-os/config.json` con `docsPath`; `ProjectConfig` schema Zod. | Más opciones: default provider, harness mode, budget limits, etc. | Baja |

## Calidad y Distribución (Fases 6–7)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Fase 6 — Evals** | [Experimental] | Tests unitarios con `node:test` cubriendo: cache (store, keys, invalidation), harness (classifier, audit), core (errors, logger, stats, inventory), commands (explore, plan, session, auto, stats), models (cli-discovery, tool-loop), tools (filesystem, shell, executor), context (budget, scratchpad), persistence (config, run), cli (version, ui). | Golden outputs por stage; métricas de calidad; regression suite; benchmark dataset reproducible. | Crítica |
| **Fase 7 — Distribución** | [Beta] | Build TS a `dist/`; `prepublishOnly` con typecheck; `bin/slad-os.js`; `package.json` listo para npm; README robusto con docs de uso, arquitectura, config, HITL, cache, roadmap. | CI/CD GitHub Actions (matrix Node 20/22 × OS); changelog automatizado (changesets); docs site; primera release pública en npm. | Alta |

## Extensibilidad y UI (Fases 8–10)

| Componente | Estado | Qué hay | Qué falta | Prioridad |
|------------|--------|---------|-----------|-----------|
| **Fase 8 — Extensibilidad** | [Experimental] | Estructura modular (`agents/`, `commands/`, `models/`, `harness/`, `tools/`); `ToolRegistry` extensible; interfaces claras (ModelProvider, ToolDefinition). | API de plugins para custom agents/commands/tools; hooks pre/post stage; registry de skills; manifest `slad-plugin-*`. | Media |
| **Fase 9 — UI Desktop** | [Experimental] | Prototipo funcional en `localhost:3000`: layout 3-paneles, stage views, **"Friendly" JSON view** para artifacts del pipeline (trigger del refactor JSON persistence), HITL tipado, knowledge view, provider switching. Brief completo en `docs/ui-prototype-brief.md`. | Conexión completa al CLI vía subprocess; persistencia de sesión en UI; streaming de logs en vivo; primera release binario desktop. | Media |
| **Fase 10 — Harness Engineering v0.3** | [Planned] | Concepto definido: pipeline como "fábrica" reproducible con aislamiento, setup determinista y evidencia inspeccionable. | **Tier 1**: Git Worktrees (aislamiento por sesión), Bootability stage (detección de setup/env/deps), Playwright CRI verifier (evidencia visual). **Tier 2**: Ticket-driven mode (Linear/GitHub Issues trigger), `workflow.mmd` export (Mermaid del pipeline), Observability ContextProvider (Grafana/Datadog/Sentry como contexto). | Baja |

---

# Pasos para cerrar un MVP productivo

Production blockers que separan un proyecto interesante de uno usable por terceros.

## A. Confiabilidad

1. ~~**Determinismo y reproducibilidad**~~ ✅ — `temperature: 0.2` en stages críticos (`run`); cache content-based para idempotencia parcial.
2. ~~**Idempotencia del pipeline**~~ ✅ — Cache content-based resuelve la mayoría de los casos; re-ejecución produce cache hits.
3. ~~**Manejo de fallos parciales**~~ ✅ — Resume detection en `run --auto`; cascade de skips en dependientes; retry/skip/abort interactivo; auto-skip en modo no-interactivo.
4. ~~**Timeouts y circuit breakers**~~ ✅ — `SLAD_CLI_TIMEOUT_MS` para CLI provider; `SLAD_API_TIMEOUT_MS` para providers API vía `timeout.ts` + `retryWithBackoff()` en Anthropic/OpenAI/Gemini. Falta: límite global por sesión.

## B. Costos y consumo

5. ~~**Budget caps**~~ ✅ — `BudgetTracker` con `--max-cost` en `slad auto`; warning al 80%; abort on exceed; pricing table multi-modelo.
6. ~~**Token telemetry persistente**~~ ✅ — `budget-history.jsonl` por proyecto: cada run de `slad auto` appenda tokens/costo/provider/model/stages; `slad stats` muestra totales históricos.
7. **Cache aggressiveness configurable** — Hoy es `on` o `off` implícito. Falta: flag `--cache=strict|loose|off`.

## C. Observabilidad

8. **Trazas estructuradas** — El `AutoReport` captura stages/budget/duration. Falta: spans OTEL por stage con metadata completa.
9. **Replay de sesiones** — `session show` existe. Falta: `session replay <id>` que re-renderize un run paso a paso.
10. **Modo `--explain`** — No implementado. Imprimiría decisiones del orquestador.

## D. Seguridad

11. **Secret scanning en context** — No implementado. Escanear context antes de enviar al LLM.
12. **Sandboxing real del harness** — Clasificación + approval implementados. Falta: ejecución en contenedor o `firejail`.
13. ~~**Audit log**~~ ✅ — `AuditLogger` LDJSON append-only implementado. Falta: hash chaining opcional para inmutabilidad.

## E. UX y DX

14. ~~**README**~~ ✅ — README completo con docs de uso, arquitectura, config, cache, HITL, roadmap.
15. **Quickstart en < 60s** — `npx slad-os explore "..."` requiere npm publish primero (Fase 7).
16. ~~**Mensajes de error accionables**~~ ✅ — `ProviderError` con sugerencias de fix; fail-fast con instrucciones en `run`/`auto`.
17. ~~**Modo `--dry-run`**~~ ✅ — Implementado en `slad auto --dry-run` (solo explore+snapshot+plan).

## F. Distribución

18. **CI/CD GitHub Actions** — No implementado. Matrix Node 20/22 × OS.
19. **Changelog automatizado** — No implementado.
20. **Plugin/extension manifest** — No implementado. Depende de Fase 8.

## G. Validación con usuarios reales

21. **Beta cerrada con 3-5 power users** — Pendiente de npm publish (Fase 7).
22. **Feedback loop estructurado** — No implementado.

---

## Features implementadas (checklist consolidada)

- [x] Pipeline completo: `explore` → `snapshot` → `plan` → `run` → `learn` → `evolve`
- [x] `auto` — pipeline intent→código en un comando con budget, scratchpad y auto-resolve HITL
- [x] `chat` — REPL conversacional con sugerencias de siguiente paso
- [x] `session` — gestión de sesiones multi-artefacto con contexto persistente
- [x] `stats` — totales de sesiones, runs, learnings y **costo histórico acumulado**
- [x] HITL universal — todos los agentes pausan y piden input; auto-resolve en modo auto
- [x] Tool use real — readFile, writeFile, listDir, grep, exec, git ops vía tool-loop genérico
- [x] Scratchpad — offloading de tool results grandes a disco con summary en context
- [x] Budget tracker — token/cost tracking por stage y modelo con warnings y abort
- [x] Git change detection — muestra archivos modificados por cada tarea
- [x] Resume detection — `run --auto` detecta tasks completadas y ofrece resumir
- [x] Follow-up execution — ejecución de follow-ups sugeridos por el agente
- [x] Harness de seguridad — clasificador, audit log, approval, 3 modes
- [x] Persistence layer — **JSON puro** con envelope uniforme; eliminados ~700 LOC de render/parse Markdown y dependencia `yaml`
- [x] Multi-provider — Anthropic, OpenAI, Gemini, CLI (Codex/Claude) con tool use
- [x] CLI discovery — detección automática de binarios locales con cache
- [x] Cache content-based — store, keys, invalidation, reusable API
- [x] Project identity — `project-id` determinista por proyecto
- [x] Config validation — schemas Zod para config y defaults
- [x] Error handling tipado — SladError, ProviderError, SchemaError, ConfigError, etc.
- [x] Logger configurable — niveles, timestamps, debug mode, stack traces
- [x] README completo — docs de uso, arquitectura, config, HITL, cache
- [x] `--dry-run` en auto — explore+snapshot+plan sin ejecutar código
- [x] **Retry con backoff exponencial** — `retry.ts` con jitter ±25% y cap 16 s; wired en Anthropic, OpenAI y Gemini
- [x] **Timeouts configurables vía `SLAD_API_TIMEOUT_MS`** — `timeout.ts` integrado en todos los providers API
- [x] **Ejecución paralela de tareas independientes del DAG** — `dag.ts` + `run --parallel --max-parallel N`
- [x] **Checkpoint del pipeline auto** — `.slad-os/auto-checkpoint.json`; guarda estado tras cada stage
- [x] **Resume de pipeline interrumpido** — `slad auto --resume / --fresh`; retoma desde el último stage completo sin repetir LLM calls
- [x] **Budget history persistente** — `.slad-os/budget-history.jsonl`; `slad stats` muestra totales acumulados
- [x] **Suite E2E con mock provider** — `src/tests/e2e-auto-dry-run.test.ts`; 4 tests sobre fixture en temp dir
- [ ] Indexación dinámica del codebase — inyectar archivos relevantes por tarea automáticamente
- [ ] MCP server expose — para Claude Code / Cursor
- [ ] Evals por agente — golden outputs, regression, benchmark
- [ ] UI Desktop — prototipo visual (brief listo, falta implementación)
- [ ] Plugin system — API de plugins para custom agents/commands/tools
- [ ] CI/CD + npm publish — primera release pública

---

## Priorización actualizada

### Bloque 1 — Ship it (semanas 1-3)
- Fase 7: CI/CD + npm publish + primera release `0.1.0`
- Fase 6: Benchmark dataset + evals reproducibles (golden outputs por stage)
- ~~A.4: Timeouts por stage en providers API~~ ✅
- ~~B.6: Persistir budget history entre sesiones~~ ✅

### Bloque 2 — Confianza (semanas 4-6)
- Fase 5: Sandboxing real (Docker o Firejail)
- C.8: Trazas OTEL básicas
- Context: Indexación dinámica del codebase
- Tool system: API para registrar tools de terceros

### Bloque 3 — Diferenciación (mes 2+)
- Fase 9: Prototipo UI Desktop (Tauri o Next.js)
- Fase 8: Plugin system + primer plugin de referencia
- Fase 10 Tier 1: Git Worktrees + Bootability stage
- MCP server expose

### Continuo (en paralelo)
- Refinamiento de prompts por stage según feedback
- Métricas de cache hit rate
- Session restore + diff
