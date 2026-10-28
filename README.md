# linux.do job search

Uses `playwright-cli` to attach to the Chrome you already logged in with, and talks to Discourse's JSON API. The scripts only move data around. All judging is left to the agent.

## One round a day

```bash
# 1. grab the last two weeks of search results (new threads only)
node search.js 招聘 内推码 招人 --new > urls.txt && node fetch.js --file urls.txt

# 2. see what is unopened / what has new replies
node pending.js --top=20

# 3. peek at a few summaries (cheap on context)
node digest.js <topic_id> --chars=200

# 4. write down your call (append one line, never rewrite the file)
echo '{"at":"'"$(date -u +%FT%TZ)"'","id":123456,"read_upto":45,"verdict":"在看","note":"上海后端,远程,要简历"}' >> data/index.jsonl
```

`pending.js --urls | ...` pipes straight into `fetch.js --file`:

```bash
node pending.js --urls > urls.txt && node fetch.js --file urls.txt
```

`--urls` only prints threads with updates. Add `--include-new` to also pull the ones you never opened:

```bash
node pending.js --urls --include-new > urls.txt && node fetch.js --file urls.txt
```

## Backfilling history

Slice by week, newest to oldest. When a window hits 50 results it queues the next page by itself, and stops when there is no next page.

```bash
node search.js 招聘 --since=2025-01-01 > urls.txt   # first check how many there are
node fetch.js --file urls.txt
```

If it dies, run the same command again. Windows you already fetched are skipped. There is no state file — the file name is the state.

## The four scripts

| File | Does | Does not |
|---|---|---|
| `fetch.js` | Takes a batch of URLs, writes to `data/raw/`, logs one line | Judge relevance, decide what to fetch |
| `search.js` | Works out which search URLs are still missing, prints one per line | Send requests, fetch post bodies |
| `pending.js` | Compares disk against server, lists only the gaps | Score or rank by relevance |
| `digest.js` | One thread → a few hundred words of summary | Write anything to disk |

`lib.js` holds one naming rule shared by two scripts. If that rule forks, the cache either re-downloads forever or never resumes.

## Disk layout

```
data/raw/search/招聘_after_2026-10-14_before_2026-10-21.json
data/raw/topic/2881282.json          merged thread, deduped by post id, never overwritten
data/raw/ids/2881282-at-40.json      post number table, a few dozen bytes
data/index.jsonl                     one line per judgement, the last line wins
data/notes.jsonl                     machine bookkeeping: what was asked, which posts are gone
```

`index.jsonl` fields: `id`, `read_upto` (last post you read), `verdict`, `note`. A `verdict` of `skip` or `noise` makes `pending.js` mark the thread `[跳过]`.

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
- **Deleted posts leave a permanent gap.** `pending.js` confirms once against the post number table and remembers it, so it never loops forever on a post that isn't there.
- **The post number table is only valid at that height.** You can't trust "we asked last time" forever, or new replies arriving after the highest post was deleted would stay invisible. So the tail is re-asked every time, against the server's current highest post number.
- **Background Chrome tabs slow timers down.** The rate limiter can't poll on a short interval; it has to take a ticket and sleep exactly, otherwise 20 requests take 157 seconds.
- **Real rate limit on `/search.json` is lower than you'd guess.** Measured on 85 search requests: 60 ok, 25 blocked. A block returns Cloudflare's `Just a moment...` HTML, **not** a Discourse 429, and no `retry-after`. Waiting 45 seconds brings it back. So the default is 2 per 3 seconds, 2 in parallel (`--rate=2/3000 --conc=2`), and batches are aligned the same way.
- **Stop the whole batch on 429/403**, no retry. While Cloudflare is watching, retrying only makes it worse. URLs we didn't get are appended to `data/todo.txt`; a few minutes later `node fetch.js --file data/todo.txt` picks up where it stopped.
- **Don't backfill in one run.** Stop after a dozen or so requests, come back later. `search.js` resumes from file names, so stopping costs nothing.

## Word list

Good: `招聘`, `招人`, `求职`, `面经`, `hc`, `jd`
Bad: `内推` (bad tokenizing), `远程` (collides with proxy threads)
To use a weak word anyway, add a category filter: `内推 #非我莫属`
