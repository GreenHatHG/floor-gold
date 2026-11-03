#!/usr/bin/env bun
// CLI over core/search-core.ts. Prints one URL per line on stdout, stats on stderr. Sends nothing.
// The contract is HELP (-h / --help), not this comment.
const HELP = `search.ts — work out which month windows are missing, print one URL per line.

Usage:
  bun run src/search.ts 招聘 招人                     full history 2023-01 to now, month by month
  bun run src/search.ts 招聘 --since 2025-06-01
  bun run src/search.ts 招聘 --since 2025-06-01 --until 2025-08-31
  bun run src/search.ts 招聘 --new                    from the watermark month to now
  bun run src/search.ts 招聘 > urls.txt && bun run src/fetch.ts --file urls.txt

Arguments:
  term...        one or more keywords, one window per month. Quote a term with a space.
                 Weak keyword? add a category word: bun run src/search.ts "内推 #非我莫属"

Options:
  --new          from the month of the watermark in data/search-state.json
                 (no file yet: last month) up to the current month
  --since DATE   start month, snapped down to its 1st (default 2023-01-01)
  --until DATE   end month, snapped up into its month (default: today)
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Windows are whole UTC months on a fixed grid anchored at 2023-01-01. The same month always
lands in the same file name, so finished months are cached forever and --since / --until /
--new only pick grid months, they never shift keys. A stale --new watermark costs nothing:
months between the watermark and now are already cached. The current (unfinished) month is
the one exception: it is re-fetched and overwritten on every run, because a live month grows.

Prints: one URL per line on stdout, oldest month first. On stderr: stats, a per-term
per-month relevance table (weighted hit score across posts, -- means that month is not cached yet), and with
--new the one-line watermark update to run after fetch.ts succeeds. Sends no request.

Paging: page=1 is the first page, same as no page, so paging starts at 2 and nothing is
fetched twice; a month that would need page 41 is too big for one window — the program exits 1
and that month must be split by hand (--since/--until halves).

Exit codes: 0 ok · 1 a month needs page 41 · 2 no keyword, a bad date, or conflicting options
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
		`${terms.length} terms · ${r.stats.windows} month windows · ${r.stats.cached} pages cached · ${r.stats.queued} requests queued`,
	);
	for (const term of terms) {
		const months = r.relevance[term];
		const any = months.find((s) => s && s.total > 0);
		if (!any) {
			console.error(`frequency ${term}: no cache yet, rerun after fetching to get the table`);
			continue;
		}
		console.error(`frequency ${term} (title×2 + blurb×1, weighted by post count):`);
		for (let i = 0; i < months.length; i++) {
			const s = months[i];
			const label = r.relevanceFrom === undefined ? "" : monthLabel(r.startIdx + i);
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

function monthLabel(i: number): string {
	return new Date(Date.UTC(2023, i, 1)).toISOString().slice(0, 7);
}
