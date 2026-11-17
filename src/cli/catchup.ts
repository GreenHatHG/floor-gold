// Drain one topic: loop post_ids -> /t/<id>/posts.json?post_ids[]=... until we hold every
// post the server says exists. Pure logic; catchup.ts prints and exits.

import path from "node:path";
import type { FetchOptions } from "../core/fetch-core";
import { fetchAll } from "../core/fetch-core";
import { RAW } from "../lib/paths";
import type { TopicDoc } from "../lib/types";
import { readJson } from "./topic-state";

const IDS_CHUNK = 50;

const highestOf = (doc: TopicDoc | null): number => Math.max(doc?.highest_post_number || 0, doc?.posts_count || 0);

const haveNums = (doc: TopicDoc | null): number[] =>
	(doc?.post_stream?.posts || []).map((p) => p.post_number).sort((a, b) => a - b);

// Every run of the same hole shape must end, so a round that fetches nothing and leaves the
// same holes stops the loop instead of spinning against a lying server.
const holesOf = (doc: TopicDoc | null): [number, number][] => {
	const have = new Set(haveNums(doc));
	const holes: [number, number][] = [];
	for (let n = 1; n <= highestOf(doc); n++) {
		if (have.has(n)) continue;
		const last = holes[holes.length - 1];
		if (last && n === last[1] + 1) last[1] = n;
		else holes.push([n, n]);
	}
	return holes;
};

// The ids file at anchor A answers floors > A at fetch time; a changed server highest means
// the same question now has a different answer. (naming: ids/<id>-at-<anchor>.json)
const idsPath = (id: number, anchor: number): string => path.join(RAW, "ids", `${id}-at-${anchor}.json`);

export interface CatchupReport {
	id: number;
	rounds: number;
	fetched: number;
	holes: [number, number][];
	highest: number;
	have: number;
}

export async function catchupTopic(id: number, o: FetchOptions): Promise<CatchupReport> {
	const file = path.join(RAW, "topic", `${id}.json`);
	const load = (): TopicDoc | null => readJson<TopicDoc>(file);
	if (!load()) {
		throw new Error(`no local copy of topic ${id}. fetch it first: bun run src/fetch.ts "/t/${id}.json"`);
	}

	let rounds = 0;
	let fetched = 0;
	let prevHoles: string = "start";
	for (;;) {
		const doc = load();
		const holes = holesOf(doc);
		if (!holes.length || prevHoles === JSON.stringify(holes))
			return { id, rounds, fetched, holes, highest: highestOf(doc), have: haveNums(doc).length };
		prevHoles = JSON.stringify(holes);
		rounds++;

		// one hole per round: the ids table at its left edge answers exactly that hole.
		// Always re-ask: the table is only valid at the server height it was taken at.
		const anchor = holes[0][0] - 1;
		const rep = await fetchAll([`/t/${id}/post_ids.json?post_number=${anchor}`], o);
		if (rep.failed) throw new Error(`post id table failed (${rep.failed} url); rerun the same command`);
		const ids = readJson<{ post_ids?: number[] }>(idsPath(id, anchor));
		if (!ids?.post_ids?.length) continue; // every floor after the anchor was deleted

		const want = new Set(ids.post_ids.map(String));
		const haveIds = new Set((load()?.post_stream?.posts || []).map((p) => String(p.id)));
		const missing = [...want].filter((x) => !haveIds.has(x));
		if (!missing.length) continue;
		const urls: string[] = [];
		for (let i = 0; i < missing.length; i += IDS_CHUNK) {
			urls.push(
				`/t/${id}/posts.json?${missing
					.slice(i, i + IDS_CHUNK)
					.map((x) => `post_ids[]=${x}`)
					.join("&")}`,
			);
		}
		const posts = await fetchAll(urls, o);
		fetched += posts.ok;
		if (posts.failed) throw new Error(`${posts.failed} post fetch(es) failed; rerun the same command`);
	}
}
