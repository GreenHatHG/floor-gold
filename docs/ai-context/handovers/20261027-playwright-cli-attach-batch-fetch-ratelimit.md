---
created_at: 2026-10-27
updated_at: 2026-10-27
topic: playwright-cli-attach-batch-fetch-ratelimit
status: resolved
affected_modules: [fetch.js, chrome-extension-attach, rate-limiter, cloudflare-block-handling]
tags: [playwright-cli, chrome, rate-limit, cloudflare, concurrency, background-tab, batch]
---

# Driving Real Chrome via playwright-cli for Rate-Limited JSON Batch Fetch

## 1. Context & Problem

The site sits behind Cloudflare and requires a logged-in session. The reliable path is `playwright-cli attach --extension=chrome`, which connects to the user's **already-running, already-logged-in** Chrome through the "Playwright MCP Bridge" extension. Then `playwright-cli eval` runs JS inside that page, where `fetch()` is same-origin and carries the session cookies — no login flow, no Cloudflare fight, no headless browser.

Two separate problems live here: (a) how to batch many JSON fetches through that one page, and (b) how fast you may actually go before Cloudflare stops answering.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Do the rate limiting in Node, one `playwright-cli` process per URL.
  - **Failure Reason**: Every invocation is a separate process with no memory of the previous request, so a sliding window is impossible. Also 1883 topics = 1883 process spawns.

- **Attempt**: Poll for a free slot every 100 ms inside the page (`await sleep(100)` in a loop).
  - **Failure Reason**: **Chrome clamps `setTimeout` in background tabs** (throttling to ~1 s or worse). Polling makes the whole batch crawl: 20 tiny requests took **157 s**, with individual requests reporting 7–8 s. No error, only slowness — easily misdiagnosed as a network problem.

- **Attempt**: Reset the limiter state per batch (page-side only).
  - **Failure Reason**: The window is per-`eval`. With a fast batch boundary, two batches back-to-back double the rate: measured **12 starts in 3 s** instead of 6. Retries also bypassed `slot()` because the retry path `continue`d without re-acquiring.

- **Attempt**: Return all bodies in the `eval` result.
  - **Failure Reason**: Result payload becomes huge and lands in the agent's context. Use `playwright-cli eval --filename=<tmp>` to write to a file instead.
  - Related: the result file is **not** written if the page navigates mid-eval. Must detect missing URLs and fail, or the run exits 0 having produced nothing.

- **Attempt**: Numeric CLI options with `Number(...)` and no lower bound.
  - **Failure Reason**: `--batch=0` made `i += 0` → infinite loop, forever, silently. Validate every numeric flag with a minimum and `exit 2`.

- **REVERSED — Attempt**: Run at the user-supplied budget of **6 requests / 3 s, 3 concurrent**, and retry `429` with exponential backoff (4 s, then 8 s).
  - **Failure Reason**: That budget is fine for cheap endpoints but too fast for `/search.json`. Measured over 85 search requests: **60 ok, 25 blocked**. The response is **not** a Discourse 429 — it is a Cloudflare challenge page (`<title>Just a moment...</title>`), **HTML, with no `retry-after` header**. So there was nothing to back off by, and the retry loop treated a human-verification challenge as a transient error: it kept hitting a wall Cloudflare was actively watching. Rate was the only lever left, and retrying was strictly harmful. Service came back after ~45 s of real silence.

- **Attempt**: Probe the true limit by firing a 25-request sequence at 2 s intervals to map where it breaks.
  - **Failure Reason**: This is someone's real account. Deliberately provoking a challenge to satisfy curiosity is not acceptable, and the previous 85-request run had already produced the answer. The user stopped it. **Do not run rate-limit probes against a live logged-in account.** Read the failure from a normal run instead: status code, whether the body is HTML, how long silence takes to clear it.

## 3. Decision & Verified Solution

- **Chosen Approach**: **Batch in, batch out** — Node passes a batch of URLs to one `eval`; the page holds the concurrency semaphore and the sliding window; Node aligns batch boundaries to the same quota so the limit is global, not per batch. Defaults lowered to **2 requests per 3 s, 2 concurrent**. A `429` or `403` **stops the whole batch immediately with no retry**, and every URL that did not land is written to `data/todo.txt` for a later run.
- **Key Changes**: `fetch.js` — `runBatch()` returns `{results, blocked}`; page code sets a shared `blocked` flag so queued requests exit as `skipped` instead of firing; Node breaks out of the batch loop, appends remaining URLs to `notDone`, and writes `data/todo.txt`.
- **Minimal Code / Command Reference**:
  ```js
  // page side: queue-based semaphore + exact sleep, NEVER a polling loop
  const acquire = async () => { if (inflight < CONC) { inflight++; return; }
    await new Promise((r) => waiting.push(r)); };
  const release = () => { const next = waiting.shift(); if (next) next(); else inflight--; };
  const slot = async () => { for (;;) {
    await acquire();
    const now = Date.now();
    while (starts.length && now - starts[0] >= WINDOW) starts.shift();
    if (starts.length < LIMIT) { starts.push(now); return; }
    release();
    await sleep(WINDOW - (Date.now() - starts[0]) + 10);   // sleep exactly to the boundary
  } };
  ```
  ```js
  // page side: one block ends the batch. No retry — retrying a challenge makes it worse.
  let blocked = false;
  const grab = async (u) => {
    if (blocked) return { ok: false, status: 0, skipped: true };
    const r = await fetch(u, { headers: { Accept: "application/json" }, credentials: "same-origin" });
    const txt = await r.text();
    if (r.status === 429 || r.status === 403) {
      blocked = true;
      return { ok: false, status: r.status, bytes: txt.length, blocked: true };
    }
    return { ok: r.ok, status: r.status, bytes: txt.length, body: txt };
  };
  ```
  ```js
  // node side: stop, and hand the rest back instead of losing them
  if (blocked) {
    const left = urls.slice(i + BATCH);
    for (const u of left) notDone.push(u);
    console.log(`\n[停] Cloudflare 给了 429/403，剩下的 ${left.length} 个没发。`);
    break;
  }
  // ...
  if (notDone.length) fs.writeFileSync("data/todo.txt", [...new Set(notDone)].join("\n") + "\n");
  ```
  ```js
  // node side: do not let two fast batches double the rate
  const quotaMs = Math.ceil(batch.length / RATE_N) * RATE_WINDOW;
  const spent = Date.now() - batchStart;
  if (i + BATCH < urls.length && spent < quotaMs)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, quotaMs - spent);
  ```
  ```bash
  # resume after a block, minutes later — finished files are skipped by name
  node fetch.js --file data/todo.txt
  ```
- Measured after the rate fix: 12 requests → max 3 in flight, max 6 starts per 3 s, elapsed 4.5 s. 70 requests across 3 batches → 48 s (at the old, too-fast budget). At the new default the pace is deliberately slower.
- Attach command, and the first thing to check when `eval` hangs:
  ```bash
  TOKEN=$(head -1 ~/.pi/chrome-extension-token.txt) && \
    PLAYWRIGHT_MCP_EXTENSION_TOKEN=$TOKEN playwright-cli attach --extension=chrome
  pgrep -fl cliDaemon   # stale daemons make a new attach hang forever; pkill -f cliDaemon
  ```

## 4. Hard Constraints for Future AI

- NEVER rate-limit with a short-interval poll loop in a browser page. Queue + exact sleep, or `Atomics.wait` on the Node side.
- NEVER spawn one CLI process per URL. Batch it.
- NEVER assume `playwright-cli eval` returns a result file; treat a missing URL in the response as a failure and exit non-zero.
- NEVER kill or close the user's Chrome. Use `playwright-cli detach`. Only `pkill -f cliDaemon` (the daemon) is allowed.
- ALWAYS validate numeric CLI flags with a minimum — a zero in a loop step means an infinite loop.
- ALWAYS distinguish a **Cloudflare challenge** (`429`/`403` with an HTML `Just a moment...` body, no `retry-after`) from a normal API error. It is not retryable. Stop the batch and wait minutes.
- NEVER retry into a challenge. Backoff does not help; only silence does.
- ALWAYS persist the URLs that did not land (`data/todo.txt`). A stopped batch must be resumable, not lost.
- NEVER run rate-limit probes against a live logged-in account. Learn the limit from a real run's failure, or ask.
- NEVER treat an HTTP `200` as proof the fetch worked: a challenge page can arrive with a non-JSON body. Parse, and fail loudly when parsing fails.
