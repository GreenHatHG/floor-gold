#!/usr/bin/env bun
// CLI over core/fetch-core.ts. Fetch linux.do JSON through your logged-in Chrome, save under data/raw/.
// It judges nothing. Picking what to fetch is the agent's job.
// The contract is HELP (-h / --help), not this comment.
const HELP = `fetch.ts — fetch linux.do JSON through your logged-in Chrome, save under data/raw/.

It judges nothing. Picking what to fetch is the agent's job.

Usage:
  bun run src/fetch.ts <url> [url...]
  bun run src/fetch.ts --file urls.txt
  bun run src/fetch.ts --batch 10 --rate 2/4000

Options:
  --file FILE       read one URL per line; blank lines and # comments are skipped
  --batch 20        URLs per playwright-cli call (default 20)
  --rate 2/3000     2 requests per 3000 ms (default). Only raise it with proof.
  --conc 2          requests in flight at once (default 2)
  --session chrome  playwright-cli session name (default chrome)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

The same URL always lands in the same file under data/raw/ (mapping in README "Disk layout").
Topic files are merged, never replaced, and every write is atomic; the one exception is a
corrupt old file, which is overwritten after a warning.

Exit codes: 0 all saved · 1 some failed, see data/todo.txt · 2 bad arguments

429/403 is Cloudflare, not a rate limit. Wait a few minutes, rerun the same command.
`;

import fs from "node:fs";
import { fetchAll } from "./core/fetch-core";
import { numOf, optOf, parseOrExit, showHelp, showUsage } from "./lib/cli";
import { FatalError } from "./lib/fatal";

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) showHelp(HELP);
const { opts, args } = parseOrExit(
	rawArgs,
	{ file: "value", batch: "value", conc: "value", rate: "value", session: "value" },
	"fetch.ts",
);

// ---- main: collect urls from args and --file, then fetch ----
let urls: string[] = args.slice();
const fileArg = optOf(opts, "file", "");
if (fileArg) {
	if (!fs.existsSync(fileArg)) {
		console.error(`--file ${fileArg}: no such file`);
		process.exit(2);
	}
	urls = urls.concat(
		fs
			.readFileSync(fileArg, "utf8")
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s && !s.startsWith("#")),
	);
}
if (!urls.length) showUsage(HELP, "fetch.ts");

const rate = String(optOf(opts, "rate", "2/3000")).split("/");
const rateN = Number(rate[0]); // 2  → how many requests
const rateWindow = Number(rate[1]); // 3000 → per how many ms
if (!Number.isFinite(rateN) || rateN < 1 || !Number.isFinite(rateWindow) || rateWindow < 1) {
	console.error(`--rate must look like 2/3000, got: ${optOf(opts, "rate", "")}`);
	process.exit(2);
}

try {
	const report = await fetchAll(urls, {
		session: optOf(opts, "session", "chrome"),
		batch: numOf(opts, "batch", 20, 1),
		conc: numOf(opts, "conc", 2, 1),
		rateN,
		rateWindow,
	});
	for (const line of report.log) console.log(line);
	console.log(`\n${report.ok} ok, ${report.failed} failed, ${report.total} urls, ${report.seconds}s -> data/raw/`);
	if (report.todo.length)
		console.log(
			`${report.todo.length} failed to fetch, written to data/todo.txt (next: bun run src/fetch.ts --file data/todo.txt)`,
		);
	if (report.failed) process.exit(1);
} catch (e) {
	if (e instanceof FatalError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
}
