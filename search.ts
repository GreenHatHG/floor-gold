#!/usr/bin/env node
// Work out which month windows are still missing, print one URL per line for fetch.ts. Sends nothing.
// The contract is HELP (-h / --help), not this comment.
const HELP = `search.ts — work out which month windows are missing, print one URL per line.

Usage:
  bun run search.ts 招聘 招人                     full history 2023-01 to now, month by month
  bun run search.ts 招聘 --since 2025-06-01
  bun run search.ts 招聘 --since 2025-06-01 --until 2025-08-31
  bun run search.ts 招聘 --new                    from the watermark month to now
  bun run search.ts 招聘 > urls.txt && bun run fetch.ts --file urls.txt

Arguments:
  term...        one or more keywords, one window per month. Quote a term with a space.
                 Weak keyword? add a category word: bun run search.ts "内推 #非我莫属"

Options:
  --new          from the month of the watermark in data/search-state.json
                 (no file yet: last month) up to the current month
  --since DATE   start month, snapped down to its 1st (default 2023-01-01)
  --until DATE   end month, snapped up into its month (default: today)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Windows are whole UTC months on a fixed grid anchored at 2023-01-01. The same month always
lands in the same file name, so finished months are cached forever and --since / --until /
--new only pick grid months, they never shift keys. A stale --new watermark costs nothing:
months between the watermark and now are already cached. The current (unfinished) month is
the one exception: it is re-fetched and overwritten on every run, because a live month grows.

Prints: one URL per line on stdout, oldest month first. On stderr: stats, a per-term
relevance check (帖子含词, below half means the word is weak), and with --new the one-line
watermark update to run after fetch.ts succeeds. Sends no request.

Paging: page=1 is the first page, same as no page, so paging starts at 2 and nothing is
fetched twice; a month that would need page 41 is too big for one window — the program exits 1
and that month must be split by hand (--since/--until halves).

Exit codes: 0 ok · 1 a month needs page 41 · 2 no keyword, a bad date, or conflicting options
`;

import fs from "node:fs";
import path from "node:path";
import { searchFile, parseArgs, UsageError, type FeedDoc, type FeedTopic, type Opts } from "./lib";

// data/ stays at the repo root. __dirname is already the repo root under bun run; a ".."
// here points OUTSIDE the repo (found by the monthly-grid rewrite: cache never hit).
const RAW = path.join(__dirname, "data", "raw");
const STATE = path.join(__dirname, "data", "search-state.json");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
let opts: Opts = {};
let terms: string[] = [];
try {
  ({ opts, args: terms } = parseArgs(argv, { new: "flag", since: "value", until: "value" }));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  console.error("Usage: bun run search.ts -h");
  process.exit(2);
}
const opt = (n: string, dflt: string): string => {
  const v = opts[n];
  return typeof v === "string" ? v : dflt;
};

if (!terms.length) {
  console.error(HELP);
  console.error("More: bun run search.ts --help");
  process.exit(2);
}
if (opts.new && (opts.since !== undefined || opts.until !== undefined)) {
  console.error("use --new, or --since/--until, not both");
  process.exit(2);
}

const PAGE_CAP = 50;
const PAGE_MAX = 40; // a month needing page 41 is not a month problem any more
const ISO = (d: Date): string => d.toISOString().slice(0, 10);
const dateArg = (name: string, raw: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === raw ? d : null;
};

// The grid: month 0 is 2023-01, windows are [monthStart(i), monthStart(i+1)).
const monthStart = (i: number): Date => new Date(Date.UTC(2023, i, 1));
const monthIndexOf = (d: Date): number => (d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth();

const now = new Date();
const liveIdx = monthIndexOf(now);

let startIdx = 0;
let endIdx = liveIdx;
if (opts.since !== undefined) {
  const d = dateArg("since", opt("since", ""));
  if (!d) {
    console.error(`--since must look like 2025-01-01, got: ${opt("since", "")}`);
    process.exit(2);
  }
  startIdx = monthIndexOf(d);
}
if (opts.until !== undefined) {
  const d = dateArg("until", opt("until", ""));
  if (!d) {
    console.error(`--until must look like 2025-01-01, got: ${opt("until", "")}`);
    process.exit(2);
  }
  endIdx = monthIndexOf(d);
}
if (startIdx > endIdx) {
  console.error("--since is after --until: nothing to fetch");
  process.exit(2);
}

const readTopics = (q: string, page: number | null): FeedTopic[] | null => {
  const f = path.join(RAW, searchFile(q, page));
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8")) as FeedDoc;
    return (d && d.topics) || [];
  } catch {
    return null;
  }
};

// --new starts at the watermark's month: overlap with already-fetched months is free, the
// grid cache absorbs any staleness. No state file yet: fall back to last month.
let newOnly = false;
if (opts.new) {
  newOnly = true;
  let wmIdx = liveIdx - 1;
  let wmShown: string | null = null;
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8")) as { last_new?: string };
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s.last_new ?? ""));
    if (m) {
      wmIdx = monthIndexOf(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
      wmShown = String(s.last_new).slice(0, 10);
    }
  } catch {
    // no state file: fall back to last month
  }
  startIdx = wmIdx;
  if (wmShown !== null && wmIdx < liveIdx) {
    console.error(`提醒: 水位线 ${wmShown}，今天 ${ISO(now).slice(0, 10)}，隔了整月。`);
    console.error("      中间的月份要么已缓存要么这次补上，不会漏，但别停太久。");
  }
  endIdx = liveIdx;
}

// posts[].blurb is in every search response; it is the only cheap way to score a word.
const blurbHit = (word: string, q: string): { hit: number; total: number } | null => {
  let posts: { blurb?: string }[];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(RAW, searchFile(q, null)), "utf8")) as FeedDoc & {
      posts?: { blurb?: string }[];
    };
    if (!d || !Array.isArray(d.posts)) return null;
    posts = d.posts;
  } catch {
    return null;
  }
  if (!word || !posts.length) return null;
  const hit = posts.filter((p) => typeof p.blurb === "string" && p.blurb.includes(word)).length;
  return { hit, total: posts.length };
};

const urls: string[] = [];
const stats = { windows: 0, cached: 0, queued: 0 };
const relevance: Record<string, { hit: number; total: number }> = {};

const tooBig = (q: string, p: number): never => {
  console.error(`\n[停] ${q} 需要第 ${p} 页，一个月装不下了。`);
  console.error("     按约定不处理: 用 --since/--until 把这个月拆成两半再抓。");
  process.exit(1);
};

for (const term of terms) {
  const word = term.trim().split(/\s+/)[0];
  let relHit = 0;
  let relTotal = 0;
  for (let mi = startIdx; mi <= endIdx; mi++) {
    const a = monthStart(mi);
    const b = monthStart(mi + 1);
    const q = `${term} after:${ISO(a)} before:${ISO(b)}`;
    const url = `/search.json?q=${encodeURIComponent(q)}`;
    stats.windows++;
    const live = mi === liveIdx;

    // page 1: the unfinished month is re-fetched and overwritten every run.
    const first = readTopics(q, null);
    if (first === null) {
      // Page 1 not on disk: only page 1 can be queued. Whether page 2 exists is unknown
      // until page 1 comes back full, so guessing it here would double the backfill.
      urls.push(url);
      stats.queued++;
      continue;
    }
    if (live) {
      urls.push(url);
      stats.queued++;
    } else {
      stats.cached++;
    }
    if (!relTotal) {
      const r = blurbHit(word, q);
      if (r) {
        relHit = r.hit;
        relTotal = r.total;
      }
    }
    // A full page 1 may have more pages; the live month may also have grown past a full
    // page 1 it had last time, so it is walked even when page 1 itself is queued.
    if (first.length < PAGE_CAP && !live) continue;
    for (let p = 2; ; p++) {
      if (p > PAGE_MAX) tooBig(q, p);
      const t = readTopics(q, p);
      if (t === null) {
        urls.push(`${url}&page=${p}`);
        stats.queued++;
        break;
      }
      stats.cached++;
      if (t.length < PAGE_CAP) break;
    }
  }
  relevance[term] = { hit: relHit, total: relTotal };
}

console.error(
  `${terms.length} 个词 · ${stats.windows} 个月窗口 · 缓存命中 ${stats.cached} 页 · 待抓 ${stats.queued} 个请求`
);
for (const term of terms) {
  const r = relevance[term];
  if (!r.total) continue;
  const pct = Math.round((r.hit / r.total) * 100);
  console.error(
    `词频 ${term}: ${r.hit}/${r.total} 帖子含词 (${pct}%)${pct < 50 ? " — 低于一半，考虑换词或加 #非我莫属" : ""}`
  );
}
if (newOnly) {
  console.error("fetch 成功后更新水位线（复制运行即可）:");
  console.error(`  echo '{"last_new":"${ISO(now).slice(0, 10)}"}' > data/search-state.json`);
}
console.error(`写入: bun run search.ts ... > urls.txt && bun run fetch.ts --file urls.txt`);
console.log(urls.join("\n"));
