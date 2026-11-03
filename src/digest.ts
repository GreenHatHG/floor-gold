#!/usr/bin/env bun
// Turn one raw topic file into a short readable digest. Never fetches.
// The contract is HELP (-h / --help), not this comment.
const HELP = `digest.ts — turn one local topic file into a short text digest. Never fetches.

One topic file is 50 to 200 KB of JSON. This prints a few hundred chars per post instead, so
the chat never has to swallow the whole thing.

Usage:
  bun run src/digest.ts <topic_id|path.json>
  bun run src/digest.ts 2881282 --new
  bun run src/digest.ts 2881282 --from 40 --chars 600
  bun run src/digest.ts 2881282 --full 43    the full text of post 43 only

Options:
  --new        only posts after your read_upto cursor in data/index.jsonl
  --from N     start at post number N (default 0)
  --chars 200  chars per post, min 20 (default 200)
  --full N     print the whole text of post N and stop
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Output: one line per post, #number user date text. The header shows title, post count, the
highest post number when it differs from the count (a delete makes them differ), missing
post numbers, last reply date, how far you already read, and your last verdict from
data/index.jsonl.

No local copy means fetch first: bun run src/fetch.ts "/t/<id>.json"

Exit codes: 0 ok · 1 no local copy or no such post · 2 bad arguments
`;

import fs from "node:fs";
import path from "node:path";
import { htmlToText, md, oneLine } from "./cli/digest-text";
import { readIndex } from "./cli/index-store";
import { flagOf, numOf, optOf, parseOrExit, showHelp, showUsage } from "./lib/cli";
import { RAW } from "./lib/paths";
import type { TopicDoc } from "./lib/types";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) showHelp(HELP);
const { opts, args } = parseOrExit(argv, { new: "flag", from: "value", chars: "value", full: "value" }, "digest.ts");

// ---- main ----
const target = args[0];
if (!target) showUsage(HELP, "digest.ts");

const file = target.endsWith(".json") ? target : path.join(RAW, "topic", `${target.replace(/\D/g, "")}.json`);
if (!fs.existsSync(file)) {
	console.error(
		`no local copy of that topic. fetch it first:\n  bun run src/fetch.ts "/t/${target.replace(/\D/g, "")}.json"`,
	);
	process.exit(1);
}
const topic = JSON.parse(fs.readFileSync(file, "utf8")) as TopicDoc;
const posts = (topic.post_stream?.posts || []).slice().sort((a, b) => a.post_number - b.post_number);
if (!posts.length) {
	console.error("that file has no posts in it.");
	process.exit(1);
}

// full text of a single post
const fullN = optOf(opts, "full");
if (fullN) {
	const p = posts.find((x) => x.post_number === Number(fullN));
	if (!p) {
		console.error(`post #${fullN} is not in the local copy. have: ${posts.map((x) => x.post_number).join(",")}`);
		process.exit(1);
	}
	console.log(`#${p.post_number} ${p.username} ${md(p.created_at)}  (id ${p.id})`);
	console.log("-".repeat(60));
	console.log(htmlToText(p.cooked));
	process.exit(0);
}

// header
const idx = readIndex();
const rec = idx.get(Number(topic.id)) || {};
const readUpto = Number(rec.read_upto || 0);
const chars = numOf(opts, "chars", 200, 20);

const highest = topic.highest_post_number || posts[posts.length - 1].post_number;
const haveNums = posts.map((p) => p.post_number);
const missing: number[] = [];
for (let n = 1; n <= highest; n++) if (!haveNums.includes(n)) missing.push(n);
const gaps: [number, number][] = [];
for (const n of missing) {
	const last = gaps[gaps.length - 1];
	if (last && n === last[1] + 1) last[1] = n;
	else gaps.push([n, n]);
}
const gapText = gaps.length ? gaps.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",") : "none";

console.log(`[${topic.id}] ${topic.title}`);
const bits: string[] = [`${topic.posts_count} posts`];
if (highest !== topic.posts_count) bits.push(`highest #${highest}`);
if (topic.category_id) bits.push(`category ${topic.category_id}`);
if (topic.closed) bits.push("closed");
if (topic.tags?.length) bits.push(`tags:${topic.tags.map((t) => t.name).join("/")}`);
console.log(bits.join(" · "));
console.log(
	`local ${posts.length} posts · missing ${gapText} · last reply ${md(topic.last_posted_at)}` +
		(readUpto ? ` · read up to #${readUpto}` : ""),
);
if (rec.verdict || rec.note) console.log(`last verdict: ${rec.verdict || "-"} ${rec.note || ""}`.trim());
console.log("-".repeat(60));

// posts
const fromN = numOf(opts, "from", 0, 0);
const shown = posts
	.filter((p) => (flagOf(opts, "new") ? p.post_number > readUpto : true))
	.filter((p) => p.post_number >= fromN);
if (!shown.length) {
	console.log(flagOf(opts, "new") ? "(no new posts)" : "(no posts match)");
	process.exit(0);
}
for (const p of shown) {
	const text = oneLine(htmlToText(p.cooked));
	const body = text.length > chars ? `${text.slice(0, chars)}…` : text;
	const mark = p.post_number > readUpto && readUpto ? " " : "";
	console.log(`#${p.post_number}${mark} ${p.username} ${md(p.created_at)}  ${body || "(empty)"}`);
}
if (shown.length < posts.length) console.log(`\n(showing ${shown.length}/${posts.length} posts)`);
