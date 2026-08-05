# ADR-004 — SLAD como orquestador de CLIs locales

- **Estado:** Aceptada
- **Fecha:** 2026-08-05
- **Reemplaza:** ADR-001, ADR-002 y ADR-003 en toda afirmación incompatible

## Contexto

SLAD tuvo anteriormente la ambición de ser un framework general de agentes y un kit para generar aplicaciones.
Esa dirección produjo paquetes y documentación que duplicaban responsabilidades ya cubiertas por los agentes de código locales.
El producto que tiene una frontera distintiva y comprobable es la ejecución confiable de planes mediante CLIs instalados por el usuario.

## Decisión

SLAD es un orquestador de CLIs locales de agentes de código.

El flujo operativo es `explore → snapshot → plan → run → learn → evolve`.
La generación del plan es autónoma, pero su ejecución requiere aprobación explícita ligada al hash exacto del plan.
Una vez aprobado, el runtime ejecuta stages y tareas sin introducir HITL entre stages.
La evidencia canónica de ejecución son artifacts validados, estado Git y manifests repo-locales.
Pi y `~/.agents` gobiernan roles, políticas y memoria global; SLAD ejecuta planes aprobados y produce registros episódicos.

SLAD puede exponer contratos SDK estrictamente necesarios para su CLI, pero no se diseña como framework general de LLMs.

## Non-goals

- Adaptadores HTTP de proveedores o gestión de API keys.
- SDKs de vendors de modelos dentro del core.
- Un sistema de memoria global paralelo a `~/.agents`.
- Un dashboard web o generadores de aplicaciones.
- Un segundo control plane durable.
- Deep Agents dentro del core.

Un Deep Agent futuro solo podrá evaluarse como worker externo, especializado, acotado y reemplazable después de endurecer el runtime existente.

## Consecuencias

Los backends soportados son `claude`, `codex`, `pi` y `agy` mediante `CliProvider`.
Los cambios de contratos serializables se centralizan en `@slad/shared`.
Los planes, outputs de workers, manifests y artifacts se validan antes de aceptarse como evidencia.
Las abstracciones legacy que no sostienen la orquestación CLI se retirarán después de estabilizar correctitud, resume y lifecycle de procesos.
