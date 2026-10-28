---
created_at: 2026-10-27
updated_at: 2026-10-27
topic: discourse-json-api-search-semantics
status: resolved
affected_modules: [linux.do-search, search.js, pending.js, fetch.js]
tags: [discourse, json-api, search, full-text, cjk, pagination]
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
  - **Failure Reason**: Ordering is by `bumped_at`, not creation time, so pages are **not** a stable reverse-chronological sequence. Measured: `page=0` newest 2026-10-27, `page=20` newest 2026-07-15, with overlap. Useless for deep history.

- **Attempt**: Treat `posts_count` as the cursor for "how far have I read".
  - **Failure Reason**: A deleted post makes `posts_count` (44) smaller than `highest_post_number` (45). Using `posts_count` silently skips a post, forever, with no error.

- **Attempt**: Assume two-character CJK terms search as well as longer ones.
  - **Failure Reason**: Tokenisation splits them. Measuring `帖子含词` (posts whose blurb actually contains the term) inside 50 results: `招聘` → 35/50 relevant, `内推` → **1/50**, because 推 alone matches 推荐/速推. `远程` collides with proxy/VPN topics. Always measure word quality before trusting a term list, or scope it with `#非我莫属`.

- **Attempt**: Quote the term (`"内推"`) to force exact matching.
  - **Failure Reason**: Returns only 36 topics and 1 real hit — worse, not better.

## 3. Decision & Verified Solution

- **Chosen Approach**: Week-window slicing over `after:`/`before:` for history, plain keyword search (no `order:`), and resuming from filenames on disk. Relevance ranking is left to the agent, not to the query.
- **Key Changes**: `search.js` emits `/search.json?q=<term>%20after%3A<A>%20before%3A<B>` and appends `&page=2,3,...` only when the previous page came back with a full 50.
- **Minimal Code / Command Reference**:
  ```js
  // window walking: one week per request, backwards from today
  for (let a = since; a < newest; a = new Date(a.getTime() + 7 * DAY)) {
    const b = new Date(Math.min(a.getTime() + 7 * DAY, newest.getTime()));
    const q = `${term} after:${ISO(a)} before:${ISO(b)}`;   // NO order:latest
  }
  ```

## 4. Hard Constraints for Future AI

- ALWAYS use `highest_post_number`, never `posts_count`, for "is there anything new".
- NEVER add `order:latest` to a relevance search. It destroys CJK results.
- NEVER page with `page=1`; the first page is no page, real paging begins at `page=2`.
- NEVER use the category `latest` feed for deep history; use `after:`/`before:` windows.
- ALWAYS measure a term's `帖子含词` ratio (hits / 50) before adding it to the term list. Below ~50%, replace the term or add `#非我莫属`.
