#!/usr/bin/env node
// Compare data/raw/ with what the server reports, print only the gaps. Never hits the network.
// The contract is HELP (-h / --help), not this comment.
const HELP = `pending.ts — diff data/raw/ against what the server reports, print only the gaps.

Never talks to the network. Topic files remember their own highest post number; the search
and list files we already fetched say what the server thinks. This prints the difference.

Usage:
  bun run pending.ts                         human summary
  bun run pending.ts --urls                  only the URLs to fetch, one per line
  bun run pending.ts --urls --include-new    also queue threads you never opened

Options:
  --urls          print URLs only, for a file:
                    bun run pending.ts --urls > urls.txt && bun run fetch.ts --file urls.txt
  --include-new   include threads from a feed that were never opened (off by default)
  --top 25        how many never-opened threads to list (default 25)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Summary marks:
  [skip] you marked it skip or noise    [done] judged, not skipped
  new replies    gap-fill a gap inside posts you already hold
  (waiting on post id table) the id table must come back first; those posts are fetched on the next run

Reads data/raw/{topic,search,list,tag,site}/*.json, data/raw/ids/*.json (the post number
tables that say which holes are already explained), data/index.jsonl (one judgement per
line, the last line wins) and data/notes.jsonl (bookkeeping, see README).
Writes data/notes.jsonl only, plus one delete: a stale ids table is removed so the next run
must ask the server again. Row kinds: {t:"asked", id, anchor, high} asked for posts above
anchor, server was at high, nothing new; {t:"missing", id, pid:[...]} these posts are gone,
stop asking.

Exit codes: 0 ok · 2 bad arguments, for example --top 0
`;

import fs from "node:fs";
import path from "node:path";
import {
	type FeedDoc,
	type FeedTopic,
	type IdsDoc,
	type IndexRow,
	type NoteRow,
	type Opts,
	parseArgs,
	type TopicDoc,
	UsageError,
} from "./lib";

// data/ stays at the repo root. __dirname is already the repo root under bun run; a ".."
// here points OUTSIDE the repo (found by the monthly-grid rewrite: cache never hit).
const ROOT = __dirname;
const RAW = path.join(ROOT, "data", "raw");
const INDEX = path.join(ROOT, "data", "index.jsonl");
const NOTES = path.join(ROOT, "data", "notes.jsonl");

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
let opts: Opts = {};
try {
	({ opts } = parseArgs(argv, { urls: "flag", "include-new": "flag", top: "value" }));
} catch (e) {
	if (!(e instanceof UsageError)) throw e;
	console.error(e.message);
	console.error("Usage: bun run pending.ts -h");
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

// notes.jsonl is machine bookkeeping, appended by fetch.ts and by this script:
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
	const posts = t.post_stream?.posts || [];
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
	const topics: FeedTopic[] = doc?.topics || doc?.topic_list?.topics || [];
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
	["skip", "noise", "seen", "已看", "跳过"].includes(String(idx.get(id)?.verdict || "").toLowerCase());

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
	kind: "gap-fill" | "new";
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
	const high = Math.max(s?.highest || 0, l.highest || 0);
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
		waitingOn = "post id table";
		if (pick.tail) noteRows.push({ t: "asked", id, anchor: pick.anchor, high });
	} else {
		const miss = (idsDoc.post_ids || [])
			.map(String)
			.filter((x) => !knownIds.has(`${id}:${x}`) && !missing.has(`${id}:${x}`));
		for (let i = 0; i < miss.length; i += IDS_CHUNK) {
			const chunk = miss.slice(i, i + IDS_CHUNK);
			urls.push(`/t/${id}/posts.json?${chunk.map((x) => `post_ids[]=${x}`).join("&")}`);
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
		kind: openHoles.length ? "gap-fill" : "new",
		urls,
		waitingOn,
		last: s?.last,
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
	if (noteRows.length) fs.appendFileSync(NOTES, `${noteRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	process.exit(0);
}

console.log(
	`local ${local.size} topics · server view ${server.size} · new ${fresh.length} · updated ${changed.length}`,
);
if (!feeds.length) {
	console.log("\nNo search or list data yet. Fetch once first:");
	console.log('  bun run fetch.ts "/search.json?q=招聘"');
	if (!changed.length) process.exit(0);
	console.log("(updates below are read from the highest post number remembered in the topic files themselves)");
}

if (fresh.length) {
	console.log(`\n=== never opened (${fresh.length}) ===`);
	for (const t of fresh.slice(0, TOP)) {
		const mark = skipped(t.id) ? "[skip] " : idx.has(t.id) ? "[done] " : "";
		console.log(`${mark}${t.id}  ${md(t.last)}  c${t.category_id || "?"}  ${t.title || "(no title)"}`);
	}
	if (fresh.length > TOP) console.log(`… and ${fresh.length - TOP} more, use --top= to see more`);
}

if (changed.length) {
	console.log(`\n=== updated (${changed.length}) ===`);
	for (const c of changed) {
		const bits = [`${c.id}`, md(c.last), c.title || "", `${c.kind} ${c.from}-${c.to}`];
		if (c.waitingOn) bits.push(`(waiting on ${c.waitingOn})`);
		console.log(bits.join("  "));
		for (const u of c.urls) console.log(`    ${u}`);
	}
}

const unknown = [...local.keys()].filter((id) => !server.has(id)).length;
if (unknown)
	console.log(`\n(${unknown} local topics are not in any fetched list, cannot tell if they have new replies)`);

if (allUrls.length) {
	console.log(`\nfetch these:\n  bun run fetch.ts ${allUrls.map((u) => `"${u}"`).join(" ")}`);
	console.log(`or: bun run pending.ts --urls > urls.txt && bun run fetch.ts --file urls.txt`);
}
if (!includeNew && fresh.length)
	console.log(`(never-opened topics are not in --urls; add --include-new to fetch them too)`);

if (noteRows.length) fs.appendFileSync(NOTES, `${noteRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
