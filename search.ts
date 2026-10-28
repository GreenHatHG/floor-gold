#!/usr/bin/env node
// Work out which search windows are still missing, print one URL per line for fetch.js. Sends nothing.
// The contract is HELP_SHORT (-h) and HELP (--help), not this comment.
const HELP_SHORT = `search.ts — work out which search windows are missing, print one URL per line.

Usage:
  node dist/search.js 招聘 招人                     full history, week by week
  node dist/search.js 招聘 --new                    only the last two weeks
  node dist/search.js 招聘 --since 2025-01-01
  node dist/search.js 招聘 > urls.txt && node dist/fetch.js --file urls.txt
  node dist/search.js -h                            this summary
  node dist/search.js --help                        paging rules, what it prints

Arguments:
  term...        one or more keywords, one window per week. Quote a term with a space.
                 Weak keyword? add a category word: node dist/search.js "内推 #非我莫属"

Options:
  --new          only the last 2 weeks, skip older history
  --since DATE   backfill from DATE (default 2023-01-01). Windows run oldest to newest.
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Exit codes: 0 ok · 2 no keyword, or a bad date

Never add order:latest: it re-ranks by recency, weak matches crowd out real ones.
`;

const HELP = HELP_SHORT + `
What it prints:
  stdout  the URLs to fetch, one per line, oldest window first
  stderr  a stats line, plus the pipe-it-into-fetch.js hint

Sends no request. A window is one keyword and one week, and it is done when its file
already exists, so stopping and rerunning costs nothing.

How paging works:
  - page=1 is the first page, same as no page. Paging starts at 2, so nothing is fetched twice.
  - A window that came back with 50 hits gets its next page queued, up to page 40.
  - The order:latest warning above is measured, not a hunch: "内推" got 39 hits with the plain
    keyword and 1 hit with order:latest.
`;

import fs from "node:fs";
import path from "node:path";
import { searchFile, parseArgs, UsageError, type FeedDoc, type FeedTopic, type Opts } from "./lib";

// dist/ holds the built files; data/ stays at the repo root next to it.
const RAW = path.join(__dirname, "..", "data", "raw");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (argv.includes("-h")) {
  console.log(HELP_SHORT);
  process.exit(0);
}
let opts: Opts = {};
let terms: string[] = [];
try {
  ({ opts, args: terms } = parseArgs(argv, { new: "flag", since: "value" }));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  console.error("Full contract: node dist/search.js -h");
  process.exit(2);
}
const opt = (n: string, dflt: string): string => {
  const v = opts[n];
  return typeof v === "string" ? v : dflt;
};

if (!terms.length) {
  console.error(HELP_SHORT);
  console.error("Full contract: node dist/search.js --help");
  process.exit(2);
}

const DAY = 86400000;
const PAGE_CAP = 50;
const ISO = (d: Date): string => d.toISOString().slice(0, 10);
const today = new Date();
const newest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
const since = (() => {
  const raw = opt("since", "2023-01-01");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
  if (!m) {
    console.error(`--since must look like 2025-01-01, got: ${raw}`);
    process.exit(2);
  }
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.toISOString().slice(0, 10) !== raw) {
    console.error(`--since is not a real date: ${raw}`);
    process.exit(2);
  }
  return d;
})();
const newOnly = !!opts.new;

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

const urls: string[] = [];
const stats = { windows: 0, done: 0, capped: 0 };

for (const term of terms) {
  const start = newOnly ? new Date(newest.getTime() - 13 * DAY) : since;
  for (let a = new Date(start); a.getTime() < newest.getTime(); a = new Date(a.getTime() + 7 * DAY)) {
    const b = new Date(Math.min(a.getTime() + 7 * DAY, newest.getTime()));
    const q = `${term} after:${ISO(a)} before:${ISO(b)}`;
    stats.windows++;

    // Discourse treats page=1 as "the first page", same as no page at all. Real paging starts at 2.
    let page: number | null = null;
    for (;;) {
      const topics = readTopics(q, page);
      if (topics === null) {
        if (page !== null) break;
        urls.push(`/search.json?q=${encodeURIComponent(q)}`);
        break;
      }
      stats.done++;
      if (topics.length < PAGE_CAP) break;
      stats.capped++;
      const next: number = page === null ? 2 : page + 1;
      if (next > 40) break; // a week needing 2000 hits is not a week problem
      if (readTopics(q, next) === null) {
        urls.push(`/search.json?q=${encodeURIComponent(q)}&page=${next}`);
        break;
      }
      page = next;
    }
  }
}

console.error(
  `${terms.length} 个词 · ${stats.windows} 个周窗口 · 已抓 ${stats.done} 页 · 满页待翻 ${stats.capped} 次 · 待抓 ${urls.length} 个请求`
);
console.error(`写入: node dist/search.js ... > urls.txt && node dist/fetch.js --file urls.txt`);
console.log(urls.join("\n"));
