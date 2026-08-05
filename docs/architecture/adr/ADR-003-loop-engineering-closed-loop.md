# ADR-003 — Loop Engineering como bucle cerrado y acotado

> **Estado:** propuesta.
> **Fecha:** 2026-06-17.
> **Relacionado:** [ADR-001](./ADR-001-slad-as-agentic-lego-system.md), [ADR-002](./ADR-002-packages-vs-generated-projects.md), [Loop Engineering](../loop-engineering.md).

## Contexto

El pipeline SLAD (`explore → snapshot → plan → run → learn`) es **lineal**: corre una vez y termina. La práctica de "Loop Engineering" propone que el humano fije una meta única y el sistema entre en un ciclo autónomo de descubrimiento → ejecución → verificación que **se reinicia usando la memoria de los intentos previos** hasta cumplir la meta.

Esto introduce una tensión con la tesis de SLAD: el valor es el **determinismo** y los handoffs validados por Zod. Un bucle autónomo introduce no-determinismo y riesgo de consumo descontrolado de tokens/presupuesto ("open loop").

## Decisión

Adoptamos Loop Engineering **solo en su forma de bucle cerrado y acotado (closed loop)**, no como bucle abierto.

1. El loop **envuelve** `runPipeline`; no modifica su núcleo. Se respeta el boundary SDK de [ADR-001](./ADR-001-slad-as-agentic-lego-system.md): `packages/` = primitivas reutilizables.
2. La verificación se materializa como un **veredicto validado por Zod** (`GoalVerdict`), igual que cualquier otro artifact del pipeline. La satisfacción de la meta se ancla primero en señales **objetivas** (`RunOutput.verification[]`, `PlanTask.acceptanceCriteria`) y solo recurre al juicio del modelo cuando la señal objetiva es ambigua.
3. La "memoria de intentos previos" reutiliza el `MemoryProvider` ya existente (`@slad/memory`); no se crea persistencia nueva.
4. El cierre del bucle está **garantizado** por tres topes: `maxIterations`, el presupuesto ya existente (`PipelinePolicies.budget`), y detección de estancamiento (gaps idénticos entre iteraciones → escala a HITL).
5. Se expone `mode: "closed" (default) | "open"`. `closed` aplica todos los topes; `open` los relaja para exploración, bajo responsabilidad explícita del usuario.

## Consecuencias

**Positivas:**
- El bucle no añade un paradigma ajeno: completa el ciclo que SLAD ya tenía a medias. Cada etapa ya existía como stage; solo faltaba cerrar el lazo.
- El presupuesto y el harness existentes implementan directamente la distinción open/closed de la práctica.
- `evolve` se vuelve más útil: recibe el ledger completo de intentos en lugar de un solo pase.

**Negativas / costes:**
- Introduce no-determinismo controlado (iteraciones variables). Se mitiga con topes duros y veredictos validados.
- Añade una stage (`verify`) y un módulo (`loop/`) al package `pipeline`.

**Diferido explícitamente:**
- **Ejecución en paralelo de specialists** (fan-out de agentes). El runner es secuencial; el paralelismo es un cambio mayor e independiente. El bucle entrega la mayor parte del valor sin él.
