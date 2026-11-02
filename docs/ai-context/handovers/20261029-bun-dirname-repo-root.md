---
created_at: 2026-10-29
updated_at: 2026-10-29
topic: bun-dirname-repo-root
status: resolved
affected_modules: [search.ts, fetch.ts, pending.ts, digest.ts]
tags: [bun, dirname, path-resolution, cache, silent-failure]
---

# `__dirname` Under `bun run` Is the Script's Own Directory

## 1. Context & Problem

All four scripts (search/fetch/pending/digest) resolved the `data/` root with
`path.join(__dirname, "..", "data", "raw")`. Scripts live at the repo root, so the `..`
was copied in under the wrong assumption that `__dirname` points at some `src/` directory.
The result: every script read and wrote `data/` one level ABOVE the repo
(`/home/<user>/projects/data/raw`), and no script ever saw its own cache.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: `path.join(__dirname, "..")` for the repo root in all four scripts.
  - **Failure Reason**: Under `bun run`, `__dirname` is the directory of the executed script — here already the repo root. The extra `..` silently pointed OUTSIDE the repo. Cache files were written to a directory that did not exist (fetch created it on demand), so caches were "always empty" and resume logic never fired. No error, no warning — pure silent failure.
- **Attempt**: Debug with `bun -e 'console.log(__dirname)'`.
  - **Failure Reason**: `bun -e` sets `__dirname` to the CURRENT WORKING DIRECTORY, not the script dir. This contradicts script mode and produced two conflicting readings during diagnosis. Only running a real script FILE (`bun run <file>.ts`) shows the truth: `__dirname` = the file's own directory.

## 3. Decision & Verified Solution

- **Chosen Approach**: Join `data/` paths directly from `__dirname`, no `..`.
- **Key Changes**: `search.ts`: `path.join(__dirname, "data", "raw")` (plus `search-state.json`); `fetch.ts`, `pending.ts`, `digest.ts`: `const ROOT = __dirname;`. Verified after the fix: seeded synthetic cache files were found, `缓存命中` counts non-zero, resume converged to zero URLs.
- **Minimal Code / Command Reference**:
  ```ts
  // before (broken): const ROOT = path.join(__dirname, "..");
  const ROOT = __dirname;                              // after: repo root under bun run
  const RAW = path.join(__dirname, "data", "raw");     // search.ts form
  ```

## 4. Hard Constraints for Future AI

- NEVER join `data/` (or any repo-relative) paths with `path.join(__dirname, "..")` in this repo; `__dirname` is already the repo root under `bun run`.
- NEVER trust `bun -e` for `__dirname` semantics — it uses the CWD, script mode uses the script dir. Probe with a real file.
- SUSPECT path resolution first when a cache "never hits": this class of bug is silent, and the symptom (always-empty cache, re-download forever) looks like a cache-key design bug, not a path bug.
