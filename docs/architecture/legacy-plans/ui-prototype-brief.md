# SLAD OS — UI Prototype Brief

Brief para alimentar a Claude Design (o similar) para prototipar una capa
visual sobre SLAD OS. **No es spec de implementación**, es input para
exploración visual.

---

## 1. Por qué existe esta UI

SLAD OS hoy es CLI-only. Esta UI prototipa una capa visual para:

1. Hacer **inspeccionable** el pipeline tipado — artefactos JSON validados,
   decisiones HITL, cache hits — para usuarios que entienden lo que hace
   pero no quieren leer markdown.
2. Abrir la herramienta a **usuarios no-CLI-nativos** (PMs técnicos,
   diseñadores que codean, founders que orquestan agentes).
3. Exponer el **loop de aprendizaje** (learn + evolve) como una vista
   de "memoria del proyecto" navegable.

El CLI sigue siendo "expert mode". Esta UI es la "guided experience".

## 2. Convención visual base

Layout 3-paneles, alineado con Cursor / Conductor / Codex Desktop / Claude
Code Desktop. La convención existe por algo: los usuarios ya saben dónde
buscar lista de items, hilo principal, y detalle/diff. **NO inventar layouts.**

Lo que diferencia a SLAD está en el **contenido y la information
architecture**, no en la cáscara.

```
┌─────────────────┬──────────────────────────────┬────────────────────┐
│   SESSIONS  /   │      STAGE VIEW              │  ARTIFACT /        │
│   KNOWLEDGE     │      (active stage)          │  ACTION PANEL      │
│                 │                              │                    │
│   [list of      │   [breadcrumb of stages]     │  [JSON artifact    │
│    sessions     │                              │   or diff or DAG   │
│    with stage   │   [body — depends on stage]  │   depending on     │
│    progress]    │                              │   stage]           │
│                 │   [HITL input area, contex-  │                    │
│   + Nueva       │    tual cuando aplica]       │  [provider/model   │
│     intención   │                              │   selector + cost] │
└─────────────────┴──────────────────────────────┴────────────────────┘
```

## 3. Panel izquierdo — Sessions & Knowledge

Dos modos toggleables en el header del panel:

### Modo Sessions (default)

Lista de sesiones — cada una es una intención que viaja por el pipeline.
Por sesión mostrar:

- Intent original (truncado a 1-2 líneas)
- Timestamp de última actividad
- **Progreso visual del pipeline**: 6 indicadores horizontales para
  `explore → snapshot → plan → run → learn → evolve`. Estados:
  ✓ done, ◐ in-progress, · pending, ✗ failed, ⏸ awaiting_human
- Conteo de tasks si llegó a run (ej: "3/5 done")

Click → activa la sesión en el panel central.

### Modo Knowledge

La wiki/AGENTS.md viva del proyecto. Lista de patrones aprendidos,
decisiones, errores históricos, anti-patrones. Cada item:

- Categoría (decisión / patrón / error / follow-up)
- Snippet del aprendizaje
- Link a la sesión que lo produjo
- Timestamp

Filtros por categoría arriba. Búsqueda full-text.

## 4. Panel central — Stage View

**No es un chat con mensajes en serie.** Es una vista del stage activo de
la sesión seleccionada.

**Top:** breadcrumb del pipeline cliqueable para saltar entre stages de la
sesión activa. Stage actual resaltado. Ej:

```
explore ✓ → snapshot ✓ → plan ✓ → [run T3] → learn · → evolve ·
```

**Body — depende del stage:**

- **Explore**: reframing del intent en grande arriba. Enfoques como cards
  horizontales con pros/cons. Riesgos como lista. Sección "open questions".
- **Snapshot**: el mini-spec renderizado, secciones colapsables (qué construir,
  qué NO construir, criterios de aceptación).
- **Plan**: DAG visual de tasks con dependencias. Nodos clickeables que abren
  detalle (archivos probables, criterios de aceptación, verification commands).
- **Run T<N>**: thread del Builder/Reviewer loop. Tool calls visibles como
  rows compactos (icono + nombre + arg preview, ej: `📄 write_file(roadmap.md)`).
  Verificación commands corren al final con status badges.
- **Learn**: cards agrupadas por tipo: decisión, error, patrón, follow-up.
- **Evolve**: dos paneles — diff propuesto a `AGENTS.md` a la izquierda,
  diff propuesto a la wiki externa a la derecha. Toggle "apply / reject"
  por sección.

**Bottom — HITL input area** (visible solo cuando `awaiting_human`):

Las preguntas del agente aparecen como cards con UI apropiada según tipo:

- `free` → textarea
- `choice` → radio group
- `confirm` → sí/no toggle
- `ranking` → lista draggable

NO es un input de chat libre. Es input estructurado para la pregunta específica.

## 5. Panel derecho — Artifact / Action

Contenido contextual al stage actual.

**Default**: muestra el artefacto JSON del stage activo, con toggle entre
"raw JSON" y "friendly view". El friendly view renderiza el schema Zod
en cards humanas.

**Cuando estás en Run**: cambia a panel de archivos modificados (lista
con counts +/-, click abre el diff inline) + verificación commands como
filas separadas con status (✓/✗/pendiente). El `verification[].command`
es ciudadano de primera clase — no es un afterthought como en Conductor.

**Cuando estás en Evolve**: muestra el preview de cambios a aplicar.

**Footer del panel — siempre visible**:

- Selector de provider/modelo (chip: `anthropic · claude-opus-4.6`)
- Indicador de tokens consumidos en la sesión
- Cost estimado en USD
- Toggle de harness mode (off / on / strict)

## 6. Diferenciadores visuales — qué mostrar que la competencia no puede

Estos son los elementos que hacen que la UI sea inconfundiblemente SLAD,
no un clon de Conductor:

1. **Pipeline progress siempre visible** — el breadcrumb del centro y los
   indicadores del sidebar. La pregunta "¿dónde estoy del flujo?" se
   contesta sin pensar. En Conductor todo es "una conversación".
2. **Artefactos JSON colapsables como first-class** — cualquier output
   del LLM es inspeccionable como dato estructurado, no prosa.
3. **HITL stages con UI dedicada** — preguntas tipadas, no mensajes en
   un chat. Esto solo es posible porque SLAD tipa las preguntas.
4. **Knowledge view** — vista de "qué aprendió el sistema sobre este
   proyecto". Ninguna herramienta de agentes paralelos tiene esto porque
   no tienen learning loop.
5. **Cache hit/miss badges** — pequeño indicador en cada stage diciendo
   "cache hit (saved $0.02)" o "ran fresh". Hace visible una primitive
   única.
6. **Provider switching mid-session** — el chip de provider/modelo abajo
   a la derecha cambia entre stages. Mostrá que la sesión puede tener
   `explore` con Gemini y `run` con Claude. Conductor no puede.

## 7. Estados / pantallas mínimas a prototipar

El MVP del prototipo, en orden:

1. **Empty state** — primera apertura, sin sesiones. Hero con input
   para "tu primera intención" y ejemplos clicables.
2. **Sesión activa en Plan** — DAG de tasks visible en el centro,
   sidebar con el progreso, panel derecho con el JSON del plan.
3. **Run T3 corriendo en vivo** — thread del builder con tool calls
   apareciendo. Panel derecho con archivos modificados crecente.
4. **Run T3 bloqueado por HITL** — cards de questions con el tipo de
   input correcto (radio, textarea, etc). Banner arriba: "T3 awaiting
   your input (round 1/3)".
5. **Evolve con diff propuesto a AGENTS.md** — review de qué se va a
   aplicar antes de hacer commit a la wiki.
6. **Knowledge view** — lista de patrones aprendidos con filtros y
   linkback a sesiones origen.

## 8. Tono visual

- **Dark mode default**. La audiencia builder es nocturna. Light mode
  opcional pero no prioritario.
- **Tipografía**: monospace (JetBrains Mono / IBM Plex Mono) para
  artefactos JSON, código, tool calls. Sans (Inter / Söhne) para
  UI chrome.
- **Densidad**: alta, tipo Linear. Esta no es una herramienta para
  navegar tomando café — el usuario quiere ver mucha info por pantalla.
- **Color**: paleta sobria de neutros + un acento por estado:
  - verde discreto para "completed / shipped"
  - amarillo/ámbar para "awaiting_human"
  - rojo solo para "failed / blocked"
  - azul/violeta para "in_progress"
- **NO gradients, NO glassmorphism, NO blur effects**. La herramienta
  es para builders inspeccionando un sistema, no un demo de showcase.

**Referencias estéticas concretas:**

- Linear — densidad, jerarquía tipográfica, paleta
- Tailwind UI dark — componentes y spacing
- Vercel Dashboard — sense of structure y data viz
- Raycast — keyboard-first behavior y empty states

## 9. NO hacer

- No agregar "agent personas" o avatares (no es asistente, es pipeline)
- No animaciones decorativas (sí transiciones funcionales entre stages)
- No mensajes con chat bubble — pensar en "stage cards", no en messages
- No replicar el sidebar de "workspaces" de Conductor — no son
  worktrees, son sesiones
- No selector de "agent type" — el agente es implícito por stage
  (Explorer, Planner, Builder, etc.)
- No onboarding wizard de 5 pasos — usuario llega, escribe intención,
  arranca

## 10. Cómo pegar esto en Claude Design

Prompt sugerido:

```
Necesito prototipar la UI de una herramienta CLI llamada SLAD OS que
estoy llevando a una capa visual.

SLAD OS es un pipeline tipado para coding agents: una intención del
usuario viaja por stages secuenciales (explore → snapshot → plan → run
→ learn → evolve) y cada stage produce artefactos JSON validados.

NO es un runner de agentes paralelos como Conductor. Es lo opuesto:
profundidad/auditabilidad, no throughput.

Quiero un prototipo de 3 paneles (sidebar + main + detail) en dark mode,
denso tipo Linear, que muestre los siguientes estados: [listar 1-6 de
sección 7].

Adjunto el brief completo abajo. Por favor diseñá estos 6 estados
priorizando los diferenciadores listados en sección 6.

[pegar contenido completo del brief]
```

## 11. Después del prototipo

Cuando tengas algo visualmente sólido:

1. Mostralo a 2-3 usuarios potenciales (un PM técnico, un diseñador que
   codea, un founder que orquesta agentes) y observá dónde se traban.
2. Iteralo en el design tool antes de tocar código.
3. Cuando converja, abrí un `slad explore "implementar UI desktop con
   stack [tu elección]"` y dejá que el propio SLAD planee la
   implementación. Recursión completa.
4. Considerá `tauri` o `electron + vite` para distribución desktop, o
   un dashboard web (Next.js) si querés despliegue más rápido. Cualquiera
   conecta al binario `slad` por subprocess + lee los artefactos de
   `docs/log/`.

---

**Una nota final sobre positioning**: la UI no puede contradecir el
mensaje del README. Si en algún momento el prototipo termina pareciendo
demasiado a Conductor visualmente, frená y revisitá secciones 6 y 9.
El test es: *"¿qué primitive de SLAD se ve en esta pantalla que en
Conductor no se podría ver?"* Si la respuesta es "ninguno", la pantalla
está mal diseñada.
