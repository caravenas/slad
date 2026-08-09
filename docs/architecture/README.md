# Arquitectura de SLAD

SLAD es un orquestador de CLIs locales para ejecutar el loop `explore → snapshot → plan → run → learn → evolve`.

## Contrato vigente

- [ADR-004 — SLAD como orquestador de CLIs locales](./adr/ADR-004-cli-orchestrator-runtime-boundary.md) define el propósito, las fronteras y los non-goals vigentes.
- [Plan de refocus de 2026-07-02](../plans/2026-07-02-option-a-refocus.md) documenta la migración que eliminó APIs HTTP, dashboard y micro-paquetes legacy.

## Diagnóstico `slad doctor`

`slad doctor` es el diagnóstico read-only del runtime local de SLAD.
Su propósito es explicar si el workspace, la configuración, el repositorio git, los directorios runtime y los backends CLI disponibles están listos para ejecutar el loop, sin intentar corregir nada.
El comando no repara estado, no escribe archivos, no modifica git, no invoca agentes y no llama LLMs ni APIs de modelos.

El motor produce un contrato compartido `DoctorReport` con `status`, `summary` y `checks`.
Cada check usa `healthy`, `warning` o `blocked`.
El estado global es `blocked` si existe al menos un blocker, `warning` si no hay blockers pero sí warnings, y `healthy` solo cuando todos los checks pasan.
El resumen contiene los contadores derivados `passed`, `warnings` y `blockers` para que tanto la salida humana como `--json` representen el mismo resultado.

La semántica de salida es intencionalmente apta para scripts.
`healthy` y `warning` terminan con exit code `0`, porque el diagnóstico se pudo completar y no detectó blockers.
`blocked` termina con exit code no cero para detener automatizaciones antes de ejecutar agentes.
Un error interno del doctor también termina con exit code no cero y debe tratarse distinto de un check bloqueante reportado correctamente.

## Documentos históricos

ADR-001, ADR-002, ADR-003 y los documentos bajo `legacy-plans/` describen arquitecturas anteriores.
Se conservan únicamente como contexto histórico y quedan reemplazados por ADR-004 ante cualquier contradicción.
No deben utilizarse como especificación de implementación actual.

## Verificación

Todo cambio de runtime debe pasar desde la raíz:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```
