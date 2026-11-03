---
created_at: 2026-10-27
updated_at: 2026-11-03
topic: script-vs-agent-boundary
status: decision-only
affected_modules: [fetch.js, search.js, pending.js, digest.js, lib.js]
tags: [architecture, llm-agent, tooling, caching, token-budget, filename-collision, cli-help, orchestration]
---

# Where to Cut Between Script and LLM Agent

## 1. Context & Problem

The user's LLM quota is unpredictable: sometimes plenty, sometimes none. They refuse to sink hours into a rigid scraper that becomes dead weight the moment they stop using it or run out of quota. But they also do not want to pay LLM tokens for mechanical work that never changes.

So the real question is not "script or agent" — it is "which parts are mechanical, and which parts are judgment".

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: One ~100-line script that fetches, ranks relevance, and decides what to open.
  - **Failure Reason**: The ranking and "is this a real job post / still hiring" logic is exactly the part that rots. It is also the part that needs a human-style reading of 200-character snippets. Every tweak to the heuristics would mean editing code with no test that can catch a regression in judgment.

- **Attempt**: Make a tiny script for every step, including "is the attach alive".
  - **Failure Reason**: `playwright-cli tab-list` already answers that in one command. Wrapping it adds a file to maintain and hides the failure mode. The user called this out explicitly: trivially simple things should stay as plain agent commands.

- **Attempt**: A `mark.sh` that rewrites `data/index.json` in place.
  - **Failure Reason**: Rewriting the whole JSON file on every judgment risks corrupting the entire cache with one bad write, and the failure is silent. Replaced with an append-only `index.jsonl` where the **last line wins** — `echo >>` cannot destroy earlier rows.

- **Attempt**: Dump raw topic JSON into the agent's context so it can judge.
  - **Failure Reason**: One topic file is 50–200 KB. Reading it burns quota for content the agent mostly ignores. A capped digest (title, post number, author, date, first 200 chars) is enough to triage.

- **Attempt**: Build the cache filename with a naive slug — strip everything outside `[\w\u4e00-\u9fa5.@=-]` and cut at 80 chars.
  - **Failure Reason**: Two different queries silently share one file. `C++`, `C#` and `C` all slug to `C`, so the second fetch overwrites the first **and** `search.js` then believes both windows are already done — a permanent hole with no error. Cutting at 80 chars collides the same way for long queries even when nothing was dropped. Fix: append a 4-char SHA-1 of the raw string whenever sanitising would lose a meaningful character **or** the string exceeds the length cap; ordinary queries keep their plain readable name.

- **Attempt**: Document each script's contract in a header comment at the top of the `.js` file.
  - **Failure Reason**: The agent had to open and read code to learn the calling contract, which burns tokens and invites guessing. A tool for an agent must describe itself: the contract belongs in the tool's own `--help` output, and the header comment shrinks to one line that points at it. See `20261028-cli-self-describing-help-and-option-parser.md`.

- **Attempt**: Let each script parse its own options.
  - **Failure Reason**: The parsers drifted. Three of four accepted only `--opt=value`, so `--from 3` was silently ignored and `--since 2026-10-21` searched for the literal word `2026-10-21`. Silent wrong answers, and junk cache files. Fix: one `parseArgs` in `lib.js` used by all four.

- **Attempt**: Manual two-step loop: `search.ts ... > urls.txt && fetch.ts --file urls.txt`, repeated until `待抓 0`, then a hand-copied `echo` to advance the watermark. The agent had to invent flags (`--since`? which terms? quoted?) every run and remember the loop + watermark ritual.
  - **Failure Reason**: Too much freedom for an LLM caller: every invocation was a fresh generalization exercise, a forgotten round silently under-fetched months (only page 1 of a 6-page month), and a mangled watermark echo silently skipped months later.
- **Attempt**: Have `crawl.ts` loop until `search.ts` queues 0 URLs (stdout empty = drained).
  - **Failure Reason**: Never terminates. `search.ts` always re-queues the live (unfinished) month's page 1 on stdout even when fully cached, so the queue never reads as 0 — the loop spun 60 rounds against a fake fetcher before hitting the safety cap. Found by adversarial verification with a fake-bun harness.

## 3. Decision & Verified Solution

- **Chosen Approach**: Scripts do only **dumb, stable** work. The agent does all **judgment** each run. Nothing in code scores relevance, classifies a post, or decides what to open.
  - Scripts (4): `fetch.js` (batch fetch → disk → manifest), `search.js` (which search URLs are still missing), `pending.js` (which topics changed), `digest.js` (compress one topic to a few hundred chars). Plus `lib.js` for the shared filename rule and the shared option parser.
  - Agent (each run): pick terms and operators, read the digest, judge real-post / stale / noise, extract company, role, city, remote, salary, contact, and record a one-line verdict.
  - Trivially simple steps stay as commands, not scripts: attach check, `tab-list`, fetching a single page, looking at one post.
- **Paradigm frozen into `crawl.ts` (2026-11-03)**: the agent-facing contract is now two subcommands with zero call-time decisions. Terms live in `data/terms.txt` (one per line, `#` comments); `bootstrap` = full 2023-01 grid, `daily` = watermark month to now. crawl.ts loops search→fetch internally and detects drain by **steady state** (same stdout URL set as previous round), not by an empty queue — this absorbs the live-month re-fetch quirk. `daily` advances `data/search-state.json` itself (tmp+rename, atomic) but ONLY after a round with 0 failed fetch URLs; any failure exits 1 with "rerun the same command". Cap of 60 rounds guards against non-convergence. Judging (pending/digest/index.jsonl) stays with the agent. README gained an "The AI contract: two commands" section; scripts table is now five scripts.
- **Minimal Code / Command Reference** (drain detection in `crawl.ts`):
  ```ts
  const same = r.urls.length > 0 && r.urls.join("\n") === prev;
  prev = r.urls.join("\n");
  if (r.empty || same) break;          // live-month page-1 re-fetch makes r.empty unreachable
  // ... after a green daily run, only then:
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify({ last_new: today }));
  fs.renameSync(`${STATE}.tmp`, STATE);
  ```
- **Key Changes**: Verdicts go to `data/index.jsonl` as append-only rows `{at, id, read_upto, verdict, note}`; `digest.js` reads it to know what is already read (`--new`).
- **Minimal Code / Command Reference**:
  ```bash
  # the agent's daily loop — no logic in code, all in the reading
  node search.js 招聘 内推码 招人 --new > urls.txt && node fetch.js --file urls.txt
  node pending.js --top 20
  node digest.js <topic_id> --chars 200
  node digest.js <topic_id> --full 43            # only when a post looks worth it
  echo '{"id":123,"read_upto":45,"verdict":"在看","note":"上海后端,远程"}' >> data/index.jsonl
  ```
  Options take a space (`--top 20`). `--top=20` also works. Learn the contract with `node <script> -h`, not by reading code.
- Design consequence that mattered: `lib.js` holds the single filename rule used by both `fetch.js` and `search.js`. If those two disagree, the cache either re-downloads forever or never resumes. One shared function removes that class of bug.
- **Minimal Code / Command Reference** (the collision-safe naming rule):
  ```js
  const LOSSY = /[^\w\u4e00-\u9fa5.@=\-\s:]/;
  const safe = (s) => {
    const raw = String(s ?? "");
    const base = slug(raw) || "empty";
    const ambiguous = LOSSY.test(raw) || raw.length > 80;   // either loss OR truncation collides
    return ambiguous ? `${base}-${sha1(raw).slice(0, 4)}` : base;
  };
  ```

## 4. Hard Constraints for Future AI

- NEVER put relevance scoring, classification, or "should I open this" into a script. That is the rot-prone layer; it belongs to the agent.
- NEVER turn a one-command action into a script. If it needs no memory and no rule, it is a command.
- ALWAYS keep cache files append-only (`index.jsonl`, `notes.jsonl`) with last-line-wins. Do not rewrite state files in place.
- ALWAYS keep raw JSON on disk and print a capped digest; full text only on explicit request.
- ALWAYS share the cache filename rule from one module. Duplicated naming logic is a silent cache-drift bug.
- ALWAYS make a script describe itself: the contract lives in its `-h` / `--help` output, never only in a header comment the agent must read code to find.
- ALWAYS share one option parser. Duplicated parsing logic is how `--from 3` ends up silently ignored.
- ALWAYS give the LLM caller a frozen entry point (`crawl.ts bootstrap | daily` + `data/terms.txt`). NEVER let it pick keywords, date flags, or URLs at call time — free parameters are generalization surface.
- NEVER use "search printed 0 URLs" as a drain condition: the live month's page 1 is always re-queued. Use "same URL set as previous round" (steady state) instead.
- NEVER advance the watermark after a fetch round with failures. Guard it: 0 failures or no write.
- ALWAYS verify loop-termination logic with a fake fetcher harness before shipping — the real fetch path cannot run without an attached Chrome session, and the spin bug only showed up there.
- ALWAYS add a short hash suffix when a cache filename is derived from lossy sanitising or truncation. Two queries mapping to one file means one of them is silently never fetched.
