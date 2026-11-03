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
import type { Opts } from "./lib/args";
import { parseArgs, UsageError } from "./lib/args";
import { FatalError } from "./lib/fatal";

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
let opts: Opts = {};
let args: string[] = [];
try {
	({ opts, args } = parseArgs(rawArgs, {
		file: "value",
		batch: "value",
		conc: "value",
		rate: "value",
		session: "value",
	}));
} catch (e) {
	if (!(e instanceof UsageError)) throw e;
	console.error(e.message);
	console.error("Usage: bun run src/fetch.ts -h");
	process.exit(2);
}
const opt = (name: string, dflt: string): string => {
	const v = opts[name];
	return typeof v === "string" ? v : dflt;
};
const num = (name: string, dflt: number, min: number): number => {
	const raw = opt(name, String(dflt));
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min) {
		console.error(`--${name} must be a number >= ${min}, got: ${raw}`);
		process.exit(2);
	}
	return n;
};

let urls: string[] = args.slice();
const fileArg = opt("file", "");
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
if (!urls.length) {
	console.error(HELP);
	console.error("More: bun run src/fetch.ts --help");
	process.exit(2);
}

const rate = String(opt("rate", "2/3000")).split("/");
const rateN = Number(rate[0]); // 2  → how many requests
const rateWindow = Number(rate[1]); // 3000 → per how many ms
if (!Number.isFinite(rateN) || rateN < 1 || !Number.isFinite(rateWindow) || rateWindow < 1) {
	console.error(`--rate must look like 2/3000, got: ${opt("rate", "")}`);
	process.exit(2);
}

try {
	const report = await fetchAll(urls, {
		session: opt("session", "chrome"),
		batch: num("batch", 20, 1),
		conc: num("conc", 2, 1),
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
