---
created_at: 2026-10-27
updated_at: 2026-10-27
topic: incremental-topic-cache-dual-memo
status: resolved
affected_modules: [pending.js, fetch.js, data/notes.jsonl, data/raw/ids]
tags: [cache, incremental, idempotent, discourse, cursor, deleted-posts]
---
# Incremental Topic Cache: "Read Once, Still Catch New Replies"

## 1. Context & Problem

Requirement: never re-read a topic already judged, but never miss a comment appended months later to an old topic. Post bodies are 50–200 KB of JSON, so re-opening every known topic costs both requests and LLM tokens.

The enabling endpoint, verified live:

```
GET /t/<id>/post_ids.json?post_number=N
→ {"post_ids":[22607697,22607868,...]}     // 59 bytes for a short tail
```

It means "which post ids exist after post number N". So "does this old topic have a new reply?" costs ~60 bytes. If the answer is non-empty, fetch only those ids:

```
GET /t/<id>/posts.json?post_ids[]=A&post_ids[]=B&...
```

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Memoise the ids table as "final answer, never ask again" — keyed only by `anchor` (the post number asked about).
  - **Failure Reason (the critical one)**: If the server's `highest_post_number` was later **deleted**, an empty table written at that height gets trusted forever. A reply arriving afterwards as post 7 (post 6 deleted) stays invisible permanently. `pending.js` printed `有更新 0` and exit 0 — silent data loss, not an error.

- **Attempt**: Filter the miss-list with "ids I already have" only.
  - **Failure Reason**: An id that was live when the ids table was written and deleted afterwards never enters the known set, so the same `posts.json?post_ids[]=...` URL was emitted **every run, forever**. Requests succeeded (200, deleted ids silently dropped) and nothing changed. Infinite silent loop.

- **Attempt**: Map `post_stream.stream[i]` to post number `i+1`.
  - **Failure Reason**: Holds for the head only. In one topic, 44 posts had highest post number 45 (a deleted post in the middle), so index arithmetic misaligns. Compare id sets, never offsets.

- **Attempt**: Ask `/post_ids.json?post_number=N` and treat N itself as included.
  - **Failure Reason**: Returns posts **strictly after** N. `?post_number=1` returned post 2 first.

## 3. Decision & Verified Solution

- **Chosen Approach**: Two kinds of memo, with **different lifetimes**.
  - **Hole memo** (a gap *below* the local max): permanent. Ask once; an empty answer means a deleted post. Close it forever.
  - **Tail memo** (gap *above* the local max): valid **only at the server height it was taken at**. Store `{id, anchor, high}` in `data/notes.jsonl`; if the server's current `highest_post_number` differs, delete the stale ids file and re-ask.
- **Key Changes**:
  - `data/raw/ids/<id>-at-<anchor>.json` — the ids table.
  - `data/notes.jsonl` — append-only bookkeeping, two row types:
    `{"t":"asked","id":..,"anchor":N,"high":H}` and `{"t":"missing","id":..,"pid":[..]}`.
  - `fetch.js` diffs requested ids against returned ids after each `posts.json` and writes `missing` rows.
  - `pending.js` filters misses with `!knownIds.has(...) && !missing.has(...)`.
- **Minimal Code / Command Reference**:
  ```js
  // pending.js — the whole fix in three lines
  const tailIsFresh = !pick.tail || asked.get(`${id}:${pick.anchor}`) === high;
  if (!idsDoc || !tailIsFresh) {
    if (pick.tail && idsDoc) fs.unlinkSync(idsPath);   // stale table would re-answer the old question
    urls.push(`/t/${id}/post_ids.json?post_number=${pick.anchor}`);
    if (pick.tail) noteRows.push({ t: "asked", id, anchor: pick.anchor, high });
  }
  // else: min/max the misses, chunk at 50 ids per posts.json request
  ```
  ```js
  // fetch.js — only record deletions when the response really is a post list
  const looksLikePosts = doc && doc.post_stream && Array.isArray(doc.post_stream.posts) && !doc.errors;
  if (looksLikePosts && /\/posts\.json$/.test(url)) { /* diff asked vs returned → missing rows */ }
  ```
- Verified end-to-end: fresh backfill of a 44-post topic with a deleted #26 needed exactly 2 ids requests + 1 posts chunk, then converged to zero URLs and stayed there across repeated runs. A 740-post topic with 14 deleted numbers converged the same way.

## 4. Hard Constraints for Future AI

- NEVER treat an ids table as permanently valid for the tail; it is a snapshot of one server height.
- ALWAYS key the tail memo by `(topic_id, anchor, server highest_post_number)`.
- ALWAYS write a `missing` row for ids the server did not return, or `pending.js` loops forever.
- ALWAYS guard the `missing` row behind "the response body is actually a post list" — a `200` with `{"errors":[...]}` must not mark posts deleted.
- Pick reads: the states are silent. A wrong cache reports success. Test by re-running the same command twice and checking it converges to zero URLs.
