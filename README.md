# linux.do job search

Crawls and filters job posts on linux.do. The scripts talk to the Discourse JSON API
through your logged-in Chrome (`playwright-cli` attach) and only move data. Whether a
post is worth reading is judged by an AI agent, not by the scripts.

The full AI-agent documentation (usage steps, data contracts, traps we hit) lives in
[AGENTS.md](AGENTS.md).

## What it does

One crawl round a day: for each keyword in `data/terms.txt` (招聘 / 内推 / 实习 and so
on), it searches linux.do in weekly slices and saves the results to `data/raw/`. After
that, the AI summarizes each post and records its verdict in `data/index.jsonl` for
later review.

## Quick start

1. Log into linux.do in Chrome, then attach playwright-cli:

```bash
TOKEN=$(head -1 ~/.pi/chrome-extension-token.txt) && PLAYWRIGHT_MCP_EXTENSION_TOKEN=$TOKEN playwright-cli attach --extension=chrome
```

2. First run (or far behind):

```bash
bun run src/crawl.ts bootstrap
```

3. Then once a day:

```bash
bun run src/crawl.ts daily
```

A non-zero exit usually means Cloudflare blocked us: wait a few minutes and rerun the
SAME command. The cache makes reruns almost free.

## Environment

- [Bun](https://bun.sh) runs `src/*.ts` directly, no build step.
- `npm run typecheck` (tsc checks types only), `bunx @biomejs/biome@2.3.5 check src/` (lint).
- All data sits in `data/` at the repo root (not committed).

## Code layout

```
src/crawl.ts           AI entry point: bootstrap / daily loop
src/search.ts          CLI: which week windows are missing (prints URLs, sends nothing)
src/fetch.ts           CLI: batch-fetch URLs, write to data/raw/
src/pending.ts         CLI: local disk vs server gaps
src/digest.ts          CLI: one topic file → short text digest
src/core/              importable core logic (no exit, no printing)
src/lib/               paths, arg parsing, naming rule, JSON types
```

Every script explains itself with `-h` / `--help`. Design rules live in AGENTS.md.
