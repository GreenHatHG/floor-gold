---
created_at: 2026-10-27
updated_at: 2026-11-03
topic: discourse-json-api-search-semantics
status: resolved
affected_modules: [linux.do-search, search.ts, pending.ts, fetch.ts, digest.ts]
tags: [discourse, json-api, search, full-text, cjk, pagination, cache-grid]
---
# Discourse `/search.json` Semantics for Job-Post Search on linux.do

## 1. Context & Problem

linux.do runs on Discourse. The goal was to search job posts (招聘) including text written inside replies, using an LLM agent driving a real browser instead of a fixed scraper. I needed to know which endpoints exist, what they return, and which query operators actually work, before writing any code.

Verified live through an attached Chrome session (`page.evaluate` + `fetch` with session cookies, same-origin). All endpoints returned `200`.

`GET /search.json?q=<query>` returns keys: `posts`, `topics`, `users`, `categories`, `tags`, `groups`, `grouped_search_result`.

- `topics[]`: `id`, `title`, `posts_count`, `created_at`, `last_posted_at`, `category_id`, `tags[]`
- `posts[]`: `topic_id`, `post_number`, `username`, `blurb` — **replies are already in the results**, so "search inside comments" needs no extra work.
- 50 topics per page.

Working operators: `order:latest`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`, `#categoryname`, `page=N`, `in:title`, `in:all`, quoted phrases.

Category `27` = 「非我莫属」, slug `job`. `/tag/招聘.json` also works.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Add `order:latest` to every query to get fresh results.
  - **Failure Reason**: It re-ranks by recency and lets weak matches crowd out real ones. Measured: `q=内推` → 39 real hits across 50 topics; `q=内推 order:latest` → **1 hit**. `q=招聘` dropped from 137 hits to 66. NEVER emit `order:latest`.

- **Attempt**: Page a search with `page=0`, `page=1`, `page=2`.
  - **Failure Reason**: Discourse treats `page=1` as **the first page**, identical to no `page` param. Measured: `page=0` and `page=1` returned the same 50 topic ids; only `page=2` advanced. Real paging starts at 2.

- **Attempt**: Crawl history by paging the category feed `/c/27/l/latest.json?page=N`.
  - **Failure Reason**: Ordering is by `bumped_at`, not creation time, so pages are **not** a stable reverse-chronological sequence. Measured: `page=0` newest 2026-10-27, `page=20` newest 2026-07-15, with overlap. Useless for deep history. Also rejected as the primary source in 2026-10: job posts also appear outside 非我莫属, so category crawl would miss them.
- **Attempt**: Week-window slicing for history (`after:`/`before:` 7 days apart).
  - **Failure Reason**: The cache key is the exact query string, so a window only hits if both dates repeat. Windows were anchored on "today", which moves daily: `--new` re-fetched both weeks every single day (never cached), full runs re-fetched the trailing window daily, and any `--since` other than the default shifted every key. Measured 2026-10: a busy month (招人, Sep 2026) is 70 hits; weekly slicing needed 4–5 requests for the same span and 8 of the first 12 weekly windows came back full-50 (extra page-2 requests).
- **Attempt**: Fixing the overlap by snapping windows to a fixed weekly grid.
  - **Failure Reason**: Superseded before implementation — monthly windows measured strictly better (1–2 requests per month per term vs 4–5), so the grid was built on months instead.
- **Attempt**: `path.join(__dirname, "..")` for the `data/` root in all four scripts.
  - **Failure Reason**: Under `bun run`, `__dirname` is the script's own directory — the repo root. The extra `..` pointed `data/raw` OUTSIDE the repo (`projects/data/raw`), so no script ever saw its cache. Found by the monthly rewrite; fixed in all four scripts. See `20261029-bun-dirname-repo-root.md`.
- **Attempt**: First draft of the monthly rewrite queued `&page=2` for every month whose page 1 was not on disk ("92 requests for 46 months").
  - **Failure Reason**: Whether page 2 exists is unknown until page 1 comes back FULL (50 topics). Queueing it blind doubles the backfill for every quiet month (most months need 1 request). Fix: when page 1 is missing, queue page 1 ONLY; page 2+ is queued on a later run, after page 1 landed full. Caught by dry-run diff (46 expected URLs, got 92) before any request was sent.

- **Attempt**: Treat `posts_count` as the cursor for "how far have I read".
  - **Failure Reason**: A deleted post makes `posts_count` (44) smaller than `highest_post_number` (45). Using `posts_count` silently skips a post, forever, with no error.

- **Attempt**: Assume two-character CJK terms search as well as longer ones.
  - **Failure Reason**: Tokenisation splits them. Measuring `帖子含词` (posts whose blurb actually contains the term) inside 50 results: `招聘` → 35/50 relevant, `内推` → **1/50**, because 推 alone matches 推荐/速推. `远程` collides with proxy/VPN topics. Always measure word quality before trusting a term list, or scope it with `#非我莫属`.

- **Attempt**: Quote the term (`"内推"`) to force exact matching.
  - **Failure Reason**: Returns only 36 topics and 1 real hit — worse, not better.
- **Attempt**: Score relevance from page 1 only, guarded by `if (!relTotal)` (the 2026-10-29 `blurbHit`).
  - **Failure Reason**: Two silent biases. (1) The guard meant only the FIRST cached month window ever scored — the number was a single-month sample, not the range. (2) Blurb-only matching misses title hits, and no weighting by `posts_count` treats a 200-reply topic equal to a 2-reply one. Also, scoring ran BEFORE fetch, so months fetched by that very run never counted.
- **Attempt**: Normalize relevance to pct = hit / Σweight (not / Σmaxscore).
  - **Failure Reason**: Upper bound becomes unpredictable (67%–100% depending on hit mix), so pcts are not comparable across terms or months. Divide by the MAX possible score instead.

## 3. Decision & Verified Solution

- **Chosen Approach**: Month-window slicing on a fixed UTC grid anchored at 2023-01-01 (windows are `[2023-01+k, 2023-01+k+1)` for whole months k), plain keyword search (no `order:`), resuming from filenames on disk. `--since`/`--until`/`--new` only SELECT grid months — they never shift the keys — so finished months are cached forever; only the current, unfinished month is re-fetched and overwritten each run. `--new` starts at the month of the watermark in `data/search-state.json` (no file yet: last month); a stale watermark costs nothing because the months in between are already cached, but a full-month gap prints a warning. A month that would need page 41 makes `search.ts` exit 1: that month must be split by hand, never silently truncated. Relevance scoring (rewritten 2026-11-03) runs AFTER the fetch loop over ALL cached pages of every month; score = title hit ×2 + blurb hit ×1, weighted by `posts_count` (clamped to ≥1); pct divides by max score (3×Σweight) so it stays 0–100 with 50% ≈ one of the two fields hits per post on average. Output is a per-month table on stderr; months with no cache show `数据未抓取`, never silently skipped. URL scheduling is unchanged.
- **Key Changes**: `search.ts` rewritten (2026-10-29): monthly grid, exit-1 on page 40 full, `--until` option, `--new` watermark + stderr hint line for updating it, flat paging loop. Relevance rework (2026-11-03, commit 46de3ea): `scoreMonth(word, q)` replaces `blurbHit`; joins `posts[].topic_id` → `topics[]` for `title`/`posts_count`; second loop after fetch fills `relevance[term][]` per month; table rows `YYYY-MM  hit/total  pct`. All four scripts: `data/` paths now join from `__dirname` directly (no `..`). Probe-verified: Sep 2026 招人 = 70 hits/2 pages; Jan 2024 = 9 hits; Jan 2023 = 1 hit (search reaches 2023, nothing pruned).
- **Minimal Code / Command Reference**:
  ```ts
  const scoreMonth = (word: string, q: string): { hit: number; total: number } | null => {
    for (let p = 1; p <= PAGE_MAX; p++) {
      const doc = JSON.parse(fs.readFileSync(path.join(RAW, searchFile(q, p === 1 ? null : p)), "utf8"));
      if (!doc || !Array.isArray(doc.posts)) break;
      const topics = new Map<number, FeedTopic>();
      for (const t of doc.topics ?? []) topics.set(t.id, t);
      for (const post of doc.posts) {
        const t = post.topic_id === undefined ? undefined : topics.get(post.topic_id);
        const w = Math.max(1, t?.posts_count ?? 1);
        const s = (typeof t?.title === "string" && t.title.includes(word) ? 2 : 0)
                + (typeof post.blurb === "string" && post.blurb.includes(word) ? 1 : 0);
        hit += s * w; total += 3 * w;   // 3 = max per post, keeps pct in 0–100
      }
      if (doc.posts.length < PAGE_CAP) break;
    }
  };
  ```
- **Minimal Code / Command Reference**:
  ```ts
  // The grid: month 0 is 2023-01, windows are [monthStart(i), monthStart(i+1)).
  const monthStart = (i: number): Date => new Date(Date.UTC(2023, i, 1));
  const monthIndexOf = (d: Date): number => (d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth();
  const q = `${term} after:${ISO(monthStart(mi))} before:${ISO(monthStart(mi + 1))}`; // NO order:latest
  ```

## 4. Hard Constraints for Future AI

- ALWAYS use `highest_post_number`, never `posts_count`, for "is there anything new".
- NEVER add `order:latest` to a relevance search. It destroys CJK results.
- NEVER page with `page=1`; the first page is no page, real paging begins at `page=2`.
- NEVER use the category `latest` feed for deep history; use `after:`/`before:` windows.
- ALWAYS measure a term's hit ratio before adding it to the term list. Below ~50%, replace the term or add `#非我莫属`.
- ALWAYS score relevance over ALL cached pages and AFTER the fetch loop; NEVER sample only page 1 of the first available month.
- ALWAYS divide a weighted score by the MAX possible score (3×Σweight), never by Σweight alone — otherwise pct has no fixed upper bound and is not comparable.
- ALWAYS anchor time windows on the fixed 2023-01-01 month grid. NEVER derive window endpoints from `new Date()` (today) — that is what broke cache hits before.
- NEVER queue page N+1 when page N is not on disk; only a FULL cached page N earns a page N+1 request.
- NEVER join `data/` paths with `path.join(__dirname, "..")`; `__dirname` is already the repo root under `bun run`.
