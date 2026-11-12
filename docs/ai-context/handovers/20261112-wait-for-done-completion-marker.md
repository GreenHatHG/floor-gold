---
created_at: 2026-11-12
updated_at: 2026-11-12
topic: wait-for-done-completion-marker
status: resolved
affected_modules: [crawl.ts]
tags: [cli, agent-observability, long-running, exit-codes, blocking]
---

# --wait-for-done: One Marker Line So Agents Block Instead of Poll

## 1. Context & Problem

`crawl.ts bootstrap` runs 1–3 hours across multiple rounds. The agent supervising it either sat
in the foreground (blocked, no interaction) or backgrounded it and woke every few minutes to
`tail` the log. Each wake-up burns agent tokens; repeated identical tail commands also trip the
loop guard, which kills the poll. The user asked for a wait-for mechanism: launch, then get
signaled at completion.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Agent supervises a backgrounded crawl with a `sleep 280; tail -n 2 log` loop.
  - **Failure Reason**: ~20 wake-ups for one bootstrap, each costing tokens; three identical commands in a row get blocked by the loop guard, so the poll dies even when the crawl is fine. Also invites tab-driving mistakes while forgetting the crawl runs (see the playwright-cli handover).
- **Attempt**: Put the marker print inside the entries' `parseOrExit` block scope.
  - **Failure Reason**: tsc fails: `Cannot find name 'opts'` — the block-scoped `opts` is out of scope at the bottom of the file. Hoist a plain `waitForDone` boolean out of the block.
- **Attempt**: Define `waitMarker()` after the main loop but call it from inside the loop's exit paths.
  - **Failure Reason**: tsc fails: `Block-scoped variable used before its declaration`. Function declarations must sit above every call site; hoist next to `advanceWatermark()` before the loop.
- **Attempt**: Let `waitMarker()` read `process.exitCode ?? 0` and call it before `process.exit(1)` on the failure paths.
  - **Failure Reason**: `process.exitCode` is still undefined at call time, so every failure exit printed `crawl-done 0` — a watcher could not distinguish "drained" from "rerun needed" (caught by adversarial verification). Fix: pass the code explicitly, `waitMarker(1)` on failure paths, `waitMarker(0)` at end of main.
- **Attempt**: Document the watcher as `cmd > run.log 2>&1 | while read ...`.
  - **Failure Reason**: The stdout redirect and the pipe are mutually exclusive — the `while` loop receives nothing and blocks forever. Use `tee` in the middle: `cmd 2>&1 | tee run.log | while ...`.

## 3. Decision & Verified Solution

- **Chosen Approach**: `crawl.ts` accepts `--wait-for-done` on any command. Before every exit
  (drained end, fetch-failed exit 1, FatalError exit 1, 60-round guard exit 1), it prints one
  machine-readable line to stdout: `crawl-done <exit>`. The agent launches the long command
  redirected to a log and blocks by reading that stream — zero token cost while waiting.
- **Key Changes**: `src/crawl.ts` only. `parseOrExit` spec gains `"wait-for-done": "flag"`;
  hoisted `waitForDone` boolean; `waitMarker()` defined before the loop; called on all four exit paths; HELP documents the flag.
- **Minimal Code / Command Reference**:
  ```ts
  // code is passed EXPLICITLY: on the failure paths waitMarker runs before process.exit,
  // so reading process.exitCode there would print crawl-done 0 on a failed run.
  const waitMarker = (code: number): void => {
    if (!waitForDone) return;
    console.log(`crawl-done ${code}`);
  };
  // exit-1 paths: waitMarker(1); process.exit(1)   ·  end-of-main: waitMarker(0)
  ```
  ```bash
  # agent-side: launch + block on completion, no polling.
  # NOTE: tee, not a plain redirect — `> run.log 2>&1 | while ...` feeds the pipe nothing
  # (stdout goes to the file, the while loop never sees the marker) and deadlocks.
  bun run src/crawl.ts daily --wait-for-done 2>&1 | tee run.log | while IFS= read -r l; do
    case "$l" in crawl-done*) break;; esac
  done
  ```
  Verified: exit-2 usage path, green daily run prints `crawl-done 0`.

## 4. Hard Constraints for Future AI

- ALWAYS run long commands (`crawl bootstrap|daily`, anything >5 min) with `--wait-for-done` and block on the `crawl-done` line. NEVER supervise with repeated sleep+tail wake-ups.
- ALWAYS print the marker on EVERY exit path of a command promising it, WITH the correct code. A success-only marker deadlocks a watcher; a wrong-code marker (0 on failure) silently corrupts the watcher's next decision. Pass the code explicitly on failure paths — `process.exitCode` is not yet set before `process.exit(n)`.
- Keep the marker on stdout (machine-readable), never stderr — stderr carries streaming diagnostics.
