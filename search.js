#!/usr/bin/env node
// Work out which search URLs still need fetching, and print them one per line for fetch.js.
// Usage:
//   node search.js 招聘 内推 招人                    full history, week by week
//   node search.js 招聘 --new                        only the last 2 weeks
//   node search.js 招聘 --since=2025-01-01
//   node search.js 招聘 > urls.txt && node fetch.js --file urls.txt
//
// Resumes from disk: a window is "done" when its file exists. A window that came back with a
// full page of 50 gets its next page queued, so nothing is lost to the 50-per-page cap.
//
// Do NOT add order:latest. Measured: it re-ranks by recency and weak matches crowd out real ones
// ("内推" 39 hits -> 1 hit). Plain keyword + after:/before: keeps relevance.

const fs = require("fs");
const path = require("path");
const { searchFile } = require("./lib");

const RAW = path.join(__dirname, "data", "raw");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const terms = argv.filter((a) => !a.startsWith("--"));

if (!terms.length) {
  console.error("usage: node search.js <term> [term...] [--new] [--since=YYYY-MM-DD]");
  process.exit(2);
}

const DAY = 86400000;
const PAGE_CAP = 50;
const ISO = (d) => d.toISOString().slice(0, 10);
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
const newOnly = argv.includes("--new");

const readTopics = (q, page) => {
  const f = path.join(RAW, searchFile(q, page));
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return (d && d.topics) || [];
  } catch {
    return null;
  }
};

const urls = [];
const stats = { windows: 0, done: 0, capped: 0 };

for (const term of terms) {
  const start = newOnly ? new Date(newest.getTime() - 13 * DAY) : since;
  for (let a = new Date(start); a < newest; a = new Date(a.getTime() + 7 * DAY)) {
    const b = new Date(Math.min(a.getTime() + 7 * DAY, newest.getTime()));
    const q = `${term} after:${ISO(a)} before:${ISO(b)}`;
    stats.windows++;

    // Discourse treats page=1 as "the first page", same as no page at all. Real paging starts at 2.
    let page = null;
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
      const next = page === null ? 2 : page + 1;
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
console.error(`写入: node search.js ... > urls.txt && node fetch.js --file urls.txt`);
console.log(urls.join("\n"));
