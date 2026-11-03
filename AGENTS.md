# Development Rules

## What this project is

linux.do job-search scripts. TypeScript under `src/`, run directly with Bun — no build step.
`tsc` type checks only. All judging is left to the agent; the scripts only move data around.

## Commands

- After any code change: `npm run check` (biome format + typecheck). Fix all errors before done.
- Run scripts as `bun run src/<script>.ts`. Never `tsc`-build or `node dist/`.
- Do not commit `data/` contents or touch files under `data/` outside a script run.

## Code style

- One concept per file, file named after it. A CLI entry (`src/*.ts`) stays thin: HELP text,
  arg parsing, then calls into `src/core/` or `src/cli/`. Logic goes below the entry, never in it.
- A CLI's contract is its `HELP` constant (`-h` / `--help`), including exit codes. Keep it
  accurate when behavior changes; the top-of-file comment never replaces it.
- No exit() and no console printing in `src/core/` and `src/cli/` logic files — they return
  data; only the entry prints and exits.
- No `any` unless truly unavoidable. No `@ts-ignore`. Top-level imports only, no `await import()`.
- No runtime checks TypeScript already guarantees. Validate only at trust boundaries
  (files on disk, JSON.parse results, CLI args).
- Comments explain why (cache rules, rate limits, disk contracts), never what the next line does.
- Never write the same logic twice: shared helpers live in `src/lib/`.
- Keep exit-code semantics: 0 ok · 1 recoverable failure (Cloudflare, fetch failed) · 2 bad usage.
  Cache and idempotence are invariants: reruns must never refetch or re-derive finished work.

## Data contracts

- `data/terms.txt`: one term per line, `#` comments. Only `crawl.ts` reads it.
- `data/search-state.json`: the `--new` watermark. Advance only after a round with 0 failures.
- `data/raw/<kind>/<id>-<key>.json`: the same URL always lands in the same file name
  (naming rule in `src/lib/naming.ts`). Topic files merge, never replace; writes are atomic.
- `data/index.jsonl`: one judgement per line, last line wins, append-only.
- `data/notes.jsonl`: machine bookkeeping, appended only; a stale ids table may be deleted
  so the next run re-asks the server.

## Git

- Stage explicit paths only; never `git add -A` / `git add .`.
- Never commit unless asked. Message format: `feat|fix|docs: <message>`.

## User Override

If the user's instructions conflict with any rule here, ask for explicit confirmation first.
