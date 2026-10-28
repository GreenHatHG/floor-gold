#!/usr/bin/env node
// Batch-fetch linux.do JSON through the already-logged-in Chrome, dump to data/raw/, print a tiny manifest.
// Usage: node fetch.js <url> [url...]     |     node fetch.js --file urls.txt
// Options: --batch=20  --session=chrome  --rate=2/3000  --conc=2
//
// This script judges nothing. It fetches, saves, and reports. Picking what to fetch is the agent's job.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const RAW = path.join(ROOT, "data", "raw");
const NOTES = path.join(ROOT, "data", "notes.jsonl");

const rawArgs = process.argv.slice(2);
const args = [];
const opts = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (!a.startsWith("--")) { args.push(a); continue; }
  const eq = a.indexOf("=");
  if (eq > -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
  else if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--")) opts[a.slice(2)] = rawArgs[++i];
  else opts[a.slice(2)] = true;
}
const opt = (name, dflt) => (name in opts ? opts[name] : dflt);
const num = (name, dflt, min) => {
  const raw = opt(name, dflt);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.error(`--${name} must be a number >= ${min}, got: ${raw}`);
    process.exit(2);
  }
  return n;
};
const SESSION = opt("session", "chrome");
const BATCH = num("batch", 20, 1);
const CONC = num("conc", 2, 1);
const rate = String(opt("rate", "2/3000")).split("/");
const RATE_N = Number(rate[0]);
const RATE_WINDOW = Number(rate[1]);
if (!Number.isFinite(RATE_N) || RATE_N < 1 || !Number.isFinite(RATE_WINDOW) || RATE_WINDOW < 1) {
  console.error(`--rate must look like 2/3000, got: ${opt("rate")}`);
  process.exit(2);
}

let urls = args.slice();
const fileArg = opt("file", null);
if (fileArg) {
  if (!fs.existsSync(fileArg)) {
    console.error(`--file ${fileArg}: no such file`);
    process.exit(2);
  }
  urls = urls.concat(
    fs.readFileSync(fileArg, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
  );
}
// Accept both "/search.json?q=x" and the full "https://linux.do/search.json?q=x".
const normalize = (u) => u.replace(/^https?:\/\/linux\.do/, "") || "/";

urls = [...new Set(urls.map(normalize))];
if (!urls.length) {
  console.error("no urls. try: node fetch.js '/search.json?q=招聘'");
  process.exit(2);
}

// Page-side: rate-limited concurrent fetch, retries 429/5xx/network. Returns bodies as text.
const pageCode = (batch) => `async () => {
  const URLS = ${JSON.stringify(batch)};
  const LIMIT = ${RATE_N}, WINDOW = ${RATE_WINDOW}, CONC = ${CONC};
  let inflight = 0;
  const starts = [];
  const waiting = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Chrome clamps setTimeout in background tabs, so never poll on a short timer:
  // take a slot from a queue, and sleep exactly until the window frees up.
  const acquire = async () => {
    if (inflight < CONC) { inflight++; return; }
    await new Promise((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else inflight--;
  };
  const slot = async () => {
    for (;;) {
      await acquire();
      const now = Date.now();
      while (starts.length && now - starts[0] >= WINDOW) starts.shift();
      if (starts.length < LIMIT) { starts.push(now); return; }
      release();
      await sleep(WINDOW - (Date.now() - starts[0]) + 10);
    }
  };
  // A 429 here is Cloudflare's challenge page, not a polite rate limit. Retrying while it is
  // watching makes it worse, so one 429 stops the whole batch and hands the rest back.
  let blocked = false;
  const grab = async (u) => {
    const t0 = Date.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      if (blocked) return { ok: false, status: 0, skipped: true, ms: Date.now() - t0 };
      try {
        const r = await fetch(u, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        const txt = await r.text();
        if (r.status === 429 || r.status === 403) {
          blocked = true;
          return { ok: false, status: r.status, bytes: txt.length, blocked: true, attempts, ms: Date.now() - t0 };
        }
        if (r.status >= 500 && attempts < 2) {
          await sleep(4000);
          continue;
        }
        return { ok: r.ok, status: r.status, bytes: txt.length, body: txt, attempts, ms: Date.now() - t0 };
      } catch (e) {
        if (attempts >= 2) return { ok: false, status: 0, error: String(e), attempts, ms: Date.now() - t0 };
        await sleep(2000);
      }
    }
  };
  const results = new Array(URLS.length);
  await Promise.all(URLS.map(async (u, i) => {
    await slot();
    try { results[i] = Object.assign({ url: u }, await grab(u)); }
    catch (e) { results[i] = { url: u, ok: false, status: 0, error: String(e) }; }
    finally { release(); }
  }));
  return { requested: URLS.length, blocked, results };
}`;

const { searchFile } = require("./lib");

const shortHash = (s) => require("crypto").createHash("sha1").update(s).digest("hex").slice(0, 8);
const safe = (s) => require("./lib").safe(s);

// URL -> stable readable file. Same URL always lands in the same file.
function targetFor(url) {
  const [p, q] = url.split("?");
  const qs = new URLSearchParams(q || "");
  let m;
  if ((m = p.match(/^\/t\/(\d+)(?=[./]|$)/))) {
    // /t/<id>.json and /t/<id>/posts.json both carry posts: merge into one file, nothing gets lost.
    if (/posts\.json$/.test(p)) return { kind: "topic", file: `topic/${m[1]}.json`, merge: true };
    if (/post_ids\.json$/.test(p))
      return { kind: "ids", file: `ids/${m[1]}-at-${qs.get("post_number") || 1}.json` };
    return { kind: "topic", file: `topic/${m[1]}.json`, merge: true };
  }
  if ((m = p.match(/^\/search\.json$/)))
    return {
      kind: "search",
      file: searchFile(qs.get("q"), qs.get("page")),
    };
  if ((m = p.match(/^\/c\/(\d+)\/l\/latest\.json$/)))
    return { kind: "list", file: `list/c${m[1]}${qs.get("page") ? "-p" + qs.get("page") : ""}.json` };
  if ((m = p.match(/^\/tag\/(.+?)\.json$/))) return { kind: "list", file: `tag/${safe(decodeURIComponent(m[1]))}.json` };
  if ((m = p.match(/^\/(latest|top|new|hot|categories|unread)(\.json)?$/)))
    return {
      kind: "list",
      file: `site/${m[1]}${qs.get("period") ? "-" + safe(qs.get("period")) : ""}${qs.get("page") ? "-p" + qs.get("page") : ""}.json`,
    };
  return { kind: "other", file: `other/${safe(p.slice(1).replace(/\//g, "-")) || "root"}-${shortHash(url)}.json` };
}

// Fields that describe the topic itself. /t/<id>/posts.json carries posts but no topic metadata,
// so it must not be allowed to blank out what an earlier /t/<id>.json told us.
const TOPIC_FIELDS = ["title", "posts_count", "highest_post_number", "last_posted_at", "created_at", "category_id", "tags", "closed", "archived", "views"];

function mergeTopic(oldDoc, newDoc) {
  const posts = new Map();
  for (const p of (oldDoc && oldDoc.post_stream && oldDoc.post_stream.posts) || []) posts.set(String(p.id), p);
  for (const p of (newDoc && newDoc.post_stream && newDoc.post_stream.posts) || []) posts.set(String(p.id), p);
  const merged = [...posts.values()].sort((a, b) => a.post_number - b.post_number);
  const known = [...new Set(merged.map((p) => String(p.id)))];

  const base = Object.assign({}, oldDoc || {}, newDoc || {});
  for (const f of TOPIC_FIELDS) if (base[f] == null && oldDoc && oldDoc[f] != null) base[f] = oldDoc[f];

  // posts.json answers carry no post_stream.stream; keep the old id list rather than null it out.
  const oldPs = (oldDoc && oldDoc.post_stream) || {};
  const newPs = (newDoc && newDoc.post_stream) || {};
  // the cached counters must not contradict the posts we now hold, or the digest header lies
  const mergedMax = merged.length ? merged[merged.length - 1].post_number : 0;
  base.highest_post_number = Math.max(base.highest_post_number || 0, mergedMax);
  base.posts_count = Math.max(base.posts_count || 0, merged.length);

  return Object.assign(base, {
    post_stream: Object.assign({}, oldPs, newPs, { posts: merged, stream: newPs.stream || oldPs.stream || [] }),
    _known_post_ids: known,
    _merged_at: new Date().toISOString(),
  });
}

function runBatch(batch) {
  const tmp = path.join(os.tmpdir(), `pwfetch-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync("playwright-cli", [`-s=${SESSION}`, "eval", `--filename=${tmp}`, pageCode(batch)], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    const msg = String((e.stderr || "") + (e.stdout || "") + (e.message || ""));
    if (/not found|No session|not connected|attach|not open/i.test(msg)) {
      console.error(`\n[fetch] cannot talk to session "${SESSION}". Attach first:\n`);
      console.error(`  TOKEN=$(head -1 ~/.pi/chrome-extension-token.txt) && PLAYWRIGHT_MCP_EXTENSION_TOKEN=$TOKEN playwright-cli attach --extension=chrome\n`);
    } else {
      console.error("[fetch] playwright-cli failed:\n" + msg.slice(0, 800));
    }
    process.exit(1);
  }
  if (!fs.existsSync(tmp)) {
    console.error("[fetch] no result file came back.");
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.unlinkSync(tmp);
  return { results: parsed.results || [], blocked: !!parsed.blocked };
}

const human = (n) => (n >= 1024 ? Math.round(n / 1024) + "K" : n + "B");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let okCount = 0;
let badCount = 0;
const noteRows = [];
const notDone = [];
const t0 = Date.now();

for (let i = 0; i < urls.length; i += BATCH) {
  const batchStart = Date.now();
  const batch = urls.slice(i, i + BATCH);
  const { results, blocked } = runBatch(batch);
  const got = new Set(results.map((r) => r.url));
  for (const u of batch) {
    if (!got.has(u)) {
      badCount++;
      notDone.push(u);
      console.log(`FAIL none  ${u}  (页内没返回结果，可能页面被导航走了)`);
    }
  }
  for (const r of results) {
    const dest = targetFor(r.url);
    const abs = path.join(RAW, dest.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    if (!r.ok) {
      badCount++;
      notDone.push(r.url);
      const why = r.blocked ? "  (Cloudflare 挡住了，整批停手)" : r.skipped ? "  (已停手，没发)" : r.status ? `  (status ${r.status})` : "";
      console.log(`FAIL ${r.status || "err"}  ${r.url}${why}`);
      if (r.error) console.log(`     ${r.error.slice(0, 200)}`);
      continue;
    }

    let doc;
    try {
      doc = JSON.parse(r.body);
    } catch {
      badCount++;
      notDone.push(r.url);
      console.log(`FAIL !json  ${r.url}  (${human(r.bytes)} of non-JSON, maybe logged out or challenged)`);
      continue;
    }

    if (dest.merge && fs.existsSync(abs)) {
      let oldDoc = null;
      try {
        oldDoc = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch {
        console.log(`     (旧文件坏了，直接盖掉: ${dest.file})`);
      }
      if (oldDoc) doc = mergeTopic(oldDoc, doc);
    }
    // write-then-rename: a Ctrl-C mid-write must not leave a half JSON that poisons every later run
    const tmpOut = `${abs}.tmp`;
    fs.writeFileSync(tmpOut, JSON.stringify(doc));
    fs.renameSync(tmpOut, abs);

    // A 200 is not proof that a post was deleted: an error body or a surprise shape must not poison the memo.
    const looksLikePosts = doc && doc.post_stream && Array.isArray(doc.post_stream.posts) && !doc.errors;
    if (looksLikePosts && /\/posts\.json$/.test(r.url.split("?")[0])) {
      const asked = new URLSearchParams(r.url.split("?")[1] || "").getAll("post_ids[]");
      const back = new Set(doc.post_stream.posts.map((p) => String(p.id)));
      const lost = asked.filter((x) => !back.has(String(x)));
      if (lost.length) noteRows.push({ t: "missing", id: doc.id, pid: lost });
    }

    okCount++;
    const outBytes = fs.statSync(abs).size;
    const took = r.ms != null ? (r.ms / 1000).toFixed(1) + "s" : "?";
    const retries = r.attempts > 1 ? `  x${r.attempts}` : "";
    console.log(`ok   ${String(r.status).padEnd(3)} ${human(outBytes).padStart(5)} ${took.padStart(6)}  ${dest.file}${dest.merge ? "  (merged)" : ""}${retries}`);
  }

  if (blocked) {
    const left = urls.slice(i + BATCH);
    for (const u of left) notDone.push(u);
    console.log(`\n[停] Cloudflare 给了 429/403，剩下的 ${left.length} 个没发。`);
    console.log(`     等几分钟再跑同一条命令，已抓的会自动跳过。`);
    break;
  }

  // The page-side limiter only knows about its own batch. Align the next batch to this one's quota
  // so a fast batch boundary cannot double the request rate.
  const quotaMs = Math.ceil(batch.length / RATE_N) * RATE_WINDOW;
  const spent = Date.now() - batchStart;
  if (i + BATCH < urls.length && spent < quotaMs) sleepSync(quotaMs - spent);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (noteRows.length) {
  fs.mkdirSync(path.dirname(NOTES), { recursive: true });
  fs.appendFileSync(NOTES, noteRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
console.log(`\n${okCount} ok, ${badCount} failed, ${urls.length} urls, ${secs}s -> data/raw/`);
if (notDone.length) {
  const out = path.join(ROOT, "data", "todo.txt");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [...new Set(notDone)].join("\n") + "\n");
  console.log(`${notDone.length} 个没抓到，已写进 data/todo.txt（下次：node fetch.js --file data/todo.txt）`);
}
if (badCount) process.exit(1);
