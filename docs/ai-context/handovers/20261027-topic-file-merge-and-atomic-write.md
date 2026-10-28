---
created_at: 2026-10-27
updated_at: 2026-10-27
topic: topic-file-merge-and-atomic-write
status: resolved
affected_modules: [fetch.js, mergeTopic, data/raw/topic]
tags: [merge, idempotent, atomic-write, data-loss, discourse]
---
# Merging Partial Topic Fetches Without Losing Data

## 1. Context & Problem

A topic arrives from two different endpoints with different shapes:

- `GET /t/<id>.json` → full topic metadata (`title`, `tags`, `posts_count`, `highest_post_number`, `last_posted_at`) plus `post_stream.posts` (**first 20** posts) and `post_stream.stream` (all post ids).
- `GET /t/<id>/posts.json?post_ids[]=...` → only `post_stream.posts`, no title, no tags, no counters, no `stream`.

Incremental reading means fetching posts in slices over many runs. Both responses must land in **one file per topic** and never lose earlier slices.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: `Object.assign({}, newDoc, {posts: merged})` — new response wins every field.
  - **Failure Reason**: A `posts.json` response carries no topic metadata, so it **blanked out** `title`, `posts_count`, `highest_post_number`, `last_posted_at`, `tags`. Verified: `title: undefined`, `highest: undefined` after merging a posts slice. Silent, and `digest.js` then printed an empty header.

- **Attempt**: Merge posts only, keeping `post_stream` from the new document.
  - **Failure Reason**: `post_stream.stream` (the full ordered id list) is dropped on every posts merge — measured 44 → 0. Nothing the scripts consumed broke, but the canonical id stream vanished.
  - Corollary that matters: `post_stream.stream[i]` ≠ post number `i+1` when posts were deleted, so that list is not a safe cursor anyway.

- **Attempt**: `fs.writeFileSync(path, json)` directly.
  - **Failure Reason**: A `Ctrl-C` or a full disk mid-write leaves a truncated file. Every later run then crashed with `SyntaxError` in `fetch.js` and `digest.js` — a permanently poisoned cache that only manual deletion fixed.

- **Attempt**: Compute the topic counters from the merged posts.
  - **Failure Reason (opposite direction)**: A merge that adds post #46 while the file still says `highest_post_number: 45` makes `digest.js` print `44楼 · 最高楼号45` directly above a `#46` row. The header lies.

## 3. Decision & Verified Solution

- **Chosen Approach**: Union posts by `id`; preserve every topic-level field the new response left `null`; keep the old `stream` when the new one is absent; **raise** the counters to `max(stored, observed)`; write through a temp file and `rename()`.
- **Key Changes**: `fetch.js` → `mergeTopic()`, `TOPIC_FIELDS`, temp-write + rename, corrupt-old-file fallback.
- **Minimal Code / Command Reference**:
  ```js
  const TOPIC_FIELDS = ["title","posts_count","highest_post_number","last_posted_at",
                        "created_at","category_id","tags","closed","archived","views"];

  function mergeTopic(oldDoc, newDoc) {
    const posts = new Map();
    for (const p of oldDoc?.post_stream?.posts || []) posts.set(String(p.id), p);
    for (const p of newDoc?.post_stream?.posts || []) posts.set(String(p.id), p);
    const merged = [...posts.values()].sort((a, b) => a.post_number - b.post_number);

    const base = Object.assign({}, oldDoc || {}, newDoc || {});
    for (const f of TOPIC_FIELDS) if (base[f] == null && oldDoc?.[f] != null) base[f] = oldDoc[f];

    const mergedMax = merged.length ? merged[merged.length - 1].post_number : 0;
    base.highest_post_number = Math.max(base.highest_post_number || 0, mergedMax);
    base.posts_count = Math.max(base.posts_count || 0, merged.length);

    const oldPs = oldDoc?.post_stream || {}, newPs = newDoc?.post_stream || {};
    return Object.assign(base, {
      post_stream: Object.assign({}, oldPs, newPs, {
        posts: merged, stream: newPs.stream || oldPs.stream || [],
      }),
      _known_post_ids: merged.map((p) => String(p.id)),
      _merged_at: new Date().toISOString(),
    });
  }
  ```
  ```js
  // write-then-rename: a Ctrl-C mid-write must not leave a half JSON that poisons every later run
  const tmpOut = `${abs}.tmp`;
  fs.writeFileSync(tmpOut, JSON.stringify(doc));
  fs.renameSync(tmpOut, abs);
  ```
  ```js
  // a corrupt old file must not block the new data
  let oldDoc = null;
  try { oldDoc = JSON.parse(fs.readFileSync(abs, "utf8")); }
  catch { console.log(`     (旧文件坏了，直接盖掉: ${dest.file})`); }
  if (oldDoc) doc = mergeTopic(oldDoc, doc);
  ```
- Verified: 20 → 44 posts and 20 → 740 posts merged with **zero** lost posts, zero duplicate ids, all 14 deleted post numbers accounted for, title/tags intact, `stream` preserved, and the merge is **idempotent** (running it twice changes nothing).

## 4. Hard Constraints for Future AI

- NEVER let a partial response overwrite topic-level metadata; only fill fields the new response left empty.
- ALWAYS raise `highest_post_number` / `posts_count` to at least what the merged posts prove, never lower them.
- ALWAYS write cache files through a temp file + `rename()`. Direct overwrite turns one interruption into a permanently broken cache.
- ALWAYS tolerate a corrupt existing cache file (log and overwrite) instead of crashing.
- ALWAYS dedupe by post `id`, never by array index or post-number arithmetic.
