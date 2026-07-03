# SLAD

**S**elf-**L**earning **A**utonomous **D**eveloper — a TypeScript framework and CLI for building agentic software-engineering pipelines on top of LLMs.

SLAD orchestrates the loop `explore → snapshot → plan → run → learn → evolve` and exposes a composable Agent SDK (`defineTool → defineStage → buildPipeline → createAgent`) you can use to build your own agents.

---

## Repository structure

This is a pnpm + Turborepo monorepo.

| Package | Purpose |
|---|---|
| `@slad/shared` | Zod schemas, granular `Permission` type, serializable contracts |
| `@slad/model-providers` | `ModelProvider` seam + `CliProvider` (spawns agent CLIs) + `ModelAdapter` (`generateObject` / `generateText` with auto-fix JSON) |
| `@slad/tools` | `defineTool()`, `ToolRegistry`, 9 builtin tools (`fs.readFile`, `shell.exec`, …) |
| `@slad/harness` | Execution harness: command classification, hooks, LDJSON audit log, `assertPermission()` |
| `@slad/hitl` | Human-in-the-loop transports (TTY, none) |
| `@slad/cache` | Stage output cache (`CacheStore`) |
| `@slad/pipeline` | `defineStage`, `runPipeline`, `buildSladPipeline`, the 5 SLAD stages, `createAgent()`, memory/telemetry providers, budget tracking |
| `@slad/cli` | `slad` CLI orchestrator |

Turbo builds `@slad/shared` first, then dependents in topological order.

---

## Setup

Requires Node 22+ and Corepack-enabled pnpm.

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

SLAD delegates model calls to a local agent CLI (`claude`, `codex`, …).
Run `slad setup` (or any command — setup runs automatically) to pick the binary, or configure it via `.env`:

```bash
SLAD_CLI_BINARY=claude
SLAD_CLI_ARGS=--print
SLAD_CLI_PROMPT_MODE=arg
SLAD_LOG_LEVEL=info
```

---

## Using the CLI

```bash
corepack pnpm dev:cli -- auto "agregá una función sum al módulo math"
```

Available commands:

| Command | Description |
|---|---|
| `slad auto <intent>` | Full pipeline: classify → explore → snapshot → plan → run → learn |
| `slad work <intent>` | Same as `auto` but skips the intent classifier |
| `slad ask <intent>` | Direct Q&A without running the pipeline |
| `slad explore <intent>` | Run only the explore stage |
| `slad snapshot` / `plan` / `run` / `learn` / `evolve` | Run individual stages |
| `slad chat` | Interactive REPL |
| `slad session start \| list \| use \| show` | Session state |
| `slad stats` / `version` | Diagnostics |

Common flags for `auto` / `work`:

```bash
slad auto "<intent>" \
  --agent claude              # CLI agent backend: claude | codex | pi | gemini | agent
  --model claude-opus-4-7     # provider-specific model id
  --harness on                # off | on | strict
  --max-cost 5                # USD budget
  --dry-run                   # stop after plan (no run/learn)
  --resume                    # resume previous session
  --debate                    # multi-model debate variant
  --json                      # machine-readable output
```

### Parallel run

```bash
slad pipeline run --parallel --agent pi -m openai-codex/gpt-5.5
```

Executes the session's plan in waves: tasks whose declared `files` don't overlap run concurrently, one agent-CLI worker per task (each in its own tmux window when run inside tmux, plain child processes otherwise).
Tasks that declare no `files` conservatively run alone.
Worker prompts, transcripts, and exit codes land under `.slad-os/sessions/<id>/tasks/<taskId>/`.
After each wave, `git status` is compared against the wave's declared files; violations are warned by default or fail the wave with `--strict-ownership`.

Add `--worktrees` for real isolation: each task runs in its own git worktree branched from a session integration branch (`slad/<sessionId>/…`), so workers physically can't touch each other's files and ownership is attributed per task.
Successful tasks are committed in their worktree and merged sequentially into the integration branch (dependents branch from the updated tip, so they see prior waves' work); at the end the result is squashed into the main worktree as staged, uncommitted changes — you review and commit.
Requires a committed HEAD; uncommitted changes in the main worktree are not visible to workers.
`--keep-worktrees` preserves the session worktrees and branches for debugging.

Filter to one workspace package:

```bash
corepack pnpm --filter @slad/cli test
corepack pnpm --filter @slad/pipeline test
```

---

## Using the Agent SDK

The CLI is just one consumer. You can embed SLAD in your own code via `createAgent()` from `@slad/pipeline`.

### Run the built-in SLAD pipeline

```ts
import { buildSladPipeline } from "@slad/pipeline";
import { createAgent } from "@slad/pipeline";
import { getProvider } from "@slad/model-providers";
import { createHarness } from "@slad/harness";
import { createHitlTransport } from "@slad/hitl";

const provider = await getProvider("cli"); // spawns the agent binary from SLAD_CLI_* env
const harness  = await createHarness({ mode: "on", maxPermission: "workspace" });
const hitl     = createHitlTransport("tty");

const pipeline = buildSladPipeline({
  stages: ["explore", "snapshot", "plan", "run", "learn"],
  prompts: { /* optional system prompt overrides */ },
  policies: { budget: { maxModelCalls: 50 } },
});

const agent = createAgent({
  model: provider,
  safety: harness,
  hitl,
  pipeline,
});

const result = await agent.run(
  { intent: "add a sum() to packages/math" },
  {
    onStageStart:    (stage) => console.log(`→ ${stage}`),
    onStageComplete: (stage) => console.log(`✓ ${stage}`),
    onArtifact:      (stage, value) => { /* persist artifacts */ },
  },
);

console.log(result.status, result.stages.map((s) => s.stageId));
```

### Define a custom tool

```ts
import { z } from "zod";
import { defineTool } from "@slad/tools";

export const searchDocsTool = defineTool({
  id: "docs.search",
  description: "Search internal documentation by keyword",
  permissions: ["network:read"],
  input:  z.object({ query: z.string() }),
  output: z.object({ hits: z.array(z.object({ url: z.string(), title: z.string() })) }),
  async run({ query }, ctx) {
    ctx.audit?.emit("docs.search.start", { query });
    const hits = await fetchDocs(query);
    return { hits };
  },
});
```

Then register it on the agent:

```ts
const agent = createAgent({
  model: provider,
  tools: [searchDocsTool, ...otherTools],
  pipeline,
});
```

### Define a custom stage

```ts
import { z } from "zod";
import { defineStage } from "@slad/pipeline";

const summarizeStage = defineStage({
  id: "summarize",
  inputSchema:  z.object({ text: z.string() }),
  outputSchema: z.object({ bullets: z.array(z.string()) }),
  permissions: ["read"],
  async run(input, ctx) {
    return ctx.model.generateObject({
      schema: z.object({ bullets: z.array(z.string()) }),
      system: "Summarize the input as 3-5 bullets. Output JSON only.",
      input: input.text,
    });
  },
});
```

Compose stages into a pipeline yourself with `runPipeline()` if you don't want the SLAD-specific stages.

### Inject memory and telemetry

```ts
import { WikiMemoryProvider } from "@slad/pipeline";
import { LDJSONTelemetry } from "@slad/pipeline";

const agent = createAgent({
  model: provider,
  memory: new WikiMemoryProvider("./.slad-os/memory"),
  telemetry: new LDJSONTelemetry("./.slad-os/telemetry.ldjson"),
  pipeline,
});
```

Inside a stage they're available as `ctx.memory` and `ctx.telemetry`. Each stage run is automatically wrapped in a telemetry span (`stage.<id>`) by the pipeline runner.

### Global memory bridge

Repo-local `docs/log/` is the canonical per-project record.
Additionally, after `slad learn` / `slad evolve`, if the global workflow scripts exist (`~/.agents/workflows/scripts/record-{learning,decision}.mjs`), the results are exported to `~/.agents/learnings/` and `~/.agents/decisions/` so cross-project memory aggregates in one place.
Best-effort: missing scripts or failures never break the command. Disable with `SLAD_GLOBAL_MEMORY=off`.

---

## Concepts cheat sheet

- **`ModelAdapter`** — typed wrapper around a provider. `generateObject({ schema, system, input | messages })` retries with auto-fix JSON; `generateText()` returns raw text.
- **`ToolDef<I,O>`** — Zod-validated tool with permissions. Registered in a `ToolRegistry` and reachable from stages via `ctx.tools.call("tool.id", input)`.
- **`Stage<I,O,S>`** — typed unit of work. Receives `StageContext` with `model`, `tools`, `audit`, `memory?`, `telemetry?`, `services`, `state`, `signal`, `emitArtifact`.
- **`PipelinePolicies`** — pipeline-level policies: `budget.maxModelCalls`, `humanApproval`, `checkpoint`, `audit`, `telemetry`.
- **`ExecutionHarness`** — gates dangerous operations. Hooks `beforeTask` / `afterTask`, classifies command output, exposes `assertPermission(p)`.
- **Granular permissions** — `workspace:read`, `workspace:write`, `process:exec`, `network:read`, `network:write`, …  See `@slad/shared`.

---

## Development tips

- Local ESM imports use `.js` extensions in source.
- Shared serializable contracts live in `packages/shared/src` — don't duplicate them.
- Typecheck resolves types from source (each package's `exports` maps `types` to `./src/index.ts`), so `pnpm typecheck` needs no prior build.
- Tests use `node --test` with `tsx/esm` loader. Run a single file: `node --import tsx/esm --test packages/<pkg>/src/foo.test.ts`.

## License

Private.
