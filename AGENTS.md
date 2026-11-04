# Development Rules

Human-facing README: [README.md](README.md). This file is the LLM-facing guide: project
rules plus the step-by-step operating procedure the agent follows every run.

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

## Operating procedure (the daily loop, in order)

The agent never picks keywords, flags, or URLs — terms live in `data/terms.txt` (one per
line, `#` comments; missing file → exit 2). There are exactly two entry points:

```bash
bun run src/crawl.ts bootstrap   # first ever run, or weeks behind: full history, loop until drained
bun run src/crawl.ts daily       # every day after: watermark week to now, loop until drained
```

1. **Check the session first.** Fetching needs a `playwright-cli` session named `chrome`
   attached to the user's logged-in Chrome. If a crawl fails with `cannot talk to session
   "chrome"`, attach:

   ```bash
   TOKEN=$(head -1 ~/.pi/chrome-extension-token.txt) && PLAYWRIGHT_MCP_EXTENSION_TOKEN=$TOKEN playwright-cli attach --extension=chrome
   ```

   If fetches then fail with `TypeError: Failed to fetch` right after attaching, open
   `https://linux.do` once in the attached tab (`playwright-cli -s=chrome goto https://linux.do`),
   then rerun. Both failures look fatal but are just cold-start.

2. **On exit 1, read the message, then rerun the SAME command.** Two different causes:
   - 429/403 or `Failed to fetch` → Cloudflare. Wait a few minutes, rerun. Cache makes
     reruns free; nothing is fetched twice. Defaults are deliberately slow
     (`2 requests / 10 s, conc 1`, in both `crawl.ts` and `fetch.ts`) — keep them slow.
   - 400 `page parameter must not be greater than 10` → a saturated window. The weekly grid
     makes this rare; if it happens, narrow the term (`内推 #非我莫属`). Waiting will never fix a 400.
   `daily` advances the watermark itself, only after a round with 0 failed URLs. Exit 0 = drained.

3. **Judge after a green run** — this is the agent's real job:

   ```bash
   bun run src/pending.ts --top=20                       # unopened / has new replies
   bun run src/digest.ts <topic_id> --chars=200          # cheap summary, never fetches
   bun run src/digest.ts <topic_id> --full 43            # whole text of one post
   echo '{"at":"'"$(date -u +%FT%TZ)"'","id":123456,"read_upto":45,"verdict":"在看","note":"上海后端,远程,要简历"}' >> data/index.jsonl
   ```

   Append-only, last line wins. Watch crawl stderr for `WARNING ... filled all 10 search
   pages` — a term that saturates windows needs narrowing in `data/terms.txt`.

4. **One-off gap checks** (not part of the daily loop):

   ```bash
   bun run src/pending.ts --urls [--include-new] > urls.txt && bun run src/fetch.ts --file urls.txt
   ```

## How the crawl works underneath

`crawl.ts` loops search→fetch internally until drained; there is no urls.txt dance and no
manual watermark echo. Windows are 7 whole UTC days on a fixed grid anchored at 2023-01-01,
so the same week always lands in the same file name: finished weeks are cached forever, and
`--since` / `--until` / `--new` only pick grid weeks, they never shift keys. Only the live
(unfinished) week is re-fetched and overwritten every run, because it grows. A window that
returns a full 50 queues its next page by itself, up to page 10; page 1 missing → queue page
1 ONLY (whether page 2 exists is unknown until page 1 lands full). A window that fills all
10 pages is marked saturated and warned on stderr, never silently drained.

## Hard-won traps (read before touching the scripts)

- **`page=1` is the first page**, same as no `page`. Paging starts at 2; starting at 1 fetches everything twice.
- **The server rejects search `page > 10`** with a 400 (`page parameter must not be greater than 10`). This is why the grid is weekly, not monthly — 内推 in Oct 2026 filled 10 full pages (500 hits) in one month, and everything past page 10 was silently unreachable. Monthly looked cheaper (1–2 requests vs 4–5 per month) but cheap is worthless when it loses data.
- **A window that fills 10 pages is saturated**: hits past 500 per window are invisible to search. `search.ts` and `crawl.ts` print a WARNING with the window name. React by narrowing the term in `data/terms.txt`, not by retrying.
- **`posts_count` lies**: with deleted posts you get `posts_count=44` but `highest_post_number=45`. Only the latter can answer "any new replies?".
- **Do not add `order:latest`**. Measured: `内推` normally returns 39 hits, with `order:latest` only 1. It re-sorts by recency and weak matches push out real hits.
- **Chinese keywords vary a lot in quality.** `招聘`: 35 of 50 results really contain the word. `内推`: 1 of 50, because the tokenizer also counts `推`. `search.ts` prints this ratio per term on stderr; below half, switch the word or add a `#非我莫属` category filter.
- **`__dirname` under `bun run` is the script's own directory.** All data paths come from `src/lib/paths.ts`, which resolves `ROOT` two levels up from `src/lib` — never join `data/` from a script's own `__dirname`.
- **Background Chrome tabs slow timers down.** The rate limiter must take a ticket and sleep exactly, never poll on a short interval, or 20 requests take 157 seconds. (The limiter already does this.)
- **A 429 here is Cloudflare's challenge page** — HTML, no `retry-after`, not a polite Discourse rate limit. Retrying while it watches only makes it worse: one 429/403 stops the whole batch, unfetched URLs go to `data/todo.txt`.
- **A 400 is the opposite of a 429**: it will never succeed by waiting. Fix the query (usually page > 10 or a bad parameter).
- **`Execution context was destroyed, most likely because of a navigation`** from playwright-cli is just the tab navigating under the eval. Standard reaction: wait, rerun the same command.
- **A 200 is not proof a post exists.** The shape check in fetch-core guards `data/notes.jsonl`, so an error body can never be remembered as "post deleted".
- **The post number table is only valid at that height.** The tail is re-asked every time against the server's current highest post number, or replies landing after a deleted post would stay invisible.

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
