---
created_at: 2026-11-03
updated_at: 2026-11-03
topic: src-layout-importable-cores
status: resolved
affected_modules: [crawl.ts, search.ts, fetch.ts, pending.ts, digest.ts, lib.ts, tsconfig.json, README.md]
tags: [refactor, architecture, cli, import, spawnSync, paths]
---

# Flat Root Scripts → src/ With Importable Core Modules

## 1. Context & Problem
All five scripts plus `lib.ts` sat at the repo root, and `crawl.ts` drove `search.ts` / `fetch.ts` via `spawnSync("bun", ["run", ...])`. This gave zero jump-to-definition, zero type checking on arguments, and stringly-typed shell glue. The user asked for direct imports plus a tidy file tree.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Keep `process.exit()` inside core modules and import them.
  - **Failure Reason**: `process.exit()` at import/call time kills the orchestrator (`crawl.ts` loop). Cores must throw instead.
- **Attempt**: `let watermark` variable kept "for later" in search-core.
  - **Failure Reason**: biome `noUnusedVariables` warning; the CLI layer already prints the watermark reminder, so the core does not need it.
- **Attempt**: Leave `tsconfig.json` at `module: commonjs` / `moduleResolution: node10` after the move.
  - **Failure Reason**: top-level `await` (fetch CLI, crawl loop) needs `module: esnext` + `moduleResolution: bundler`.
- **Trap**: A root-level `fetch.ts` survived as `M` (stale duplicate) after `rm` of the other root scripts — old file with uncommitted local edits is not deleted by `rm` of the *new* copies; verify with `git status --porcelain` and `git checkout -- <file>` it away.

## 3. Decision & Verified Solution
- **Chosen Approach**: Layered layout. Cores are pure importable functions (throw `FatalError`, return data, print nothing). CLIs are thin wrappers: parse argv → call core → print → map `FatalError` to exit 1. `crawl.ts` imports both cores directly; no `spawnSync` anywhere.
- **Key Changes**:
  - `src/lib/` — `types.ts` (JSON shapes), `naming.ts` (searchFile/safe/slug), `args.ts` (parseArgs/UsageError), `paths.ts` (single source of ROOT + all data/ paths; `ROOT = path.resolve(__dirname, "..", "..")` from `src/lib`), `fatal.ts` (FatalError).
  - `src/core/search-core.ts` — `search(terms, {mode, since, until})` returns `{urls, stats, relevance, ...}`; `readTerms(file)`.
  - `src/core/fetch-core.ts` — `async fetchAll(urls, {session,batch,conc,rateN,rateWindow})` returns `{ok, failed, total, seconds, todo, log, noteRows}`; writes notes/todo itself, caller prints.
  - `src/{crawl,search,fetch,pending,digest}.ts` — CLIs; help texts unchanged except `bun run x.ts` → `bun run src/x.ts`.
  - `tsconfig.json` — `rootDir: "src"`, `include: ["src/**/*.ts"]`, `module: esnext`, `moduleResolution: bundler`.
  - README commands all rewritten to `bun run src/...`.
- **Minimal Code / Command Reference**:
  ```ts
  // crawl.ts: typed orchestration, no subprocess
  import { search, readTerms } from "./core/search-core";
  import { fetchAll } from "./core/fetch-core";
  const r = search(terms, { mode: "new" });
  const report = await fetchAll(r.urls, { session: "chrome", batch: 20, conc: 2, rateN: 2, rateWindow: 3000 });
  ```

## 4. Hard Constraints for Future AI
- NEVER add `process.exit()` inside `src/core/*` — throw `FatalError`; only CLI files may exit.
- ALWAYS resolve data paths through `src/lib/paths.ts`; NEVER `path.join(__dirname, "data", ...)` from a script (that points to `src/<script>/data` after the move).
- ALWAYS keep the cache naming rule (`searchFile`) in `src/lib/naming.ts` shared by every writer/reader; a fork silently re-downloads forever or never resumes.
- A core returning data means the CLI owns ALL printing; if you add logging to a core, it must go through the returned `log` array.
