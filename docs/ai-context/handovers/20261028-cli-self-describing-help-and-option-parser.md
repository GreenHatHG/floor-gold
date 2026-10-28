---
created_at: 2026-10-28
updated_at: 2026-10-28
topic: cli-self-describing-help-and-option-parser
status: resolved
affected_modules: [fetch.js, search.js, pending.js, digest.js, lib.js, README.md]
tags: [cli, help-text, progressive-disclosure, option-parser, gnu-getopt, ripgrep, agent-ergonomics]
---

# Self-Describing CLIs: Two-Level Help plus One Shared Option Parser

## 1. Context & Problem

An LLM agent needed to use four scripts (`fetch.js`, `search.js`, `pending.js`, `digest.js`). The usage text lived only in a header comment inside each `.js` file, so the agent had to read code to find the contract. That burns tokens and invites guessing.

Requirement: the tool must describe itself. Call it, read it, act. No code reading.

A second, separate bug showed up while doing this: only `fetch.js` parsed `--opt value`. The other three parsed only `--opt=value`, so the standard space form silently did nothing — or worse, ate the next token as a value.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)

- **Attempt**: Put the whole contract in one flat `--help`.
  - **Failure Reason**: 178–333 words per tool in one gulp. The caller only needs the call contract, not the disk-path table and the editor traps. Also made `-h` and `--help` identical, so there was no cheap level.

- **Attempt**: `--help=all` for the full text (a third level keyed on an option value).
  - **Failure Reason**: Not a GNU/POSIX convention. GNU `getopt_long` supports `optional_argument` (`--color[=WHEN]`), but then only the `=` form parses and `--help all` silently becomes an operand. Measured on this box: `curl --help` = 21 lines, `curl --help all` = 269 lines, and `curl --help=all` **exits 2**. curl chose a separate argument. Do not invent `--help=all`.

- **Attempt**: Keep `-h` and `--help` as aliases printing the same text (the first version).
  - **Failure Reason**: Wastes the one flag every agent tries first. `rg` shows the right shape: `rg -h` = 135 lines, `rg --help` = 1564 lines — same flag name, two depths.

- **Attempt**: Per-script option parsers. `fetch.js` was greedy (`--opt value` or `--opt=value`); the other three used `argv.find(a => a.startsWith('--x='))`.
  - **Failure Reason**: Silent wrong answers, which are worse than crashes. Measured before the fix:
    - `node search.js 招聘 --since 2026-10-21` searched the literal word `2026-10-21` and wrote junk cache files.
    - `node digest.js 77 --from 3` ignored `--from` and printed from post 1.
    - `node digest.js 77 --chars 5` ignored `--chars` and used 200.
    - `node fetch.js --file` turned the flag into the string `true` → `--file true: no such file`.
    - `node fetch.js --batch /t/1.json` ate the URL as the batch number.

- **Attempt**: Guard unknown options with `const kind = spec[name]; if (!kind) throw ...` and `opts = {}`.
  - **Failure Reason**: `spec[name]` walks the prototype chain. `node digest.js 77 --toString hi` exited 0 and **swallowed `hi`**; same for `--constructor`, `--hasOwnProperty`, `--__proto__`.

- **Attempt**: Leave the help text saying `--top=25` only, because that is what the parser accepted.
  - **Failure Reason**: Documented the wrong contract. GNU accepts both forms for a required value, so the docs were describing a limitation, not a standard. A verifier flagged `--since=DATE ... newest window first` as a false statement too — the code loops `a = start; a < newest; a += 7 DAY`, i.e. **oldest to newest**. README said the same wrong thing.

- **Attempt**: Documenting disk paths from memory.
  - **Failure Reason**: Help said listings land in `data/raw/site/<name>[-pN].json`, but `/top?period=weekly&page=2` actually lands in `data/raw/site/top-weekly-p2.json`. An agent following the help looks in the wrong place. Correct pattern: `<name>[-<period>][-pN].json`.

## 3. Decision & Verified Solution

- **Chosen Approach**: Ripgrep-style two levels, one source of truth per script, plus one shared parser in `lib.js`.
  - `-h` → `HELP_SHORT`: what it does in one line, Usage, Options with defaults, output summary, exit codes, and the one rule that changes the caller's next action (fetch: 429 is Cloudflare, wait and rerun; search: never add `order:latest`).
  - `--help` → `HELP`, defined as `HELP_SHORT + extra` so the core can never drift. Extra = disk-path table and editor traps (fetch), `notes.jsonl` reads/writes + summary marks + paging rules (pending/search), header layout (digest).
  - Sizes after the split: `-h` 20–22 lines, `--help` 31–44 lines.
  - `--help` is checked before `-h`; both are checked on **raw argv before parsing**, so help always wins over a parse error.
  - Missing required arg → `HELP_SHORT` on stderr + a `Full contract:` pointer + exit 2. `pending.js` with no args stays a normal run.

- **Key Changes**:
  - `lib.js` — new `parseArgs(argv, spec)` + `UsageError`, used by all four scripts.
  - `fetch.js`, `search.js`, `pending.js`, `digest.js` — `HELP_SHORT` / `HELP` constants replace the header comment; per-script parsers deleted; aliases declared per script.
  - `README.md` — documents the two levels (`-h` first) and the option forms.

- **Minimal Code / Command Reference**:

```js
// lib.js — one parser for all four CLIs.
// spec: { name: "value" | "flag" }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function parseArgs(argv, spec) {
  const opts = Object.create(null);   // null proto: no inherited keys can leak in
  const args = [];
  let literal = false;                // set by a bare "--"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal || !a.startsWith("--")) { args.push(a); continue; }
    if (a === "--") { literal = true; continue; }
    const eq = a.indexOf("=");
    const name = eq > -1 ? a.slice(2, eq) : a.slice(2);
    if (!has(spec, name)) throw new UsageError(`unknown option --${name}`);
    const kind = spec[name];
    if (kind === "flag") {
      if (eq > -1) throw new UsageError(`--${name} takes no value`);
      opts[name] = true;
      continue;
    }
    if (eq > -1) {
      const v = a.slice(eq + 1);
      if (!v) throw new UsageError(`--${name} needs a value`);
      opts[name] = v;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    opts[name] = next;
    i++;
  }
  return { opts, args };
}
```

```js
// every script, same shape: help first, parse second.
const argv = process.argv.slice(2);
if (argv.includes("--help")) { console.log(HELP); process.exit(0); }
if (argv.includes("-h")) { console.log(HELP_SHORT); process.exit(0); }

let opts = {};
let rest = [];
try {
  ({ opts, args: rest } = parseArgs(argv, { new: "flag", from: "value", chars: "value", full: "value" }));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  console.error("Full contract: node digest.js -h");
  process.exit(2);
}
const opt = (n, d) => (n in opts ? opts[n] : d);   // safe: opts has a null prototype
```

Option aliases (keep in sync with each script's `parseArgs` call):

```text
fetch.js    file, batch, conc, rate, session      all value
search.js   new: flag,  since: value
pending.js  urls: flag, include-new: flag, top: value
digest.js   new: flag,  from: value, chars: value, full: value
```

## 4. Hard Constraints for Future AI

- **ALWAYS** keep `HELP = HELP_SHORT + extra`. Never write the core sections twice; if a fact must live in both, it lives in `HELP_SHORT` and `HELP` reads it through the concatenation.
- **ALWAYS** put a fact in `-h` if it changes the caller's next action (exit codes, defaults, "wait and rerun after 429"). Put a fact in `--help` if it only explains output or disk layout. Put it in `README.md` if it only matters to whoever edits the script.
- **NEVER** add `--help=VALUE` or any third help level. Use `-h` / `--help`, or curl's `--help all` as a separate argument.
- **NEVER** parse options per-script again. All four call `parseArgs` from `lib.js`. A forked parser is how `--from 3` silently printed from post 1.
- **NEVER** check option names with `in` or `spec[name]` alone. Use `Object.prototype.hasOwnProperty.call` and build `opts` with `Object.create(null)`, or `--toString x` is accepted and `x` is swallowed.
- **NEVER** let a value option take the next token when it starts with `--`; that is a missing value, not a value.
- **ALWAYS** check `--help` / `-h` on raw argv before parsing, so help wins over every argument error. Accepted side effect: the pre-scan ignores a bare `--`, so `node pending.js -- -h` still prints help.
- **ALWAYS** document the space form as the example (`--top 25`) and note `--opt=VALUE` once. Never document only the `=` form.
- **ALWAYS** verify help claims against the code. Two false claims already shipped and had to be fixed: "newest window first" (code runs oldest to newest) and `site/<name>[-pN].json` (real name includes the period).
- **DO NOT** "fix" these known, accepted warts without asking — all predate this work: single-dash tokens (`-n`) are treated as positionals; `--full abc` exits 1, not 2; `--file ""` is accepted as an empty filename; numeric options use `Number()` coercion (`--top 0x10` → 16); a stale command line like `digest.js 77 --top=30` now exits 2 `unknown option` by design.
