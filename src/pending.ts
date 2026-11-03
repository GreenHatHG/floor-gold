#!/usr/bin/env bun
// Compare data/raw/ with what the server reports, print only the gaps. Never hits the network.
// The contract is HELP (-h / --help), not this comment.
const HELP = `pending.ts — diff data/raw/ against what the server reports, print only the gaps.

Never talks to the network. Topic files remember their own highest post number; the search
and list files we already fetched say what the server thinks. This prints the difference.

Usage:
  bun run src/pending.ts                         human summary
  bun run src/pending.ts --urls                  only the URLs to fetch, one per line
  bun run src/pending.ts --urls --include-new    also queue threads you never opened

Options:
  --urls          print URLs only, for a file:
                    bun run src/pending.ts --urls > urls.txt && bun run src/fetch.ts --file urls.txt
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

import { appendNoteRows, readIndex, readNotes } from "./cli/index-store";
import { findChanges, scanLocal, scanServer } from "./cli/topic-state";
import { flagOf, numOf, parseOrExit, showHelp } from "./lib/cli";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) showHelp(HELP);
const { opts } = parseOrExit(argv, { urls: "flag", "include-new": "flag", top: "value" }, "pending.ts");

// ---- main: scan, diff, print ----
const urlsOnly = flagOf(opts, "urls");
const includeNew = flagOf(opts, "include-new");
const TOP = numOf(opts, "top", 25, 1);

const idx = readIndex();
const notes = readNotes();
const noteRows: Parameters<typeof appendNoteRows>[0] = [];
const { local, knownIds } = scanLocal();
const { server, feeds } = scanServer();
const fresh = [...server.entries()]
	.filter(([id]) => !local.has(id))
	.map(([id, s]) => Object.assign({ id }, s))
	.sort((a, b) => String(b.last).localeCompare(String(a.last)));
const changed = findChanges(local, server, knownIds, notes, noteRows);

const md = (iso?: string | null): string => {
	if (!iso) return "??-??";
	const d = new Date(iso);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const skipped = (id: number): boolean =>
	["skip", "noise", "seen", "已看", "跳过"].includes(String(idx.get(id)?.verdict || "").toLowerCase());

const allUrls = [
	...changed.flatMap((c) => c.urls),
	...(includeNew ? fresh.filter((t) => !skipped(t.id)).map((t) => `/t/${t.id}.json`) : []),
];
if (urlsOnly) {
	if (allUrls.length) console.log(allUrls.join("\n"));
	appendNoteRows(noteRows);
	process.exit(0);
}

console.log(
	`local ${local.size} topics · server view ${server.size} · new ${fresh.length} · updated ${changed.length}`,
);
if (!feeds.length) {
	console.log("\nNo search or list data yet. Fetch once first:");
	console.log('  bun run src/fetch.ts "/search.json?q=招聘"');
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
	console.log(`\nfetch these:\n  bun run src/fetch.ts ${allUrls.map((u) => `"${u}"`).join(" ")}`);
	console.log(`or: bun run src/pending.ts --urls > urls.txt && bun run src/fetch.ts --file urls.txt`);
}
if (!includeNew && fresh.length)
	console.log(`(never-opened topics are not in --urls; add --include-new to fetch them too)`);

appendNoteRows(noteRows);
