# Workflow de ingeniería con SLAD

## Resumen ejecutivo

SLAD se incorpora al workflow como una capa de ejecución estructurada, verificable y recuperable.
No reemplaza a Pi, Herdr, Git ni CI.
Cada herramienta conserva una responsabilidad distinta:

- **Pi** actúa como capitán de sesión, analiza el problema, toma decisiones y revisa resultados.
- **Herdr** mantiene visibles y separadas las sesiones interactivas de los agentes.
- **SLAD** transforma un plan aprobado en una ejecución controlada mediante límites, ownership, manifests, worktrees y validación de contratos.
- **Git y CI** aportan la evidencia definitiva antes de integrar o publicar cambios.

El loop completo queda así:

```text
intent → explore → snapshot → plan pendiente → aprobación → run → revisión → commit → learn → evolve
```

La recomendación no es usar SLAD para todos los cambios.
Pi directo continúa siendo la opción correcta para tareas pequeñas y de bajo riesgo.
SLAD aporta mayor valor cuando el trabajo tiene varias tareas, dependencias, riesgos, contratos o posibilidades reales de paralelización.

## Responsabilidades por herramienta

### Pi

Pi continúa siendo la interfaz principal para trabajar con Chris.
Sus responsabilidades son:

- comprender la intención;
- detectar ambigüedades;
- explorar el repositorio;
- proponer opciones y trade-offs;
- decidir cuándo conviene usar SLAD;
- revisar planes antes de aprobarlos;
- coordinar revisiones independientes;
- verificar resultados contra el sistema de registro real;
- decidir qué aprendizajes merecen persistirse.

Pi puede implementar directamente tareas pequeñas.
En trabajo complejo, Pi actúa como capitán y evita mezclar coordinación, ejecución y revisión en una sola conversación opaca.

### Herdr

Herdr es la superficie interactiva global para sesiones de agentes.
Se utiliza cuando el trabajo requiere:

- sesiones visibles y separadas;
- revisión independiente;
- intervención humana durante una ejecución;
- investigación paralela;
- comparación entre propuestas;
- tratamiento manual de bloqueos o excepciones.

Herdr y el paralelismo interno de SLAD no son la misma capa.
SLAD utiliza procesos hijos o ventanas tmux cuando `$TMUX` está definido.
Herdr permanece como la superficie global para la coordinación interactiva conducida por Pi.

### SLAD

SLAD se utiliza como runtime de ingeniería controlada.
Sus responsabilidades son:

- ejecutar el loop `explore → snapshot → plan → run → learn → evolve`;
- mantener un plan pendiente hasta que exista una aprobación explícita;
- validar contratos de entrada, salida y cache;
- lanzar los backends mediante un `LaunchSpec` canónico;
- aplicar límites de tareas y paralelismo;
- verificar ownership de archivos;
- aislar tareas mediante worktrees opcionales;
- detectar resultados no verificables;
- escribir manifests y artifacts de forma segura;
- dejar evidencia de estados terminales e interrupciones;
- facilitar la recuperación de ejecuciones interrumpidas.

### Git y CI

Git y CI siguen siendo la fuente definitiva para decidir si un cambio puede integrarse.
SLAD coordina la ejecución, pero no sustituye:

- la revisión del diff;
- lint;
- typecheck;
- build;
- tests;
- revisión humana;
- commit explícito;
- controles del pull request y CI.

## Selección del workflow según la tarea

| Tipo de trabajo | Workflow recomendado | Motivo |
|---|---|---|
| Cambio pequeño, localizado y de bajo riesgo | Pi directo → checks focalizados → commit | SLAD añadiría más ceremonia que control útil. |
| Feature mediana con varias tareas | SLAD estructurado → aprobación → run → revisión | Se beneficia de contratos, artifacts y límites explícitos. |
| Trabajo paralelizable | SLAD con `--parallel`, ownership estricto y worktrees | Permite separar tareas y detectar cambios fuera de alcance. |
| Cambio complejo o de alto riesgo | Pi capitán + Herdr + SLAD | Combina dirección humana visible con ejecución controlada. |
| Investigación o decisión arquitectónica | Pi y Herdr | SLAD solo es necesario cuando la investigación termina en un plan ejecutable. |
| Hotfix urgente y claramente acotado | Pi directo con validación estricta | La velocidad puede justificar omitir el pipeline completo, sin omitir las verificaciones. |

## Criterios para activar SLAD

Conviene utilizar SLAD cuando se cumpla al menos una de estas condiciones:

- la tarea afecta varios módulos o paquetes;
- existe un DAG real de dependencias;
- dos o más tareas pueden ejecutarse en paralelo;
- el cambio necesita aprobación humana antes de escribir código;
- hay riesgo de que un agente modifique archivos fuera de alcance;
- se necesita recuperación tras interrupciones;
- deben conservarse artifacts y hashes de la ejecución;
- se quiere comparar el plan aprobado con el resultado real;
- el trabajo amerita capturar aprendizajes al terminar.

No conviene utilizar el pipeline completo cuando:

- el cambio es trivial;
- solo se modifica un archivo claramente identificado;
- no hay decisiones relevantes;
- la ejecución completa costaría más que implementar y validar directamente;
- el usuario únicamente necesita una respuesta o investigación sin cambios de código.

## Runbook recomendado

### 1. Confirmar un baseline limpio

Antes de ejecutar tareas con worktrees, el repositorio debe tener un `HEAD` válido y los cambios anteriores deben estar resueltos.

```bash
git status
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Si el repositorio tiene cambios legítimos aún no commiteados, deben revisarse antes de comenzar.
No se debe mezclar un run nuevo con cambios cuyo origen o intención no estén claros.

### 2. Crear una sesión de trabajo

La sesión mantiene el contexto compartido entre stages.

```bash
slad pipeline session start \
  "Implementar la funcionalidad X con pruebas y documentación"
```

La intención debe describir el resultado esperado y no solamente la actividad técnica.
Cuando sea posible, debe mencionar criterios de aceptación observables.

### 3. Generar un plan pendiente

El primer run recomendado es un dry-run.
Esto permite inspeccionar la planificación sin modificar código.

```bash
slad pipeline auto \
  "Implementar la funcionalidad X con pruebas y documentación" \
  --agent pi \
  --model openai-codex/gpt-5.5 \
  --dry-run \
  --max-tasks 6 \
  --harness strict
```

Este comando ejecuta `explore`, `snapshot` y `plan`.
El plan queda pendiente de aprobación.

### 4. Revisar el plan

Antes de aprobar, Pi y Chris deben revisar:

- objetivo y alcance;
- criterios de aceptación;
- tareas y dependencias;
- archivos declarados por tarea;
- ownership sin solapamientos innecesarios;
- validaciones asociadas a cada tarea;
- límites de ejecución;
- riesgos conocidos;
- estrategia de rollback;
- tareas que no deberían ejecutarse en paralelo.

Un plan debe rechazarse o regenerarse si:

- contiene tareas vagas;
- no declara archivos relevantes;
- mezcla responsabilidades incompatibles;
- omite validaciones;
- introduce dependencias innecesarias;
- excede el alcance solicitado;
- asume APIs o archivos no verificados.

### 5. Aprobar explícitamente

```bash
slad pipeline plan --approve \
  --reason "Alcance, ownership y validaciones revisados"
```

La aprobación representa una frontera operacional.
No debe utilizarse `--bypass` como flujo normal.

### 6. Ejecutar de forma secuencial

Para una tarea mediana sin paralelismo significativo:

```bash
slad pipeline run \
  --auto \
  --max-tasks 6 \
  --harness strict \
  --agent pi \
  --model openai-codex/gpt-5.5
```

### 7. Ejecutar de forma paralela y aislada

Para un plan con tareas independientes:

```bash
slad pipeline run \
  --parallel \
  --worktrees \
  --strict-ownership \
  --max-parallel 3 \
  --max-tasks 6 \
  --harness strict \
  --non-interactive \
  --agent pi \
  --model openai-codex/gpt-5.5
```

Cada tarea se ejecuta en un worktree aislado.
Los resultados se aplican al repositorio principal como cambios staged y sin commits ocultos.

El primer periodo de adopción debe mantener `--max-parallel 2` o `3`.
Aumentar el paralelismo antes de observar varios runs estables dificultaría identificar fallos de ownership, planificación o integración.

### 8. Revisar el resultado

```bash
git status
git diff --cached
git diff --cached --check
```

La revisión debe comprobar:

- que cada cambio corresponde a una tarea aprobada;
- que no existen archivos fuera de ownership;
- que los cambios staged son coherentes entre sí;
- que no se publicaron artifacts inválidos;
- que los manifests llegaron a un estado terminal;
- que los hashes y rutas registradas corresponden a artifacts existentes;
- que un worker no afirmó haber terminado sin producir cambios verificables.

### 9. Ejecutar verificaciones independientes

En SLAD, la validación completa desde la raíz es:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Los checks focalizados deben ejecutarse primero cuando ayudan a obtener feedback rápido.
La suite completa debe ejecutarse antes de integrar cambios transversales.

Para cambios sensibles, Pi puede abrir una nueva sesión en Herdr con un contexto mínimo y pedir una revisión independiente.
El reviewer debe inspeccionar el diff y ejecutar sus propias verificaciones.
No debe confiar únicamente en el reporte del worker que implementó el cambio.

### 10. Crear el commit

Después de revisar y validar:

```bash
git commit -m "feat: describir el resultado implementado"
```

El commit debe ser explícito y no debe incluir coautoría automática del agente.
SLAD no debe crear commits ocultos en el flujo normal de worktrees.

### 11. Capturar aprendizajes

```bash
slad pipeline learn
slad pipeline evolve
```

`learn` debe capturar decisiones, errores, sorpresas y patrones observados.
`evolve` debe proponer cambios durables, pero no aplicarlos automáticamente sin revisión.

El conocimiento específico del repositorio pertenece a sus documentos o instrucciones.
El conocimiento reutilizable entre proyectos puede proponerse para la memoria global mediante los workflows de `~/.agents`.

## Controles que deben observarse en cada run

### Aprobación

- El plan permanece pendiente hasta recibir aprobación explícita.
- El run no se inicia accidentalmente antes de la aprobación.
- El motivo de aprobación queda asociado al plan.

### Contratos

- Inputs y outputs cumplen los schemas Zod correspondientes.
- Los cache hits también se validan.
- Un output inválido no se publica como artifact ni entra en cache.
- El modo de compatibilidad `warn` solo se utiliza de forma explícita.

### Procesos

- El proceso recibe timeout y señal de cancelación.
- `stdin` se cierra correctamente.
- Los process groups reciben SIGTERM y, si es necesario, SIGKILL.
- Un proceso no queda huérfano tras cancelar el run.

### Paralelismo

- `maxTasks` limita realmente la cantidad de tareas ejecutadas.
- `maxParallel` limita la concurrencia.
- Las tareas paralelas tienen archivos disjuntos.
- El ownership estricto detecta archivos no declarados.
- Exit code 0 sin `RunOutput` válido se considera un fallo no verificable.

### Persistencia

- Los artifacts se escriben después de validar su contenido.
- Las escrituras utilizan una estrategia atómica.
- El manifest registra `traceId`, plan, aprobación, backend, límites, stages, tareas, artifacts y hashes.
- Un run interrumpido se marca como `interrupted`.
- La corrupción se informa y no se ignora silenciosamente.

### Costes y límites

Los backends CLI pueden ejecutarse mediante suscripciones y no siempre exponen un coste monetario fiable.
Un coste desconocido no debe interpretarse como USD 0.
Durante la adopción, los controles principales deben ser:

- `maxTasks`;
- `maxParallel`;
- timeout;
- aprobación previa;
- límites del harness;
- revisión humana.

## Proyecto piloto recomendado

### Propuesta: implementar `slad doctor`

El primer proyecto recomendado es utilizar SLAD para implementar una nueva capacidad dentro del propio SLAD:

```text
slad doctor [--json]
```

`slad doctor` sería un diagnóstico read-only del entorno local antes de ejecutar planes.
La funcionalidad es útil por sí misma y permite probar el nuevo runtime con fallos reales y verificables.

### Objetivo

Proporcionar una evaluación rápida del estado del entorno necesario para ejecutar SLAD de manera segura.
El comando no debe lanzar agentes, modificar el repositorio ni reparar problemas automáticamente.

### Alcance funcional

El comando debería comprobar:

- disponibilidad de `codex`, `claude`, `pi` y `agy`;
- versión de cada binario cuando pueda obtenerse de forma segura;
- ejecutabilidad del binario configurado;
- `LaunchSpec` efectivo del backend seleccionado;
- modelo configurado;
- existencia de Git y un `HEAD` válido;
- estado limpio o sucio del working tree;
- capacidad para crear worktrees;
- disponibilidad de tmux para el modo paralelo visible;
- permisos sobre rutas runtime de SLAD;
- runs activos, interrumpidos o corruptos;
- consistencia básica de manifests recientes;
- salida legible para humanos;
- salida JSON validada para automatización.

### No objetivos

La primera versión no debería:

- instalar binarios;
- iniciar sesión en proveedores;
- reparar configuración;
- cambiar el modelo activo;
- lanzar un LLM;
- borrar runs o artifacts;
- modificar Git;
- crear worktrees permanentes;
- incorporar una UI web.

### Contrato sugerido

El resultado debería incluir:

```text
status: healthy | warning | blocked
checks: DoctorCheck[]
summary: {
  passed: number
  warnings: number
  blockers: number
}
```

Cada check debería identificar:

- nombre;
- estado;
- mensaje humano;
- evidencia disponible;
- recomendación opcional;
- si el problema bloquea una ejecución.

La forma exacta debe definirse en `@slad/shared` mediante Zod antes de implementar el comando.
No debe diseñarse el JSON directamente dentro de la capa CLI.

## DAG sugerido para `slad doctor`

### T1 — Contrato compartido

**Ownership sugerido:**

```text
packages/shared/src/schemas.ts
packages/shared/src/index.ts
packages/shared/src/*doctor*.test.ts
```

**Responsabilidades:**

- definir `DoctorCheck` y `DoctorReport`;
- exportar tipos inferidos;
- añadir casos positivos y negativos;
- rechazar estados desconocidos y estructuras incompletas.

**Validación:**

```bash
corepack pnpm --filter @slad/shared typecheck
corepack pnpm --filter @slad/shared test
```

### T2 — Probes read-only

**Ownership sugerido:**

```text
packages/cli/src/core/doctor.ts
packages/cli/src/core/doctor.test.ts
```

**Dependencia:** T1.

**Responsabilidades:**

- comprobar binarios sin iniciar agentes;
- inspeccionar Git y soporte de worktrees;
- inspeccionar rutas runtime;
- detectar runs interrumpidos o corruptos;
- normalizar errores del sistema operativo;
- devolver el contrato compartido.

**Casos negativos:**

- binario ausente;
- comando de versión que falla;
- repositorio sin `HEAD`;
- directorio sin Git;
- ruta sin permisos;
- manifest corrupto;
- timeout al consultar un binario.

### T3 — Comando y presentación

**Ownership sugerido:**

```text
packages/cli/src/commands/doctor.ts
packages/cli/src/commands/doctor.test.ts
```

**Dependencias:** T1 y T2.

**Responsabilidades:**

- implementar salida humana;
- implementar `--json`;
- mantener stdout limpio en modo JSON;
- producir exit codes documentados;
- evitar stack traces para fallos esperables;
- validar el report antes de imprimirlo.

### T4 — Documentación

**Ownership sugerido:**

```text
README.md
docs/architecture/README.md
```

**Dependencia:** T1.

T4 puede ejecutarse en paralelo con T2 porque su ownership es disjunto.

**Responsabilidades:**

- explicar el propósito del comando;
- incluir ejemplos de salida;
- documentar diferencias entre warning y blocker;
- aclarar que el comando es read-only;
- documentar limitaciones de backends como `agy`.

### T5 — Wiring y smoke E2E

**Ownership sugerido:**

```text
packages/cli/src/cli.ts
packages/cli/src/commands/doctor.e2e.test.ts
```

**Dependencia:** T3.

**Responsabilidades:**

- registrar `slad doctor`;
- comprobar `--help`;
- ejecutar el comando sobre un fixture sano;
- ejecutar el comando con un backend ausente;
- comprobar que `--json` puede parsearse y validarse;
- confirmar que el working tree no cambia.

## Criterios de aceptación del piloto

El piloto se considera exitoso cuando:

1. `slad doctor` termina sin modificar archivos.
2. Un entorno sano genera un `DoctorReport` válido.
3. Un backend ausente se reporta sin provocar un crash.
4. Un manifest corrupto aparece como problema explícito.
5. La salida JSON no contiene banners ni logs adicionales.
6. La salida humana explica cómo resolver warnings y blockers.
7. El comando no lanza ningún agente o LLM.
8. Los tests negativos cubren fallos de procesos y filesystem.
9. T2 y T4 pueden ejecutarse en paralelo sin conflictos de ownership.
10. Los resultados de los worktrees regresan como cambios staged.
11. El manifest del run termina correctamente.
12. Lint, typecheck, build y tests pasan desde la raíz.

## Intención sugerida para el piloto

```text
Implementar un comando top-level `slad doctor` read-only que diagnostique backends locales, Git, worktrees, rutas runtime y manifests recientes.
Debe ofrecer salida humana y `--json` validado mediante un contrato de `@slad/shared`.
No debe lanzar agentes, reparar el entorno ni modificar archivos.
Incluye pruebas negativas, smoke E2E y documentación.
```

## Comandos sugeridos para ejecutar el piloto

### Crear la sesión

```bash
slad pipeline session start \
  "Implementar slad doctor como diagnóstico read-only del entorno"
```

### Generar el plan sin ejecutar código

```bash
slad pipeline auto \
  "Implementar un comando top-level slad doctor read-only que diagnostique backends locales, Git, worktrees, rutas runtime y manifests recientes. Debe ofrecer salida humana y --json validado mediante @slad/shared. No debe lanzar agentes, reparar el entorno ni modificar archivos. Incluye pruebas negativas, smoke E2E y documentación." \
  --agent pi \
  --model openai-codex/gpt-5.5 \
  --dry-run \
  --max-tasks 6 \
  --harness strict
```

### Aprobar después de revisar

```bash
slad pipeline plan --approve \
  --reason "DAG, ownership, no objetivos y validaciones revisados"
```

### Ejecutar el DAG

```bash
slad pipeline run \
  --parallel \
  --worktrees \
  --strict-ownership \
  --max-parallel 2 \
  --max-tasks 6 \
  --harness strict \
  --non-interactive \
  --agent pi \
  --model openai-codex/gpt-5.5
```

### Revisar la integración

```bash
git status
git diff --cached
git diff --cached --check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

### Ejecutar smoke tests manuales

```bash
node packages/cli/dist/cli.js doctor
node packages/cli/dist/cli.js doctor --json
```

La salida JSON debería validarse contra el contrato canónico antes de considerarse correcta.

## Plan de adopción gradual

### Runs 1 y 2 — Observación

- Utilizar siempre `--dry-run` antes de aprobar.
- Revisar manualmente cada tarea y su ownership.
- Limitar el paralelismo a dos workers.
- No aplicar propuestas de `evolve` automáticamente.
- Revisar el manifest después de cada run.
- Comparar las afirmaciones de los workers con Git.

### Runs 3 a 5 — Confianza controlada

- Mantener `--strict-ownership`.
- Utilizar worktrees en planes paralelizables.
- Probar un caso con backend ausente.
- Ejecutar una cancelación controlada.
- Verificar que el run quede `interrupted`.
- Reanudar y comprobar que no se repitan artifacts válidos.

### Después de cinco runs estables

- Adoptar SLAD por defecto para tareas medianas.
- Mantener Pi directo para cambios pequeños.
- Aumentar `maxParallel` únicamente si el historial demuestra que el plan y ownership son confiables.
- Usar Herdr para revisiones independientes, bloqueos y decisiones sensibles.
- Incorporar aprendizajes durables solo después de revisarlos.

## Prueba controlada de interrupción y recuperación

La primera ejecución del piloto debe completarse sin introducir fallos artificiales.
Después de establecer ese baseline puede realizarse una segunda prueba controlada:

1. Generar un nuevo plan pequeño con al menos dos tareas.
2. Iniciar el run paralelo.
3. Cancelar una tarea mientras el proceso está activo.
4. Confirmar que el process group termina.
5. Inspeccionar el manifest.
6. Confirmar que el estado sea `interrupted` o `failed`, según corresponda.
7. Ejecutar resume.
8. Confirmar que los artifacts válidos no se publiquen dos veces.
9. Confirmar que el run llegue finalmente a un estado terminal.
10. Verificar que Git no contenga cambios parciales fuera de ownership.

Esta prueba no debe ejecutarse durante un cambio urgente ni sobre un working tree con trabajo no respaldado.

## Riesgos y mitigaciones

### Plan generado con ownership incorrecto

**Riesgo:** un agente necesita modificar un archivo que el plan no declaró.

**Mitigación:** revisar el plan antes de aprobar y mantener `--strict-ownership`.

### Tareas aparentemente paralelas con dependencia oculta

**Riesgo:** dos workers producen cambios semánticamente incompatibles aunque sus archivos sean distintos.

**Mitigación:** declarar dependencias de datos y contratos, no solamente intersecciones de archivos.

### Exceso de confianza en exit code 0

**Riesgo:** un backend termina con éxito técnico sin entregar un resultado verificable.

**Mitigación:** exigir un `RunOutput` válido y contrastar las afirmaciones con Git.

### Coste desconocido de CLIs con suscripción

**Riesgo:** interpretar coste desconocido como ejecución gratuita.

**Mitigación:** controlar tareas, paralelismo, timeout y aprobación, y reportar coste como desconocido.

### Acumulación de artifacts y memoria irrelevante

**Riesgo:** persistir cada detalle vuelve más difícil encontrar información útil.

**Mitigación:** diferenciar logs episódicos, decisiones del repositorio y memoria global durable.

### Dependencia excesiva del pipeline

**Riesgo:** aplicar SLAD a cambios triviales reduce velocidad y claridad.

**Mitigación:** conservar una ruta explícita de Pi directo para trabajo pequeño.

## Señales de éxito del nuevo workflow

El workflow está funcionando cuando:

- los planes son más fáciles de revisar que prompts libres extensos;
- las tareas paralelas tienen ownership claro;
- las interrupciones no dejan procesos ni runs ambiguos;
- los manifests permiten reconstruir qué ocurrió;
- Git confirma las afirmaciones de los workers;
- los cambios regresan staged y sin commits ocultos;
- los errores de contrato se detectan antes de publicar artifacts;
- Chris puede intervenir en fronteras sensibles sin supervisar cada comando;
- Pi mantiene una visión global sin convertirse en un ejecutor opaco;
- los aprendizajes útiles mejoran runs posteriores.

## Resultado esperado

El workflow final combina control humano con automatización gradual.
Pi sigue siendo el punto de entrada y el capitán.
Herdr mantiene visible el trabajo interactivo.
SLAD ejecuta planes aprobados bajo contratos y límites explícitos.
Git y CI determinan si el resultado puede integrarse.

El proyecto `slad doctor` es una primera prueba adecuada porque entrega valor real, contiene fallos operacionales plausibles y permite probar la nueva funcionalidad sin inventar un escenario artificial.
