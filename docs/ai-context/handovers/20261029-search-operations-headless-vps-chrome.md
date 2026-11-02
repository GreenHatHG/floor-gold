---
created_at: 2026-10-29
updated_at: 2026-10-29
topic: search-operations-headless-vps-chrome
status: resolved
affected_modules: [search.ts, fetch.ts, docs/README.md]
tags: [operations, chrome, vps, playwright-cli, fetch-input-format, division-of-labor]
---

# Operations: Headless VPS Plans, User's Chrome Executes

## 1. Context & Problem

The coding agent runs on a VPS with no Chrome and no logged-in linux.do session.
`fetch.ts` only works through the user's logged-in Chrome via `playwright-cli`.
So every fetch round is a division of labor: the agent writes probe/backfill URL files and
the exact commands; the user runs them in Chrome and pastes the output back. The agent then
reads the resulting JSON under `data/raw/` to measure and decide.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Write probe files containing bare query strings like `招人 after:2026-09-01 before:2026-10-01`.
  - **Failure Reason**: `fetch.ts --file` expects URL PATHS (one `/search.json?q=...` per line), not raw queries. Bare queries were sent as literal URLs → 4x `FAIL 404`. Nothing was fetched, but the round was wasted. Always generate URL lines the same way `search.ts` does (`/search.json?q=` + `encodeURIComponent(q)`), or by piping `bun run search.ts ... > file`.
- **Attempt**: Agent runs the pipeline end-to-end itself.
  - **Failure Reason**: Impossible by design — the VPS has no Chrome session. The agent must never claim "fetched" or "verified online" without the user's pasted fetch output; its own verification is limited to local JSON on disk.

## 3. Decision & Verified Solution

- **Chosen Approach**: Agent prepares: (1) URL files via `search.ts` output or hand-built
  `/search.json?q=...` lines (URL-encode the query), (2) the exact command line with the
  safe rate from the README (`--rate 2/3000 --conc 2`), (3) after the user's run, reads
  `data/raw/` JSON to count hits and pages before committing to a design.
- **Key Changes**: Probe workflow (2026-10-29) validated: 7 monthly-window search URLs,
  user-pasted output, then local `jq '.topics | length'` per file produced the measurements
  (busy month 70 hits/2 pages, Jan 2024 = 9 hits, Jan 2023 = 1 hit) that decided the
  monthly-grid design.
- **Minimal Code / Command Reference**:
  ```bash
  # agent: build a probe file with real URL paths
  printf '/search.json?q=%s\n' "$(jq -rn --arg q '招人 after:2026-09-01 before:2026-10-01' '$q|@uri')" > data/probe.txt
  # user in Chrome:
  bun run fetch.ts --file data/probe.txt --rate 2/3000 --conc 2
  # agent: measure from disk
  jq '.topics | length' data/raw/search/*.json
  ```

## 4. Hard Constraints for Future AI

- NEVER emit bare query strings into a `--file` for `fetch.ts`; only full URL paths starting with `/`.
- NEVER claim online facts (hit counts, rate limits, endpoint behavior) the user has not run; plan probes and wait for pasted output.
- ALWAYS measure from `data/raw/` JSON (jq) before locking window sizes, page caps, or backfill estimates.
