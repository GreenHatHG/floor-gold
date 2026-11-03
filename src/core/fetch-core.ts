// Batch-fetch linux.do JSON through the logged-in Chrome. Saves under data/raw/, judges
// nothing. Pure logic: no process.exit, no own argv — the CLI wraps it, crawl.ts imports it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalError } from "../lib/fatal";
import { safe, searchFile } from "../lib/naming";
import { NOTES, RAW, TODO_FILE } from "../lib/paths";
import type { NoteRow, TopicDoc, TopicPost } from "../lib/types";

const shortHash = (s: string): string => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

interface Target {
	kind: string;
	file: string;
	merge?: boolean;
}

// URL -> stable readable file. Same URL always lands in the same file.
function targetFor(url: string): Target {
	const [p, q] = url.split("?");
	const qs = new URLSearchParams(q || "");
	let m: RegExpMatchArray | null;
	if ((m = p.match(/^\/t\/(\d+)(?=[./]|$)/))) {
		// /t/<id>.json and /t/<id>/posts.json both carry posts: merge into one file, nothing gets lost.
		if (/posts\.json$/.test(p)) return { kind: "topic", file: `topic/${m[1]}.json`, merge: true };
		if (/post_ids\.json$/.test(p)) return { kind: "ids", file: `ids/${m[1]}-at-${qs.get("post_number") || 1}.json` };
		return { kind: "topic", file: `topic/${m[1]}.json`, merge: true };
	}
	if ((m = p.match(/^\/search\.json$/))) {
		return {
			kind: "search",
			file: searchFile(qs.get("q"), qs.get("page")),
		};
	}
	if ((m = p.match(/^\/c\/(\d+)\/l\/latest\.json$/)))
		return { kind: "list", file: `list/c${m[1]}${qs.get("page") ? `-p${qs.get("page")}` : ""}.json` };
	if ((m = p.match(/^\/tag\/(.+?)\.json$/)))
		return { kind: "list", file: `tag/${safe(decodeURIComponent(m[1]))}.json` };
	if ((m = p.match(/^\/(latest|top|new|hot|categories|unread)(\.json)?$/)))
		return {
			kind: "list",
			file: `site/${m[1]}${qs.get("period") ? `-${safe(qs.get("period"))}` : ""}${qs.get("page") ? `-p${qs.get("page")}` : ""}.json`,
		};
	return { kind: "other", file: `other/${safe(p.slice(1).replace(/\//g, "-")) || "root"}-${shortHash(url)}.json` };
}

// Fields that describe the topic itself. /t/<id>/posts.json carries posts but no topic metadata,
// so it must not be allowed to blank out what an earlier /t/<id>.json told us.
const TOPIC_FIELDS = [
	"title",
	"posts_count",
	"highest_post_number",
	"last_posted_at",
	"created_at",
	"category_id",
	"tags",
	"closed",
	"archived",
	"views",
];

function mergeTopic(oldDoc: TopicDoc | null, newDoc: TopicDoc): TopicDoc {
	const posts = new Map<string, TopicPost>();
	for (const p of oldDoc?.post_stream?.posts || []) posts.set(String(p.id), p);
	for (const p of newDoc?.post_stream?.posts || []) posts.set(String(p.id), p);
	const merged = [...posts.values()].sort((a, b) => a.post_number - b.post_number);
	const known = [...new Set(merged.map((p) => String(p.id)))];

	const base: TopicDoc = Object.assign({}, oldDoc || {}, newDoc || {});
	for (const f of TOPIC_FIELDS) if (base[f] == null && oldDoc && oldDoc[f] != null) base[f] = oldDoc[f];

	// posts.json answers carry no post_stream.stream; keep the old id list rather than null it out.
	const oldPs = oldDoc?.post_stream || {};
	const newPs = newDoc?.post_stream || {};
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

export interface FetchOptions {
	session: string;
	batch: number;
	conc: number;
	rateN: number;
	rateWindow: number;
}

export interface FetchReport {
	ok: number;
	failed: number;
	total: number;
	seconds: string;
	todo: string[];
	log: string[];
	noteRows: NoteRow[];
}

// Page-side: rate-limited concurrent fetch, retries 429/5xx/network. Returns bodies as text.
const pageCode = (batch: string[], o: FetchOptions): string => `async () => {
  const URLS = ${JSON.stringify(batch)};
  const LIMIT = ${o.rateN}, WINDOW = ${o.rateWindow}, CONC = ${o.conc};
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

interface PageResult {
	url: string;
	ok?: boolean;
	status?: number;
	bytes?: number;
	body?: string;
	attempts?: number;
	ms?: number;
	blocked?: boolean;
	skipped?: boolean;
	error?: string;
}

function runBatch(batch: string[], o: FetchOptions): { results: PageResult[]; blocked: boolean } {
	const tmp = path.join(os.tmpdir(), `pwfetch-${process.pid}-${Date.now()}.json`);
	try {
		execFileSync("playwright-cli", [`-s=${o.session}`, "eval", `--filename=${tmp}`, pageCode(batch, o)], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch (e) {
		const err = e as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
		const msg = String(err.stderr || "") + String(err.stdout || "") + String(err.message || "");
		if (/not found|No session|not connected|attach|not open/i.test(msg)) {
			throw new FatalError(
				`cannot talk to session "${o.session}". Attach first:\n\n` +
					`  TOKEN=$(head -1 ~/.pi/chrome-extension-token.txt) && PLAYWRIGHT_MCP_EXTENSION_TOKEN=$TOKEN playwright-cli attach --extension=chrome\n`,
			);
		}
		throw new FatalError(`playwright-cli failed:\n${msg.slice(0, 800)}`);
	}
	if (!fs.existsSync(tmp)) throw new FatalError("no result file came back.");
	const parsed = JSON.parse(fs.readFileSync(tmp, "utf8")) as { results?: PageResult[]; blocked?: boolean };
	fs.unlinkSync(tmp);
	return { results: parsed.results || [], blocked: !!parsed.blocked };
}

const human = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`);
const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Accept both "/search.json?q=x" and the full "https://linux.do/search.json?q=x".
const normalize = (u: string): string => u.replace(/^https?:\/\/linux\.do/, "") || "/";

export async function fetchAll(urlsIn: string[], o: FetchOptions): Promise<FetchReport> {
	const urls = [...new Set(urlsIn.map(normalize))];
	const log: string[] = [];
	const say = (line: string): void => {
		log.push(line);
	};
	const noteRows: NoteRow[] = [];
	const notDone: string[] = [];
	let okCount = 0;
	let badCount = 0;
	const t0 = Date.now();

	for (let i = 0; i < urls.length; i += o.batch) {
		const batchStart = Date.now();
		const batch = urls.slice(i, i + o.batch);
		const { results, blocked } = runBatch(batch, o);
		const got = new Set(results.map((r) => r.url));
		for (const u of batch) {
			if (!got.has(u)) {
				badCount++;
				notDone.push(u);
				say(`FAIL none  ${u}  (page returned no result, maybe it was navigated away)`);
			}
		}
		for (const r of results) {
			const dest = targetFor(r.url);
			const abs = path.join(RAW, dest.file);
			fs.mkdirSync(path.dirname(abs), { recursive: true });

			if (!r.ok) {
				badCount++;
				notDone.push(r.url);
				const why = r.blocked
					? "  (Cloudflare blocked it, stopping the whole batch)"
					: r.skipped
						? "  (stopped, not sent)"
						: r.status
							? `  (status ${r.status})`
							: "";
				say(`FAIL ${r.status || "err"}  ${r.url}${why}`);
				if (r.error) say(`     ${r.error.slice(0, 200)}`);
				continue;
			}

			let doc: TopicDoc;
			try {
				doc = JSON.parse(r.body as string) as TopicDoc;
			} catch {
				badCount++;
				notDone.push(r.url);
				say(`FAIL !json  ${r.url}  (${human(r.bytes || 0)} of non-JSON, maybe logged out or challenged)`);
				continue;
			}

			if (dest.merge && fs.existsSync(abs)) {
				let oldDoc: TopicDoc | null = null;
				try {
					oldDoc = JSON.parse(fs.readFileSync(abs, "utf8")) as TopicDoc;
				} catch {
					say(`     (old file was corrupt, overwriting it: ${dest.file})`);
				}
				if (oldDoc) doc = mergeTopic(oldDoc, doc);
			}
			// write-then-rename: a Ctrl-C mid-write must not leave a half JSON that poisons every later run
			const tmpOut = `${abs}.tmp`;
			fs.writeFileSync(tmpOut, JSON.stringify(doc));
			fs.renameSync(tmpOut, abs);

			// A 200 is not proof that a post was deleted: an error body or a surprise shape must not poison the memo.
			const looksLikePosts = doc?.post_stream && Array.isArray(doc.post_stream.posts) && !doc.errors;
			if (looksLikePosts && /\/posts\.json$/.test(r.url.split("?")[0])) {
				const asked = new URLSearchParams(r.url.split("?")[1] || "").getAll("post_ids[]");
				const back = new Set(doc.post_stream!.posts!.map((p) => String(p.id)));
				const lost = asked.filter((x) => !back.has(String(x)));
				if (lost.length) noteRows.push({ t: "missing", id: doc.id, pid: lost });
			}

			okCount++;
			const outBytes = fs.statSync(abs).size;
			const took = r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : "?";
			const retries = (r.attempts || 0) > 1 ? `  x${r.attempts}` : "";
			say(
				`ok   ${String(r.status).padEnd(3)} ${human(outBytes).padStart(5)} ${took.padStart(6)}  ${dest.file}${dest.merge ? "  (merged)" : ""}${retries}`,
			);
		}

		if (blocked) {
			const left = urls.slice(i + o.batch);
			for (const u of left) notDone.push(u);
			say(`\n[stop] Cloudflare returned 429/403, the remaining ${left.length} urls were not sent.`);
			say(`       Wait a few minutes and rerun the same command; fetched ones are skipped automatically.`);
			break;
		}

		// The page-side limiter only knows about its own batch. Align the next batch to this one's quota
		// so a fast batch boundary cannot double the request rate.
		const quotaMs = Math.ceil(batch.length / o.rateN) * o.rateWindow;
		const spent = Date.now() - batchStart;
		if (i + o.batch < urls.length && spent < quotaMs) sleepSync(quotaMs - spent);
	}

	const seconds = ((Date.now() - t0) / 1000).toFixed(1);
	if (noteRows.length) {
		fs.mkdirSync(path.dirname(NOTES), { recursive: true });
		fs.appendFileSync(NOTES, `${noteRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	}
	if (notDone.length) {
		fs.mkdirSync(path.dirname(TODO_FILE), { recursive: true });
		fs.writeFileSync(TODO_FILE, `${[...new Set(notDone)].join("\n")}\n`);
	}
	return { ok: okCount, failed: badCount, total: urls.length, seconds, todo: notDone, log, noteRows };
}
