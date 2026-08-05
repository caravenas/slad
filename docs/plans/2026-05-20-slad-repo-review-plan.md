# SLAD Repository Hygiene and Architecture Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convert the initial architecture review of `slad` into an actionable cleanup and hardening plan.

**Architecture:** Keep the current monorepo structure (`@slad/shared`, `@slad/cli`, `@slad/ui`) intact. Focus first on repository safety and build hygiene, then address Next/Turbopack tracing and the UI/CLI persistence boundary.

**Tech Stack:** pnpm 9, Turbo 2, TypeScript, Node ESM, Next.js 16/Turbopack, Zod.

---

## Review Report Snapshot

### Repository overview

`slad` is a pnpm/Turbo monorepo with three active packages:

- `@slad/shared`: canonical Zod schemas and inferred shared types.
- `@slad/cli`: Node ESM CLI for the SLAD pipeline: `explore`, `snapshot`, `plan`, `run`, `learn`, `evolve`.
- `@slad/ui`: Next.js dashboard that imports shared contracts and adds UI-only behavior.

### Verification already run

From `/Users/christopheraravena/Projects/slad`:

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Observed results:

- `typecheck`: passed.
- `build`: passed.
- `test`: passed with 328 tests, 327 passed, 1 skipped.
- `git status`: failed because the directory is not currently a Git repository.

### Key findings

#### High priority

1. **Project is not under Git at the current root**
   - Evidence: `git status` returns `fatal: no es un repositorio git`.
   - Risk: no commit history, rollback, branching, PR review, or reliable change audit.

2. **`MONOREPO_PLAN.md` is not Markdown text**
   - Evidence: `file MONOREPO_PLAN.md` reports `Microsoft Word 2007+`.
   - Risk: broken diffs/search/LLM review; misleading extension.

#### Medium priority

3. **Next/Turbopack traces too much filesystem context**
   - Evidence: `next build` warning: `Encountered unexpected file in NFT list`.
   - Import trace: `next.config.ts` → `src/lib/session-files.ts` → `api/sessions/[id]/archive/route.ts`.
   - Related files:
     - `packages/ui/src/lib/config.ts`
     - `packages/ui/src/lib/session-files.ts`
     - `packages/ui/src/app/api/sessions/[id]/archive/route.ts`

4. **Turbo build outputs are incomplete for Next.js**
   - Evidence: Turbo warning: `no output files found for task @slad/ui#build`.
   - Current config: `turbo.json` uses only `dist/**` as build output.
   - Risk: incorrect or ineffective build caching for `@slad/ui`.

5. **Local artifact footprint is large**
   - Evidence: project size around `783M`; `packages/ui/.next` around `275M`.
   - Risk: slow searches, backups, syncs, and accidental inclusion if versioning is added incorrectly.

#### Low priority / design debt

6. **Shared contracts are centralized well**
   - Evidence: `packages/shared/src/schemas.ts` owns pipeline contracts and inferred types.
   - Recommendation: keep cross-package contracts here.

7. **UI is coupled to CLI docs layout**
   - Evidence: `packages/ui/src/lib/config.ts` falls back to `packages/cli/docs`.
   - Risk: persistence layout changes require UI changes.
   - Recommendation: define a storage adapter boundary later.

---

## Implementation Plan

### Task 1: Establish repository safety baseline

**Objective:** Make the project safe to modify by establishing whether Git should be initialized at `/Users/christopheraravena/Projects/slad` or whether this folder should be attached to an existing remote.

**Files:**
- Inspect: `/Users/christopheraravena/Projects/slad`
- Modify only if approved: `.git/`, `.gitignore`

**Step 1: Confirm Git status**

Run:

```bash
cd /Users/christopheraravena/Projects/slad
git status --short
```

Expected current result:

```text
fatal: no es un repositorio git ...
```

**Step 2: Decide repository strategy**

Choose one:

- Initialize local repo here: `git init`.
- Connect to an existing remote.
- Move this project into an existing repository root.

**Step 3: Verify `.gitignore` before first commit**

Check that these remain ignored:

```text
node_modules/
dist/
.next/
.turbo/
*.tsbuildinfo
.env
.env.local
```

**Step 4: Acceptance criteria**

- `git status --short` works from repo root.
- Build artifacts are not staged.
- `.gitignore` protects generated and secret files.

---

### Task 2: Fix the misleading `MONOREPO_PLAN.md` artifact

**Objective:** Ensure `MONOREPO_PLAN.md` is text Markdown, or rename the binary document to the correct extension.

**Files:**
- Inspect: `MONOREPO_PLAN.md`
- Potentially create: `docs/plans/monorepo-plan.md`
- Potentially rename: `MONOREPO_PLAN.docx`

**Step 1: Confirm file type**

Run:

```bash
cd /Users/christopheraravena/Projects/slad
file MONOREPO_PLAN.md
```

Expected current result:

```text
MONOREPO_PLAN.md: Microsoft Word 2007+
```

**Step 2: Choose remediation**

Option A — if the binary doc is still useful:

```bash
mv MONOREPO_PLAN.md MONOREPO_PLAN.docx
```

Option B — if Markdown is required:

- Export/convert the document contents into plain Markdown.
- Save as `docs/plans/monorepo-plan.md` or restore `MONOREPO_PLAN.md` as text.

**Step 3: Verify**

Run:

```bash
file MONOREPO_PLAN.md 2>/dev/null || true
file MONOREPO_PLAN.docx 2>/dev/null || true
```

Acceptance criteria:

- No `.md` file reports as `Microsoft Word 2007+`.
- Markdown documents are readable via text tools.

---

### Task 3: Clean generated artifacts before versioning

**Objective:** Reduce local noise and prevent generated artifacts from influencing searches, reviews, or initial commits.

**Files/dirs:**
- Remove generated artifacts only:
  - `packages/ui/.next/`
  - `packages/cli/dist/`
  - `packages/shared/dist/`
  - `.turbo/`

**Step 1: Measure current footprint**

Run:

```bash
cd /Users/christopheraravena/Projects/slad
du -sh . packages/ui/.next packages/cli/dist packages/shared/dist 2>/dev/null || true
```

Known previous observation:

```text
783M .
275M packages/ui/.next
2.5M packages/cli/dist
208K packages/shared/dist
```

**Step 2: Clean via package scripts**

Run:

```bash
corepack pnpm clean
rm -rf packages/ui/.next .turbo
```

**Step 3: Rebuild to ensure cleanup is reversible**

Run:

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

Expected:

- All commands pass.
- Generated files are recreated only as needed.
- Generated files remain ignored by Git.

---

### Task 4: Correct Turbo outputs for Next.js

**Objective:** Fix Turbo build cache metadata so `@slad/ui` build outputs are recognized.

**Files:**
- Modify: `turbo.json`

**Current relevant config:**

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```

**Step 1: Update build outputs**

Modify `turbo.json` build outputs to include Next output while excluding volatile cache:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
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

**Step 2: Verify**

Run:

```bash
corepack pnpm build
```

Expected:

- Build passes.
- The previous Turbo warning `no output files found for task @slad/ui#build` should disappear.

---

### Task 5: Reduce Next/Turbopack dynamic filesystem tracing

**Objective:** Remove or justify the Turbopack NFT warning caused by broad/dynamic filesystem usage in UI server code.

**Files:**
- Inspect/modify: `packages/ui/src/lib/config.ts`
- Inspect/modify: `packages/ui/src/lib/session-files.ts`
- Inspect/modify: `packages/ui/src/app/api/sessions/[id]/archive/route.ts`
- Reference: `packages/ui/AGENTS.md` says to read relevant Next.js 16 docs in `node_modules/next/dist/docs/` before changing Next-specific behavior.

**Step 1: Reproduce warning**

Run:

```bash
corepack pnpm --filter @slad/ui build
```

Expected current warning:

```text
Encountered unexpected file in NFT list
Import trace:
  App Route:
    ./packages/ui/next.config.ts
    ./packages/ui/src/lib/session-files.ts
    ./packages/ui/src/app/api/sessions/[id]/archive/route.ts
```

**Step 2: Read relevant Next docs**

Search/read local Next docs before making code changes, per `packages/ui/AGENTS.md`.

Look for docs related to:

- route handlers
- server-only modules
- output file tracing
- Turbopack ignore comments

**Step 3: Scope filesystem paths**

Potential approaches, in order of preference:

1. Make the session/docs root explicit via environment/config and avoid broad `process.cwd()`-based traversal at module import time.
2. Move filesystem reads/writes behind route-handler-local functions so they execute only on request.
3. Use Turbopack ignore comments only for paths that must remain dynamic and are known-safe.

**Step 4: Verify**

Run:

```bash
corepack pnpm --filter @slad/ui build
corepack pnpm typecheck
```

Acceptance criteria:

- Build still passes.
- NFT warning is gone, or a documented intentional exception exists with exact rationale.
- API route behavior remains unchanged.

---

### Task 6: Add tests for session archive filesystem behavior

**Objective:** Protect the archive route/session file behavior before refactoring the persistence boundary.

**Files:**
- Test candidate: `packages/ui/src/lib/session-files.test.ts` if test infra is added for UI.
- Alternative: add CLI/shared-level tests only if UI test runner is not configured yet.

**Step 1: Check UI test setup**

Run:

```bash
cd /Users/christopheraravena/Projects/slad
corepack pnpm --filter @slad/ui test
```

Expected current state may be missing script, because `packages/ui/package.json` currently has no `test` script.

**Step 2: Decide testing strategy**

Options:

- Add lightweight `node:test` setup for UI server utilities.
- Defer UI-specific tests and only refactor after adding a test script.

**Step 3: Minimum test cases**

Cover:

- Returns `null` when session directory is absent.
- Finds exact `${sessionId}.json`.
- Ignores `_cli-discovery` files.
- Archives JSON sessions by setting `archivedAt` under `value` when present.
- Archives Markdown sessions by adding/updating YAML `archivedAt`.

**Step 4: Verify**

Run:

```bash
corepack pnpm --filter @slad/ui test
corepack pnpm typecheck
```

Acceptance criteria:

- New tests pass.
- No production behavior change unless explicitly intended.

---

### Task 7: Formalize UI/CLI persistence boundary

**Objective:** Reduce coupling between `@slad/ui` and legacy CLI docs layout.

**Files:**
- Inspect: `packages/ui/src/lib/config.ts`
- Inspect: `packages/ui/src/lib/session-files.ts`
- Inspect: `packages/cli/src/persistence/*`
- Potential future shared adapter location:
  - `packages/shared/src/*` only for contracts/types, not Node filesystem code.
  - `packages/cli/src/persistence/*` for CLI implementation.
  - `packages/ui/src/lib/*` for UI server adapter.

**Step 1: Document current layouts**

Current paths observed:

- Preferred/default UI docs root may resolve to `docs`.
- Legacy fallback can resolve to `packages/cli/docs`.
- Sessions expected under `log/sessions`.

**Step 2: Define adapter interface**

Create a small internal interface in UI server code first, for example:

```ts
export interface SessionStore {
  findSessionFilePath(sessionId: string): string | null;
  archiveSessionById(sessionId: string): { archivedAt: string; filePath: string };
}
```

**Step 3: Keep contracts separate**

Do not move Node `fs` code into `@slad/shared`; it should remain runtime-specific.

**Step 4: Verify**

Run full gates:

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

Acceptance criteria:

- UI route calls a storage abstraction.
- CLI docs layout assumptions are localized.
- Shared package remains pure contracts/types.

---

## Final Quality Gates

Run from repo root:

```bash
cd /Users/christopheraravena/Projects/slad
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

Expected:

- All commands pass.
- No unexpected Turbo output warning.
- No unexpected Next/Turbopack NFT warning, or documented intentional exception.
- Git status shows only intended source/documentation changes.

---

## Suggested execution order

1. Task 1 — Git safety baseline.
2. Task 2 — Fix misleading `MONOREPO_PLAN.md`.
3. Task 3 — Clean artifacts.
4. Task 4 — Turbo outputs.
5. Task 5 — Turbopack tracing.
6. Task 6 — Tests for session archive behavior.
7. Task 7 — Persistence adapter boundary.

## Success criteria

The plan is complete when:

- The project is safely versioned or explicitly attached to a version-control strategy.
- Binary/text artifacts are named correctly.
- Generated artifacts are ignored and cleaned.
- Turbo cache outputs reflect both TypeScript `dist` and Next `.next` outputs.
- Next build warning is resolved or intentionally documented.
- UI session persistence has tests and a clearer adapter boundary.
