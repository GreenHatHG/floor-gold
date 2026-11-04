#!/usr/bin/env bun
// CLI over core/search-core.ts. Prints one URL per line on stdout, stats on stderr. Sends nothing.
// The contract is HELP (-h / --help), not this comment.
const HELP = `search.ts — work out which week windows are missing, print one URL per line.

Usage:
  bun run src/search.ts 招聘 招人                     full history 2023-01-01 to now, week by week
  bun run src/search.ts 招聘 --since 2025-06-01
  bun run src/search.ts 招聘 --since 2025-06-01 --until 2025-08-31
  bun run src/search.ts 招聘 --new                    from the watermark week to now
  bun run src/search.ts 招聘 > urls.txt && bun run src/fetch.ts --file urls.txt

Arguments:
  term...        one or more keywords, one window per week. Quote a term with a space.
                 Weak keyword? add a category word: bun run src/search.ts "内推 #非我莫属"

Options:
  --new          from the week of the watermark in data/search-state.json
                 (no file yet: last week) up to the current week
  --since DATE   start week, snapped down to the grid (default 2023-01-01)
  --until DATE   end week (default: today)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Windows are 7 whole UTC days on a fixed grid anchored at 2023-01-01. The same week always
lands in the same file name, so finished weeks are cached forever and --since / --until /
--new only pick grid weeks, they never shift keys. A stale --new watermark costs nothing:
weeks between the watermark and now are already cached. The current (unfinished) week is
the one exception: it is re-fetched and overwritten on every run, because a live week grows.

Weekly, not monthly: the server rejects search page > 10, so a hot month (内推, Oct 2026:
500+ hits) overflows one monthly window and loses everything past page 10. A week holds
far fewer hits, so every window stays reachable.

Prints: one URL per line on stdout, oldest week first. On stderr: stats, a per-term
per-window relevance table (weighted hit score across posts, -- means that week is not
cached yet), and with --new the one-line watermark update to run after fetch.ts succeeds.
Sends no request.

Paging: page=1 is the first page, same as no page, so paging starts at 2 and nothing is
fetched twice; a window that would need page 11 is drained by force (the server cannot
serve it).

Exit codes: 0 ok · 1 bad --since/--until date or empty range · 2 no keyword or conflicting options
`;

import { search } from "./core/search-core";
import { parseOrExit, showHelp, showUsage } from "./lib/cli";
import { FatalError } from "./lib/fatal";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) showHelp(HELP);
const { opts, args: terms } = parseOrExit(argv, { new: "flag", since: "value", until: "value" }, "search.ts");

if (!terms.length) showUsage(HELP, "search.ts");
if (opts.new && (opts.since !== undefined || opts.until !== undefined)) {
	console.error("use --new, or --since/--until, not both");
	process.exit(2);
}

// ---- main ----
try {
	const r = search(terms, {
		mode: opts.new ? "new" : "full",
		since: typeof opts.since === "string" ? opts.since : undefined,
		until: typeof opts.until === "string" ? opts.until : undefined,
	});

	console.error(
		`${terms.length} terms · ${r.stats.windows} week windows · ${r.stats.cached} pages cached · ${r.stats.queued} requests queued`,
	);
	for (const w of r.stats.saturated) {
		console.error(
			`WARNING ${w}: 10 full pages, more hits exist but the server refuses page > 10 — they are invisible to search. Narrow the term (add a #category) or split the window with --since/--until.`,
		);
	}
	for (const term of terms) {
		const windows = r.relevance[term];
		const any = windows.find((s) => s && s.total > 0);
		if (!any) {
			console.error(`frequency ${term}: no cache yet, rerun after fetching to get the table`);
			continue;
		}
		console.error(`frequency ${term} (title×2 + blurb×1, weighted by post count):`);
		for (let i = 0; i < windows.length; i++) {
			const s = windows[i];
			const label = r.relevanceFrom === undefined ? "" : windowLabel(r.startIdx + i);
			if (!s || !s.total) {
				console.error(`  ${label}  --        data not fetched`);
				continue;
			}
			const pct = Math.round((s.hit / s.total) * 100);
			console.error(`  ${label}  ${String(s.hit).padStart(6)}/${String(s.total).padEnd(6)} ${pct}%`);
		}
	}
	if (opts.new) {
		console.error("update the watermark after a successful fetch (copy-paste to run):");
		console.error(`  echo '{"last_new":"${r.now.toISOString().slice(0, 10)}"}' > data/search-state.json`);
	}
	console.error(`write: bun run src/search.ts ... > urls.txt && bun run src/fetch.ts --file urls.txt`);
	console.log(r.urls.join("\n"));
} catch (e) {
	if (e instanceof FatalError) {
		console.error(`\n[stop] ${e.message}`);
		process.exit(1);
	}
	throw e;
}

function windowLabel(i: number): string {
	return new Date(Date.UTC(2023, 0, 1) + i * 7 * 86400000).toISOString().slice(0, 10);
}
