# linux.do job search

Uses `playwright-cli` to attach to the Chrome you already logged in with, and talks to Discourse's JSON API. The scripts only move data around. All judging is left to the agent.

## Run with Bun

Sources are TypeScript (`*.ts` at the repo root), run directly with [Bun](https://bun.sh) — no build step. Nothing is compiled, so there is no `dist/` to go stale.

```bash
bun run search.ts 招聘 内推码 招人 --new
```

`tsc` is kept for type checks only: `npm run typecheck`.

`data/` stays at the repo root.

## One round a day

```bash
# 1. grab the last two weeks of search results (new threads only)
bun run search.ts 招聘 内推码 招人 --new > urls.txt && bun run fetch.ts --file urls.txt

# 2. see what is unopened / what has new replies
bun run pending.ts --top=20

# 3. peek at a few summaries (cheap on context)
bun run digest.ts <topic_id> --chars=200

# 4. write down your call (append one line, never rewrite the file)
echo '{"at":"'"$(date -u +%FT%TZ)"'","id":123456,"read_upto":45,"verdict":"在看","note":"上海后端,远程,要简历"}' >> data/index.jsonl
```

`bun run pending.ts --urls` pipes straight into `bun run fetch.ts --file`:

```bash
bun run pending.ts --urls > urls.txt && bun run fetch.ts --file urls.txt
```

`--urls` only prints threads with updates. Add `--include-new` to also pull the ones you never opened:

```bash
bun run pending.ts --urls --include-new > urls.txt && bun run fetch.ts --file urls.txt
```

## Backfilling history

Slice by month, oldest to newest. Windows are whole UTC months on a fixed grid anchored at
2023-01-01, so the same month always lands in the same file name: finished months are cached
forever, and `--since` / `--until` / `--new` only pick grid months, they never shift keys.
Only the current (unfinished) month is re-fetched and overwritten every run, because it grows.

```bash
bun run search.ts 招聘 招人 求职 面经 hc > urls.txt && bun run fetch.ts --file urls.txt
```

A window that returns a full 50 queues its next page by itself, up to page 40. A month that
would need page 41 is too big for one window: the program exits 1 and that month must be
split by hand (`--since`/`--until` halves). If it dies, run the same command again — cached
months are skipped, only what is missing goes out.

`--new` monitors the daily loop. It fetches from the month of the watermark in
`data/search-state.json` (no file yet: last month) to now. A stale watermark costs nothing —
the months in between are already cached — but if it is a full month or more old, `search.ts`
warns. After a fetch round succeeds, advance the watermark (the exact line is printed on
stderr):

```bash
bun run search.ts 招聘 --new > urls.txt && bun run fetch.ts --file urls.txt
echo '{"last_new":"2026-10-29"}' > data/search-state.json
```

## The four scripts

| File | Does | Does not |
|---|---|---|
| `fetch.ts` | Takes a batch of URLs, writes to `data/raw/`, logs one line | Judge relevance, decide what to fetch |
| `search.ts` | Works out which search URLs are still missing, prints one per line | Send requests, fetch post bodies |
| `pending.ts` | Compares disk against server, lists only the gaps | Score or rank by relevance |
| `digest.ts` | One thread → a few hundred words of summary | Write anything to disk |

`lib.ts` holds the naming rule shared by the scripts, the shared JSON shapes, and the one option parser they all use. If either the naming rule or the parser forks, the cache either re-downloads forever or never resumes.

Every script explains itself. Read the contract from the tool, not from the code. One help text, same for both flags:

```bash
bun run fetch.ts -h        # same as --help: usage, options, disk behavior, exit codes
bun run fetch.ts --help
```

It is capped at ~25 lines. Editor-facing notes (the URL → disk-path mapping, the traps)
live in README, not in help output.
Running a script with a required arg missing prints the help and exits 2.

Options take a space: `--top 30`. `--top=30` works too. An unknown option is an error, not ignored —
that is why a typo stops instead of quietly doing the wrong thing.

## Disk layout

Where each URL lands (the same URL always lands in the same file):

```
/t/<id>.json, /t/<id>/posts.json     data/raw/topic/<id>.json      merged thread, deduped by post id
/t/<id>/post_ids.json?post_number=N  data/raw/ids/<id>-at-<N>.json post number table, a few dozen bytes
/search.json?q=...&page=N            data/raw/search/<q>[-pN].json
c/<id>/l/latest.json, /tag/<t>.json  data/raw/list|tag/...[-pN].json
/latest, /top, /new, ...             data/raw/site/<name>[-<period>][-pN].json
anything else                        data/raw/other/<path>-<hash>.json
data/index.jsonl                     one line per judgement, the last line wins
data/notes.jsonl                     machine bookkeeping: what was asked, which posts are gone
data/search-state.json               --new watermark: {"last_new":"YYYY-MM-DD"}
```

`<q>` and `<tag>` are filenames, so punctuation inside them gets a short hash suffix. An
existing topic file is merged, never replaced, and every write is atomic; the one exception
is a corrupt old file, which is overwritten after a warning.

`index.jsonl` fields: `id`, `read_upto` (last post you read), `verdict`, `note`. A `verdict` of `skip` or `noise` makes `pending.ts` mark the thread `[跳过]`.

`notes.jsonl` is written by the scripts. Two kinds of line:

- `{"t":"asked","id":...,"anchor":N,"high":H}` — asked once for posts after N, while the server's highest post number was H
- `{"t":"missing","id":...,"pid":[...]}` — the server says these posts don't exist (deleted), don't ask again

It exists for one reason: stop re-asking what was already asked and truly has nothing new, without letting deleted posts jam the flow. Delete it and the only cost is asking again.

## Traps we hit (read before touching the scripts)

- **`page=1` is the first page**, same as `page=2` being the second. So paging starts at 2; starting at 1 fetches everything twice.
- **`posts_count` lies**: with deleted posts you get `posts_count=44` but `highest_post_number=45`. Only the latter can answer "any new replies?".
- **`post_number=N` returns what comes after N**, N itself excluded.
- **Do not add `order:latest`**. Measured: it re-sorts by recency and weak matches push out real hits — `内推` normally returns 39 hits, with `order:latest` only 1.
- **Chinese keywords vary a lot in quality.** `招聘`: 35 of 50 results really contain the word. `内推`: 1 of 50, because the tokenizer also counts `推`. Before searching, check `帖子含词/50` in the search file name; below half, switch the word or add a `#非我莫属` category filter. `search.ts` now prints this ratio per term on stderr.
- **Monthly grid, not weekly.** Measured 2026-10: a busy month (招人, Sep 2026) is 70 hits = 2 pages; a quiet one (Jan 2024) is 9 hits = 1 page. Weekly would have been 4–5 requests for the same span, and 8 of the first 12 weekly runs came back full-50. Search reaches back to 2023 (Jan 2023 = 1 hit, nothing pruned).
- **`__dirname` under `bun run` is the script's own directory (the repo root), not `src/`.** A `path.join(__dirname, "..")` there points OUTSIDE the repo — all four scripts had it, found because the monthly cache never hit. `data/` paths must join from `__dirname` directly.
- **Deleted posts leave a permanent gap.** `pending.ts` confirms once against the post number table and remembers it, so it never loops forever on a post that isn't there.
- **The post number table is only valid at that height.** You can't trust "we asked last time" forever, or new replies arriving after the highest post was deleted would stay invisible. So the tail is re-asked every time, against the server's current highest post number.
- **Background Chrome tabs slow timers down.** The rate limiter can't poll on a short interval; it has to take a ticket and sleep exactly, otherwise 20 requests take 157 seconds. (The limiter in `fetch.ts` already does this.)
- **A 200 is not proof a post exists.** The shape check in `fetch.ts` guards `data/notes.jsonl`, so an error body can never be remembered as "post deleted".
- **Real rate limit on `/search.json` is lower than you'd guess.** Measured on 85 search requests: 60 ok, 25 blocked. A block returns Cloudflare's `Just a moment...` HTML, **not** a Discourse 429, and no `retry-after`. Waiting 45 seconds brings it back. So the default is 2 per 3 seconds, 2 in parallel (`--rate=2/3000 --conc=2`), and batches are aligned the same way.
- **Stop the whole batch on 429/403**, no retry. While Cloudflare is watching, retrying only makes it worse. URLs we didn't get are appended to `data/todo.txt`; a few minutes later `bun run fetch.ts --file data/todo.txt` picks up where it stopped.
- **Don't backfill in one run.** Stop after a dozen or so requests, come back later. `search.ts` resumes from file names, so stopping costs nothing.

## Word list

Good: `招聘`, `招人`, `求职`, `面经`, `hc`, `jd`
Bad: `内推` (bad tokenizing), `远程` (collides with proxy threads)
To use a weak word anyway, add a category filter: `内推 #非我莫属`
