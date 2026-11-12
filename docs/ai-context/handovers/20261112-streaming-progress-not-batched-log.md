---
created_at: 2026-11-12
updated_at: 2026-11-12
topic: streaming-progress-not-batched-log
status: resolved
affected_modules: [fetch-core.ts, crawl.ts, fetch.ts]
tags: [logging, progress, cli, agent-observability, long-running]
---

# Long Runs Must Stream Progress, Not Batch the Log at the End

## 1. Context & Problem

`crawl.ts bootstrap` queues ~800 URLs at the deliberate rate of 2 requests / 10 s. A full round
takes tens of minutes. `fetchAll` collected every line in an in-memory `log` array and the
entries printed it only after the whole round finished. The caller (the AI agent, in pi) saw
zero output for the entire round and could not tell "working slowly" from "hung".

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Collect all fetch lines in `report.log` and print with one `for` loop after `fetchAll` returns.
  - **Failure Reason**: A 10+ minute round prints nothing until done. Silent-long-output looks like a hang; the agent (or a human) starts second-guessing, kills the process, or runs other commands against the same Chrome tab — which then destroys the in-flight `eval` batch (see the playwright-cli handover, 2026-11-12 incident).
- **Attempt**: Diagnose the "hang" by re-running the whole crawl in the foreground with a fresh timeout.
  - **Failure Reason**: Wastes another full round of waiting before the same silence appears. Check for file writes under `data/raw/` instead — they are the ground truth of progress.
- **Attempt**: Run a `nohup ... &` background crawl, then execute other `playwright-cli` commands against the same attached tab while it runs.
  - **Failure Reason**: The crawl is invisible in the agent's foreground output, so the agent forgets it is running and navigates the tab — killing the in-flight `eval` batch (see the playwright-cli handover). If backgrounding a run, always tail its log before issuing any tab command, and prefer foreground runs with a long timeout.
- **Attempt (verification probe, 2026-11-12)**: Read `report.log` assuming it contains everything shown to the user.
  - **Failure Reason**: Per-batch heartbeat lines bypass `say()` and go only to the hook, so they are absent from `report.log`. Nothing consumes `report.log` today, so this is harmless — but a future consumer must not treat `report.log` as the complete output stream.
- **Attempt**: Run `npm run check` in a fresh clone and expect biome/tsc to exist.
  - **Failure Reason**: `node_modules` was not installed; both binaries came back "command not found". `npm install` first. `npx tsc` also fails (it is not the real tsc — npx fetched a wrong package shim); use `npm run typecheck`.

## 3. Decision & Verified Solution

- **Chosen Approach**: `fetchAll` gained an optional `onProgress?: (line: string) => void` hook.
  `say()` calls both `log.push` and the hook. Entries stream the hook to `console.error` (progress
  is diagnostics — stderr), while stdout keeps only the final one-line summary. `fetch.ts` does the same.
- **Key Changes**: `src/core/fetch-core.ts` (`FetchOptions.onProgress`, heartbeat per batch, per-URL lines), `src/crawl.ts` and `src/fetch.ts` pass `onProgress: (line) => console.error(line)` and dropped the end-of-run log dump.
- **Minimal Code / Command Reference**:
  ```ts
  // fetch-core.ts
  const say = (line: string): void => { log.push(line); o.onProgress?.(line); };
  // per batch, before runBatch:
  o.onProgress?.(`[batch ${i / o.batch + 1}/${Math.ceil(urls.length / o.batch)}] sending ${batch.length} urls...`);
  // entries:
  onProgress: (line) => console.error(line),
  ```

## 4. Hard Constraints for Future AI

- ALWAYS stream progress (stderr) from any command that can run longer than ~1 minute. A silent long run is indistinguishable from a hang.
- NEVER hold all output until a function returns to print in one loop. Use a callback or write lines as they happen.
- Keep stdout for the deliverable/summary; diagnostics and progress go to stderr.
- If a long run is backgrounded, ALWAYS tail its log before issuing any `playwright-cli` command against the attached tab.
- ALWAYS run `npm install` before `npm run check` in this repo; call tsc/biome only through the npm scripts, never bare `npx tsc`.
