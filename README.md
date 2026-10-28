# linux.do job search

Uses `playwright-cli` to attach to the Chrome you already logged in with, and talks to Discourse's JSON API. The scripts only move data around. All judging is left to the agent.

## Build first

Sources are TypeScript (`*.ts` at the repo root). `npm run build` compiles them to `dist/*.js`, and that is what you run. `dist/` is not in git.

```bash
npm install          # once: typescript + @types/node
npm run build        # or: npm run typecheck, which checks without writing
```

`data/` stays at the repo root, next to `dist/`.

## One round a day

```bash
# 1. grab the last two weeks of search results (new threads only)
node dist/search.js 招聘 内推码 招人 --new > urls.txt && node dist/fetch.js --file urls.txt

# 2. see what is unopened / what has new replies
node dist/pending.js --top=20

# 3. peek at a few summaries (cheap on context)
node dist/digest.js <topic_id> --chars=200

# 4. write down your call (append one line, never rewrite the file)
echo '{"at":"'"$(date -u +%FT%TZ)"'","id":123456,"read_upto":45,"verdict":"在看","note":"上海后端,远程,要简历"}' >> data/index.jsonl
```

`node dist/pending.js --urls` pipes straight into `node dist/fetch.js --file`:

```bash
node dist/pending.js --urls > urls.txt && node dist/fetch.js --file urls.txt
```

`--urls` only prints threads with updates. Add `--include-new` to also pull the ones you never opened:

```bash
node dist/pending.js --urls --include-new > urls.txt && node dist/fetch.js --file urls.txt
```

## Backfilling history

Slice by week, oldest to newest. When a window hits 50 results it queues the next page by itself, and stops when there is no next page.

```bash
node dist/search.js 招聘 --since=2025-01-01 > urls.txt   # first check how many there are
node dist/fetch.js --file urls.txt
```

If it dies, run the same command again. Windows you already fetched are skipped. There is no state file — the file name is the state.

## The four scripts

| File | Does | Does not |
|---|---|---|
| `fetch.ts` | Takes a batch of URLs, writes to `data/raw/`, logs one line | Judge relevance, decide what to fetch |
| `search.ts` | Works out which search URLs are still missing, prints one per line | Send requests, fetch post bodies |
| `pending.ts` | Compares disk against server, lists only the gaps | Score or rank by relevance |
| `digest.ts` | One thread → a few hundred words of summary | Write anything to disk |

Each builds to the same name under `dist/`: `fetch.ts` → `dist/fetch.js`. `lib.ts` holds the naming rule shared by the scripts, the shared JSON shapes, and the one option parser they all use. If either the naming rule or the parser forks, the cache either re-downloads forever or never resumes.

Every script explains itself. Read the contract from the tool, not from the code. Two levels, same as `rg`:

```bash
node dist/fetch.js -h        # short: usage, options, exit codes
node dist/fetch.js --help    # full: the same, plus disk paths and the traps
```

Start with `-h`. Run `--help` only when you need to know where a file lands, or why a run stopped.
Running a script with a required arg missing prints the short help and exits 2.

Options take a space: `--top 30`. `--top=30` works too. An unknown option is an error, not ignored —
that is why a typo stops instead of quietly doing the wrong thing.

## Disk layout

```
data/raw/search/招聘_after_2026-10-14_before_2026-10-21.json
data/raw/topic/2881282.json          merged thread, deduped by post id, never overwritten
data/raw/ids/2881282-at-40.json      post number table, a few dozen bytes
data/index.jsonl                     one line per judgement, the last line wins
data/notes.jsonl                     machine bookkeeping: what was asked, which posts are gone
```

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
- **Chinese keywords vary a lot in quality.** `招聘`: 35 of 50 results really contain the word. `内推`: 1 of 50, because the tokenizer also counts `推`. Before searching, check `帖子含词/50` in the search file name; below half, switch the word or add a `#非我莫属` category filter.
- **Deleted posts leave a permanent gap.** `pending.ts` confirms once against the post number table and remembers it, so it never loops forever on a post that isn't there.
- **The post number table is only valid at that height.** You can't trust "we asked last time" forever, or new replies arriving after the highest post was deleted would stay invisible. So the tail is re-asked every time, against the server's current highest post number.
- **Background Chrome tabs slow timers down.** The rate limiter can't poll on a short interval; it has to take a ticket and sleep exactly, otherwise 20 requests take 157 seconds.
- **Real rate limit on `/search.json` is lower than you'd guess.** Measured on 85 search requests: 60 ok, 25 blocked. A block returns Cloudflare's `Just a moment...` HTML, **not** a Discourse 429, and no `retry-after`. Waiting 45 seconds brings it back. So the default is 2 per 3 seconds, 2 in parallel (`--rate=2/3000 --conc=2`), and batches are aligned the same way.
- **Stop the whole batch on 429/403**, no retry. While Cloudflare is watching, retrying only makes it worse. URLs we didn't get are appended to `data/todo.txt`; a few minutes later `node dist/fetch.js --file data/todo.txt` picks up where it stopped.
- **Don't backfill in one run.** Stop after a dozen or so requests, come back later. `search.ts` resumes from file names, so stopping costs nothing.

## Word list

Good: `招聘`, `招人`, `求职`, `面经`, `hc`, `jd`
Bad: `内推` (bad tokenizing), `远程` (collides with proxy threads)
To use a weak word anyway, add a category filter: `内推 #非我莫属`
