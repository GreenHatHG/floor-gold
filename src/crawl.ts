#!/usr/bin/env bun
// One entry point for the AI. Reads terms from data/terms.txt, loops search->fetch until
// nothing is left to fetch. Imports the cores directly — no subprocesses, typed end to end.
const HELP = `crawl.ts — the only commands the AI needs. Everything else is plumbing.

Usage:
  bun run src/crawl.ts bootstrap    full history, all terms in data/terms.txt, loop until drained
  bun run src/crawl.ts daily        from the watermark month to now, loop until drained,
                                    auto-advance the watermark only when 0 urls failed

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
import { parseArgs, UsageError } from "./lib/args";
import { FatalError } from "./lib/fatal";
import { STATE, TERMS, URLS_FILE } from "./lib/paths";

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
		throw new UsageError("usage: bun run src/crawl.ts bootstrap | daily");
	}
	cmd = args[0];
} catch (e) {
	if (!(e instanceof UsageError)) throw e;
	console.error(e.message);
	console.error("More: bun run src/crawl.ts -h");
	process.exit(2);
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
const plan = async (mode: "full" | "new"): Promise<{ empty: boolean; urls: string[]; failed: boolean }> => {
	try {
		const r = search(terms, mode === "new" ? { mode: "new" } : { mode: "full" });
		fs.writeFileSync(URLS_FILE, r.urls.join("\n") + (r.urls.length ? "\n" : ""));
		if (!r.urls.length) return { empty: true, urls: [], failed: false };
		console.error(`[crawl] ${r.stats.queued} urls queued, ${r.stats.cached} pages cached`);
		const report = await fetchAll(r.urls, { session: "chrome", batch: 20, conc: 2, rateN: 2, rateWindow: 3000 });
		for (const line of report.log) console.log(line);
		console.log(`\n${report.ok} ok, ${report.failed} failed, ${report.total} urls, ${report.seconds}s -> data/raw/`);
		if (report.todo.length) console.log(`${report.todo.length} failed to fetch, written to data/todo.txt`);
		return { empty: false, urls: r.urls, failed: report.failed > 0 };
	} catch (e) {
		if (e instanceof FatalError) {
			console.error(`\n[crawl] ${e.message}`);
			process.exit(1);
		}
		throw e;
	}
};

const advanceWatermark = (): void => {
	const today = new Date().toISOString().slice(0, 10);
	fs.mkdirSync(path.dirname(STATE), { recursive: true });
	fs.writeFileSync(`${STATE}.tmp`, JSON.stringify({ last_new: today }));
	fs.renameSync(`${STATE}.tmp`, STATE);
	console.error(`[crawl] watermark advanced to ${today} (only after a round with 0 failures).`);
	console.error("Next: bun run src/pending.ts --top 20");
};

// search always re-queues the live month's page 1 (the month grows), so the queue never
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
	advanceWatermark();
} else {
	console.error(`Next: bun run src/crawl.ts daily`);
}
