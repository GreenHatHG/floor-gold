#!/usr/bin/env bun
// Pull every floor of one topic the local copy is missing. The contract is HELP (-h / --help).
const HELP = `catchup.ts — fetch the floors your local copy of one topic is missing, loop until drained.

A first /t/<id>.json only returns ~20 posts. This asks the server for the post id table at
the last floor you hold, then the missing posts in chunks of 50, and repeats until the local
copy covers every floor the server says exist. Topic files are merged, so nothing is fetched
twice — rerun the same command after a failure.

Usage:
  bun run src/catchup.ts <topic_id>

Options: none. A bare -- ends options. Unknown options are errors.

It never writes verdicts or read cursors — recording what you read is mark.ts's job.

Exit codes: 0 drained (or the remaining holes are all deleted posts) ·
1 a fetch failed (Cloudflare?) — rerun the same command · 2 bad arguments
`;

import { catchupTopic } from "./cli/catchup";
import { FatalError } from "./lib/fatal";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
if (argv.length !== 1 || argv[0] === "--") {
	console.error("usage: bun run src/catchup.ts <topic_id>");
	process.exit(2);
}
const id = Number(argv[0].replace(/\D/g, ""));
if (!id) {
	console.error(`not a topic id: ${argv[0]}`);
	process.exit(2);
}

try {
	const r = await catchupTopic(id, {
		session: "chrome",
		batch: 20,
		conc: 1,
		rateN: 2,
		rateWindow: 10000,
		onProgress: (line) => console.error(line),
	});
	console.log(`topic ${r.id}: ${r.fetched} post(s) fetched in ${r.rounds} round(s) · have ${r.have}/${r.highest}`);
	if (r.holes.length) {
		const txt = r.holes.map(([a, b]) => (a === b ? `#${a}` : `#${a}-#${b}`)).join(", ");
		console.log(`still missing ${txt} — those floors were deleted on the server; nothing to fetch.`);
	}
	console.log(`next: bun run src/digest.ts ${r.id} --chars=200`);
} catch (e) {
	if (e instanceof FatalError || e instanceof Error) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
}
