#!/usr/bin/env bun
// One entry point for the AI. Reads terms from data/terms.txt, loops search->fetch until
// nothing is left to fetch. Imports the cores directly — no subprocesses, typed end to end.
const HELP = `crawl.ts — the only commands the AI needs. Everything else is plumbing.

Usage:
  bun run src/crawl.ts bootstrap    full history, all terms in data/terms.txt, loop until drained
  bun run src/crawl.ts daily        from the watermark week to now, loop until drained,
                                    auto-advance the watermark only when 0 urls failed
  ... --wait-for-done              any command + prints "crawl-done <exit>" to stdout right
                                    before exiting, so a watcher can block until completion

Rules for the AI:
  - First ever run, or months behind: bootstrap. Otherwise: daily.
  - Non-zero exit: read the message, wait if told to, then run the SAME command again.
    Cache makes reruns cheap; nothing is fetched twice.
  - No keywords, no flags, no urls.txt. Terms live in data/terms.txt, one per line,
    "#" comments allowed. If the file is missing, this exits 2 and says so.
  - After a green daily run, judge with: bun run src/pending.ts --top 20

Exit codes: 0 drained (and watermark advanced on daily) · 1 Cloudflare blocked or
fetch failed — rerun later · 2 missing terms file or bad usage
`;

import fs from "node:fs";
import path from "node:path";
import { fetchAll } from "./core/fetch-core";
import { readTerms, search } from "./core/search-core";
import { parseOrExit, showHelp } from "./lib/cli";
import { FatalError } from "./lib/fatal";
import { STATE, TERMS, URLS_FILE } from "./lib/paths";

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) showHelp(HELP);
let cmd = "";
let waitForDone = false;
{
	const { opts, args } = parseOrExit(argv, { "wait-for-done": "flag" }, "crawl.ts");
	waitForDone = !!opts["wait-for-done"];
	if (opts.since !== undefined || opts.until !== undefined || opts.file || opts.new) {
		console.error("crawl.ts takes no options except --wait-for-done. Terms live in data/terms.txt.");
		process.exit(2);
	}
	if (args.length !== 1 || !"bootstrap daily".split(" ").includes(args[0])) {
		console.error("usage: bun run src/crawl.ts bootstrap | daily");
		process.exit(2);
	}
	cmd = args[0];
}

if (!fs.existsSync(TERMS)) {
	console.error(
		`Missing ${path.relative(process.cwd(), TERMS)}. One term per line, lines starting with # are comments. Create it and rerun.`,
	);
	process.exit(2);
}
const terms = readTerms(TERMS);
if (!terms.length) {
	console.error(`${path.relative(process.cwd(), TERMS)} is empty, nothing to crawl.`);
	process.exit(2);
}
console.error(`terms: ${terms.join(" ")}`);

// search returns the URL list as data now; keep writing urls.txt so fetch.ts stays usable
// standalone and the queue is inspectable between rounds.
const plan = async (
	mode: "full" | "new",
): Promise<{ empty: boolean; urls: string[]; failed: boolean; saturated: string[] }> => {
	try {
		const r = search(terms, mode === "new" ? { mode: "new" } : { mode: "full" });
		fs.writeFileSync(URLS_FILE, r.urls.join("\n") + (r.urls.length ? "\n" : ""));
		if (!r.urls.length) return { empty: true, urls: [], failed: false, saturated: r.stats.saturated };
		console.error(`[crawl] ${r.stats.queued} urls queued, ${r.stats.cached} pages cached`);
		// slowed 2026-11: 2/3000 tripped Cloudflare 429 repeatedly; slow is fine, blocks are not
		const report = await fetchAll(r.urls, {
			session: "chrome",
			batch: 20,
			conc: 1,
			rateN: 2,
			rateWindow: 10000,
			onProgress: (line) => console.error(line),
		});
		console.log(`\n${report.ok} ok, ${report.failed} failed, ${report.total} urls, ${report.seconds}s -> data/raw/`);
		if (report.todo.length) console.log(`${report.todo.length} failed to fetch, written to data/todo.txt`);
		return { empty: false, urls: r.urls, failed: report.failed > 0, saturated: r.stats.saturated };
	} catch (e) {
		if (e instanceof FatalError) {
			console.error(`\n[crawl] ${e.message}`);
			waitMarker(1);
			process.exit(1);
		}
		throw e;
	}
};

// --wait-for-done: without it the agent polls with sleep loops, burning tokens every wake-up.
// One machine-readable line on stdout lets a watcher block until the very end. Every exit path
// calls this, so the marker also covers failure exits (exit 1), not just the drained exit 0.
const waitMarker = (code: number): void => {
	if (!waitForDone) return;
	console.log(`crawl-done ${code}`);
};

const advanceWatermark = (): void => {
	const today = new Date().toISOString().slice(0, 10);
	fs.mkdirSync(path.dirname(STATE), { recursive: true });
	fs.writeFileSync(`${STATE}.tmp`, JSON.stringify({ last_new: today }));
	fs.renameSync(`${STATE}.tmp`, STATE);
	console.error(`[crawl] watermark advanced to ${today} (only after a round with 0 failures).`);
	console.error("Next: bun run src/pending.ts --top 20");
};

// search always re-queues the live window's page 1 (the window grows), so the queue never
// reads as 0. Steady state instead: same URL set as the previous round means only that
// unavoidable re-fetch is left — stop.
let prev: string | null = null;
let rounds = 0;
for (;;) {
	rounds++;
	console.error(`\n=== crawl ${cmd} round ${rounds} ===`);
	const r = await plan(cmd === "bootstrap" ? "full" : "new");
	if (r.failed) {
		console.error(
			"\n[crawl] fetch did not fully succeed (likely Cloudflare). Wait a few minutes, then rerun the same command.",
		);
		waitMarker(1);
		process.exit(1);
	}
	if (r.saturated.length) {
		console.error(
			`\n[crawl] WARNING: ${r.saturated.length} window(s) filled all 10 search pages — hits past 500 per window are invisible:\n\t${r.saturated.join("\n\t")}\nNarrow the term in data/terms.txt (e.g. add a #category word).`,
		);
	}
	const same = r.urls.length > 0 && r.urls.join("\n") === prev;
	prev = r.urls.join("\n");
	if (r.empty || same) {
		console.error(`\n[crawl] all done in ${rounds} round(s).`);
		break;
	}
	if (rounds >= 60) {
		console.error("\n[crawl] still not drained after 60 rounds — abnormal, stop and investigate manually.");
		waitMarker(1);
		process.exit(1);
	}
}

if (cmd === "daily") {
	advanceWatermark();
	waitMarker(0);
} else {
	console.error(`Next: bun run src/crawl.ts daily`);
	waitMarker(0);
}
