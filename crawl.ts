#!/usr/bin/env node
// One entry point for the AI. Reads terms from data/terms.txt, loops search->fetch until
// nothing is left to fetch. search.ts / fetch.ts stay untouched underneath.
const HELP = `crawl.ts — the only commands the AI needs. Everything else is plumbing.

Usage:
  bun run crawl.ts bootstrap    full history, all terms in data/terms.txt, loop until drained
  bun run crawl.ts daily        from the watermark month to now, loop until drained,
                                auto-advance the watermark only when 0 urls failed

Rules for the AI:
  - First ever run, or months behind: bootstrap. Otherwise: daily.
  - Non-zero exit: read the message, wait if told to, then run the SAME command again.
    Cache makes reruns cheap; nothing is fetched twice.
  - No keywords, no flags, no urls.txt. Terms live in data/terms.txt, one per line,
    "#" comments allowed. If the file is missing, this exits 2 and says so.
  - After a green daily run, judge with: bun run pending.ts --top 20

Exit codes: 0 drained (and watermark advanced on daily) · 1 Cloudflare blocked or
fetch failed — rerun later · 2 missing terms file or bad usage
`;

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, UsageError } from "./lib";

const ROOT = __dirname;
const STATE = path.join(ROOT, "data", "search-state.json");
const TERMS = path.join(ROOT, "data", "terms.txt");

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
	console.log(HELP);
	process.exit(0);
}
let cmd = "";
try {
	const { opts, args } = parseArgs(argv, {});
	if (opts.new || opts.since !== undefined || opts.until !== undefined || opts.file) {
		throw new UsageError("crawl.ts takes no options. Terms live in data/terms.txt.");
	}
	if (args.length !== 1 || !["bootstrap", "daily"].includes(args[0])) {
		throw new UsageError("usage: bun run crawl.ts bootstrap | daily");
	}
	cmd = args[0];
} catch (e) {
	if (!(e instanceof UsageError)) throw e;
	console.error(e.message);
	console.error("More: bun run crawl.ts -h");
	process.exit(2);
}

if (!fs.existsSync(TERMS)) {
	console.error(
		`Missing ${path.relative(ROOT, TERMS)}. One term per line, lines starting with # are comments. Create it and rerun.`,
	);
	process.exit(2);
}
const terms = fs
	.readFileSync(TERMS, "utf8")
	.split("\n")
	.map((s) => s.trim())
	.filter((s) => s && !s.startsWith("#"));
if (!terms.length) {
	console.error(`${path.relative(ROOT, TERMS)} is empty, nothing to crawl.`);
	process.exit(2);
}
console.error(`terms: ${terms.join(" ")}`);

const run = (script: string, args: string[]): number =>
	spawnSync("bun", ["run", script, ...args], { stdio: "inherit", cwd: ROOT }).status ?? 1;

// search.ts prints one URL per line on stdout, stats on stderr; keep stderr visible,
// capture stdout into the urls file for fetch.ts --file.
const plan = (mode: "full" | "new", urlsFile: string): { empty: boolean; urls: string[]; failed: boolean } => {
	const args = [...terms, ...(mode === "new" ? ["--new"] : ["--since", "2023-01-01"])];
	const r = spawnSync("bun", ["run", "search.ts", ...args], {
		stdio: ["ignore", "pipe", "inherit"],
		cwd: ROOT,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (r.status !== 0) return { empty: false, urls: [], failed: true };
	const urls = String(r.stdout || "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	fs.writeFileSync(urlsFile, urls.join("\n") + (urls.length ? "\n" : ""));
	if (!urls.length) return { empty: true, urls: [], failed: false };
	const fetched = run("fetch.ts", ["--file", urlsFile]);
	return { empty: false, urls, failed: fetched !== 0 };
};

const urlsFile = path.join(ROOT, "data", "urls.txt");
// search.ts always re-queues the live month's page 1 (the month grows), so the queue never
// reads as 0. Steady state instead: same URL set as the previous round means only that
// unavoidable re-fetch is left — stop.
let prev: string | null = null;
let rounds = 0;
for (;;) {
	rounds++;
	console.error(`\n=== crawl ${cmd} round ${rounds} ===`);
	const r = plan(cmd === "bootstrap" ? "full" : "new", urlsFile);
	if (r.failed) {
		console.error(
			"\n[crawl] fetch did not fully succeed (likely Cloudflare). Wait a few minutes, then rerun the same command.",
		);
		process.exit(1);
	}
	const same = r.urls.length > 0 && r.urls.join("\n") === prev;
	prev = r.urls.join("\n");
	if (r.empty || same) {
		console.error(`\n[crawl] all done in ${rounds} round(s).`);
		break;
	}
	if (rounds >= 60) {
		console.error("\n[crawl] still not drained after 60 rounds — abnormal, stop and investigate manually.");
		process.exit(1);
	}
}

if (cmd === "daily") {
	const today = new Date().toISOString().slice(0, 10);
	fs.mkdirSync(path.dirname(STATE), { recursive: true });
	fs.writeFileSync(`${STATE}.tmp`, JSON.stringify({ last_new: today }));
	fs.renameSync(`${STATE}.tmp`, STATE);
	console.error(`[crawl] watermark advanced to ${today} (only after a round with 0 failures).`);
	console.error("Next: bun run pending.ts --top 20");
} else {
	console.error(`Next: bun run crawl.ts daily`);
}
