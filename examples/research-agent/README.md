# research-agent — SLAD dogfood example

The **first official example** and the **forcing function** for the SDK boundaries
(Fase B of [`docs/architecture/slad-folder-structure.md`](../../docs/architecture/slad-folder-structure.md)).

It is a small research agent built **exclusively on the public SLAD SDK API** —
`createAgent` + `definePipeline` + `defineStage` + `defineTool`, run via the
`@slad/agent` runtime. No package internals are imported.

## Pipeline

```
{ topic }  →  plan-queries  →  gather  →  synthesize  →  { report, sources }
```

- **plan-queries** — `ctx.model.generateObject` turns a topic into focused search queries (Zod-validated).
- **gather** — runs each query through the `research.search` tool via `ctx.tools.call`.
- **synthesize** — `ctx.model.generateText` collapses findings into a markdown briefing.

A deterministic, offline `ModelProvider` (`src/mock-provider.ts`) makes the example
runnable with no API keys or network. Swap it for `getProvider("anthropic", apiKey)`
to run against a real model.

## Run

```bash
corepack pnpm install
corepack pnpm --filter research-agent start            # default topic
corepack pnpm --filter research-agent start "RAG eval" # custom topic
corepack pnpm --filter research-agent typecheck
```

## Constraint honored

This example only imports public package entrypoints (`@slad/agent`, `@slad/pipeline`,
`@slad/tools`, `@slad/model-providers`, `@slad/harness`, `zod`). It imports **no**
internal paths — verifiable with:

```bash
grep -rnE 'from "@slad/[^"]*/src|\.\./\.\./packages|/dist/' src/   # must be empty
```

## DX gaps found while building this (input to Fase C — API stabilization)

These are the friction points the dogfood surfaced. Each is a candidate for the
"align names / fill holes" work in §7 of the plan, **not** a blocker for this example.

1. **Two permission vocabularies.** `Tool.permissions` uses the granular
   `Permission` enum from `@slad/shared` (`network:read`, `workspace:write`, …),
   while `Stage.permissions` uses a different, coarser set
   (`"read" | "write" | "shell" | "network"`). A single permission model across
   stages and tools would remove a real source of confusion.

2. **No public test/mock `ModelProvider`.** To run *any* pipeline offline you must
   hand-roll a `ModelProvider`. `createNoopModelAdapter()` exists but throws on use.
   A `createScriptedProvider({...})` / `createMockProvider()` in
   `@slad/model-providers` would make every example and unit test trivial.

3. **`ModelProvider.name` is locked to `ProviderName`** (`"anthropic" | "openai" |
   "gemini" | "cli"`). A custom or mock provider cannot declare an honest name — the
   mock here has to masquerade as `"anthropic"`. The contract should allow arbitrary
   provider names (or add a `"custom"` member).

4. **Harness construction is heavy for the common case.** Wiring opt-in safety means
   `await createHarness(HarnessConfig.parse({ mode: "off", auditLog: false }))`.
   A zero-config default (an exported `noopHarness`, or `createAgent({ safety: "off" })`)
   would cut the ceremony for the 80% case.

5. **Tool calls from a stage are stringly-typed.** `ctx.tools.call<T>("research.search",
   input)` has no compile-time link between the tool id, its input schema, and the
   declared `T`. A typed handle — e.g. `ctx.tools.use(searchTool)` returning a typed
   function — would carry types end-to-end and prevent id/shape drift.

6. **Pipeline identity is optional.** `PipelineDefinition.id` / `version` are optional,
   but the §7.2 contract treats them as required (telemetry, checkpoints, and the
   registry all key off them). Making them required — or having `definePipeline`
   default them — would tighten the contract.
