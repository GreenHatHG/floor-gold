#!/usr/bin/env node
// Compare data/raw/ with what the server reports, print only the gaps. Never hits the network.
// The contract is HELP_SHORT (-h) and HELP (--help), not this comment.
const HELP_SHORT = `pending.ts — diff data/raw/ against what the server reports, print only the gaps.

Never talks to the network. Topic files remember their own highest post number; the search
and list files we already fetched say what the server thinks. This prints the difference.

Usage:
  node dist/pending.js                         human summary
  node dist/pending.js --urls                  only the URLs to fetch, one per line
  node dist/pending.js --urls --include-new    also queue threads you never opened
  node dist/pending.js -h                      this summary
  node dist/pending.js --help                  files, notes.jsonl, summary marks

Options:
  --urls          print URLs only, for a file:
                    node dist/pending.js --urls > urls.txt && node dist/fetch.js --file urls.txt
  --include-new   include threads from a feed that were never opened (off by default)
  --top 25        how many never-opened threads to list (default 25)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Exit codes: 0 ok · 2 bad arguments, for example --top 0
`;

const HELP = HELP_SHORT + `
Summary marks:
  [跳过] you marked it skip or noise    [已判] judged, not skipped
  新楼 new replies    补洞 a gap inside posts you already hold
  (等楼号表) the id table must come back first; those posts are fetched on the next run

Reads:
  data/raw/{topic,search,list,tag,site}/*.json
  data/raw/ids/*.json  the post number tables that say which holes are already explained
  data/index.jsonl    one judgement per line, the last line wins
  data/notes.jsonl    bookkeeping rows, see Writes

Writes:
  data/notes.jsonl only, plus one delete: a stale ids table (data/raw/ids/...) is removed so
  the next run must ask the server again. Two row kinds in notes:
    {t:"asked", id, anchor, high}   asked for posts above anchor, server was at high, nothing new
    {t:"missing", id, pid:[...]}    the server says these posts are gone, stop asking

Why it is not simpler (keep these rules):
  - posts_count lies after a delete; highest_post_number does not.
  - /post_ids.json?post_number=N returns posts AFTER N, never N itself.
  - An id table only proves the moment it was fetched. So a tail is asked again whenever the
    server's highest post number moved, or a reply landing after a delete stays invisible.
  - A hole is asked once. If nothing comes back, it is a deleted post and is remembered.
`;

import fs from "node:fs";
import path from "node:path";
import {
  parseArgs,
  UsageError,
  type FeedDoc,
  type FeedTopic,
  type IdsDoc,
  type IndexRow,
  type NoteRow,
  type Opts,
  type TopicDoc,
} from "./lib";

// dist/ holds the built files; data/ stays at the repo root next to it.
const ROOT = path.join(__dirname, "..");
const RAW = path.join(ROOT, "data", "raw");
const INDEX = path.join(ROOT, "data", "index.jsonl");
const NOTES = path.join(ROOT, "data", "notes.jsonl");

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
try {
  ({ opts } = parseArgs(argv, { urls: "flag", "include-new": "flag", top: "value" }));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  console.error("Full contract: node dist/pending.js -h");
  process.exit(2);
}
const opt = (n: string, dflt: string | number): string => {
  const v = opts[n];
  return typeof v === "string" ? v : String(dflt);
};
const urlsOnly = !!opts.urls;
const includeNew = !!opts["include-new"];
const TOP = (() => {
  const raw = opt("top", 25);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 1) {
    console.error(`--top must be a number >= 1, got: ${raw}`);
    process.exit(2);
  }
  return v;
})();

const ls = (d: string): string[] => {
  const p = path.join(RAW, d);
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(p, f));
};
const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};

function readIndex(): Map<number, IndexRow> {
  const out = new Map<number, IndexRow>();
  if (!fs.existsSync(INDEX)) return out;
  for (const line of fs.readFileSync(INDEX, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as IndexRow;
      if (row && row.id != null) out.set(Number(row.id), Object.assign(out.get(Number(row.id)) || {}, row));
    } catch {}
  }
  return out;
}
const idx = readIndex();

// notes.jsonl is machine bookkeeping, appended by fetch.js and by this script:
//   {t:"missing", id, pid:[]}  server said these post ids do not exist -> stop asking
//   {t:"asked",   id, anchor, high}  we already asked for ids above `anchor` while the server
//                                   claimed `high` -> nothing new came back, do not ask again
const asked = new Map<string, number>();
const missing = new Set<string>();
if (fs.existsSync(NOTES)) {
  for (const line of fs.readFileSync(NOTES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as NoteRow;
      if (row.t === "missing" && row.id != null) for (const p of row.pid || []) missing.add(`${row.id}:${p}`);
      if (row.t === "asked" && row.id != null) asked.set(`${row.id}:${row.anchor}`, Number(row.high));
    } catch {}
  }
}
const noteRows: NoteRow[] = [];

// ---- what we have locally ----
interface LocalTopic {
  title?: string;
  nums: number[];
  max: number;
  highest: number;
}
const local = new Map<number, LocalTopic>();
const knownIds = new Set<string>();
for (const f of ls("topic")) {
  const t = readJson<TopicDoc>(f);
  if (!t || t.id == null) continue;
  const posts = (t.post_stream && t.post_stream.posts) || [];
  const nums = posts.map((p) => p.post_number).sort((a, b) => a - b);
  for (const p of posts) knownIds.add(`${t.id}:${p.id}`);
  local.set(Number(t.id), {
    title: t.title,
    nums,
    max: nums.length ? nums[nums.length - 1] : 0,
    highest: t.highest_post_number || 0,
  });
}

// ---- what the server said, from any list or search we already fetched ----
interface ServerTopic {
  title?: string;
  highest: number;
  last: string | null;
  category_id?: number;
}
const server = new Map<number, ServerTopic>();
const feeds = [...ls("search"), ...ls("list"), ...ls("tag"), ...ls("site")];
for (const f of feeds) {
  const doc = readJson<FeedDoc>(f);
  const topics: FeedTopic[] = (doc && doc.topics) || (doc && doc.topic_list && doc.topic_list.topics) || [];
  for (const t of topics) {
    if (!t || t.id == null) continue;
    const prev = server.get(Number(t.id)) || { highest: 0, last: null };
    server.set(Number(t.id), {
      title: t.title || prev.title,
      highest: Math.max(prev.highest || 0, t.highest_post_number || t.posts_count || 0),
      last: [prev.last, t.last_posted_at].filter(Boolean).sort().pop() || null,
      category_id: t.category_id != null ? t.category_id : prev.category_id,
    });
  }
}

const md = (iso?: string | null): string => {
  if (!iso) return "??-??";
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const skipped = (id: number): boolean =>
  ["skip", "noise", "已看", "跳过"].includes(String((idx.get(id) || {}).verdict || "").toLowerCase());

// ---- new: in a feed, never opened ----
const fresh = [...server.entries()]
  .filter(([id]) => !local.has(id))
  .map(([id, s]) => Object.assign({ id }, s))
  .sort((a, b) => String(b.last).localeCompare(String(a.last)));

// ---- changed: opened before, and the server says something moved (or we know we have a hole) ----
// A hole memo is permanent: once we asked for the ids above a hole and got nothing, it is a deleted post.
// A tail memo is only valid at the server height it was taken at -- otherwise a reply that landed after
// the last ask would stay invisible forever.
interface Change {
  id: number;
  title?: string;
  localMax: number;
  serverHighest: number | null;
  from: number;
  to: number;
  kind: "补洞" | "新楼";
  urls: string[];
  waitingOn: string | null;
  last?: string | null;
}
const IDS_CHUNK = 50;
const changed: Change[] = [];
for (const [id, l] of local.entries()) {
  const s = server.get(id);
  // the topic file itself remembers the highest post number at fetch time, so an unfinished topic
  // is spotted even when no feed we fetched happens to mention it
  const high = Math.max((s && s.highest) || 0, l.highest || 0);
  const have = new Set(l.nums);
  const serverAhead = high > l.max;

  const holes: [number, number][] = [];
  for (let n = 1; n <= l.max; n++) {
    if (have.has(n)) continue;
    const last = holes[holes.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else holes.push([n, n]);
  }
  const openHoles = holes.filter(([a]) => a > 1 && !readJson(path.join(RAW, "ids", `${id}-at-${a - 1}.json`)));
  if (!serverAhead && !openHoles.length) continue;

  const pick = openHoles.length
    ? { anchor: openHoles[0][0] - 1, range: openHoles[0], tail: false }
    : { anchor: l.max, range: [l.max + 1, high] as [number, number], tail: true };

  const urls: string[] = [];
  let waitingOn: string | null = null;
  const idsPath = path.join(RAW, "ids", `${id}-at-${pick.anchor}.json`);
  const idsDoc = readJson<IdsDoc>(idsPath);
  const tailIsFresh = !pick.tail || asked.get(`${id}:${pick.anchor}`) === high;

  if (!idsDoc || !tailIsFresh) {
    // a stale ids table would answer the old question again; drop it so the next run must ask
    if (pick.tail && idsDoc) {
      try {
        fs.unlinkSync(idsPath);
      } catch {}
    }
    urls.push(`/t/${id}/post_ids.json?post_number=${pick.anchor}`);
    waitingOn = "楼号表";
    if (pick.tail) noteRows.push({ t: "asked", id, anchor: pick.anchor, high });
  } else {
    const miss = (idsDoc.post_ids || []).map(String).filter((x) => !knownIds.has(`${id}:${x}`) && !missing.has(`${id}:${x}`));
    for (let i = 0; i < miss.length; i += IDS_CHUNK) {
      const chunk = miss.slice(i, i + IDS_CHUNK);
      urls.push(`/t/${id}/posts.json?` + chunk.map((x) => `post_ids[]=${x}`).join("&"));
    }
  }
  if (!urls.length) continue;

  changed.push({
    id,
    title: l.title,
    localMax: l.max,
    serverHighest: s ? s.highest : null,
    from: pick.range[0],
    to: pick.range[1],
    kind: openHoles.length ? "补洞" : "新楼",
    urls,
    waitingOn,
    last: s && s.last,
  });
}
changed.sort((a, b) => String(b.last).localeCompare(String(a.last)));

// ---- output ----
const allUrls = [
  ...changed.flatMap((c) => c.urls),
  ...(includeNew ? fresh.filter((t) => !skipped(t.id)).map((t) => `/t/${t.id}.json`) : []),
];
if (urlsOnly) {
  if (allUrls.length) console.log(allUrls.join("\n"));
  if (noteRows.length) fs.appendFileSync(NOTES, noteRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.exit(0);
}

console.log(`本地 ${local.size} 个主题 · 服务器视图 ${server.size} 个 · 新帖 ${fresh.length} · 有更新 ${changed.length}`);
if (!feeds.length) {
  console.log("\n还没有任何搜索或列表数据。先拉一次：");
  console.log('  node dist/fetch.js "/search.json?q=招聘"');
  if (!changed.length) process.exit(0);
  console.log("（下面的更新是从帖子文件自己记住的最高楼号看出来的）");
}

if (fresh.length) {
  console.log(`\n=== 没打开过 (${fresh.length}) ===`);
  for (const t of fresh.slice(0, TOP)) {
    const mark = skipped(t.id) ? "[跳过] " : idx.has(t.id) ? "[已判] " : "";
    console.log(`${mark}${t.id}  ${md(t.last)}  c${t.category_id || "?"}  ${t.title || "(无标题)"}`);
  }
  if (fresh.length > TOP) console.log(`… 还有 ${fresh.length - TOP} 个，用 --top= 看更多`);
}

if (changed.length) {
  console.log(`\n=== 有更新 (${changed.length}) ===`);
  for (const c of changed) {
    const bits = [`${c.id}`, md(c.last), c.title || "", `${c.kind} ${c.from}-${c.to}`];
    if (c.waitingOn) bits.push(`(等${c.waitingOn})`);
    console.log(bits.join("  "));
    for (const u of c.urls) console.log(`    ${u}`);
  }
}

const unknown = [...local.keys()].filter((id) => !server.has(id)).length;
if (unknown) console.log(`\n(${unknown} 个本地主题不在任何已拉取的列表里，无法判断有没有新回复)`);

if (allUrls.length) {
  console.log(`\n拉这些：\n  node dist/fetch.js ${allUrls.map((u) => `"${u}"`).join(" ")}`);
  console.log(`或：node dist/pending.js --urls > urls.txt && node dist/fetch.js --file urls.txt`);
}
if (!includeNew && fresh.length) console.log(`(没打开过的帖不在 --urls 里；想一起拉就加 --include-new)`);

if (noteRows.length) fs.appendFileSync(NOTES, noteRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
