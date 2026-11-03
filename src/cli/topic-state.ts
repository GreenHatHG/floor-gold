// Scans data/raw/ for what we hold locally and what the fetched feeds say the server has,
// then works out which topics changed (gaps and tails) and which are never-opened.

import fs from "node:fs";
import path from "node:path";
import { RAW } from "../lib/paths";
import type { FeedDoc, FeedTopic, IdsDoc, NoteRow, TopicDoc } from "../lib/types";
import type { Notes } from "./index-store";

export const ls = (d: string): string[] => {
	const p = path.join(RAW, d);
	if (!fs.existsSync(p)) return [];
	return fs
		.readdirSync(p)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(p, f));
};

export const readJson = <T>(f: string): T | null => {
	try {
		return JSON.parse(fs.readFileSync(f, "utf8")) as T;
	} catch {
		return null;
	}
};

// ---- what we have locally ----
export interface LocalTopic {
	title?: string;
	nums: number[];
	max: number;
	highest: number;
}
export function scanLocal(): { local: Map<number, LocalTopic>; knownIds: Set<string> } {
	const local = new Map<number, LocalTopic>();
	const knownIds = new Set<string>();
	for (const f of ls("topic")) {
		const t = readJson<TopicDoc>(f);
		if (!t || t.id == null) continue;
		const posts = t.post_stream?.posts || [];
		const nums = posts.map((p) => p.post_number).sort((a, b) => a - b);
		for (const p of posts) knownIds.add(`${t.id}:${p.id}`);
		local.set(Number(t.id), {
			title: t.title,
			nums,
			max: nums.length ? nums[nums.length - 1] : 0,
			highest: t.highest_post_number || 0,
		});
	}
	return { local, knownIds };
}

// ---- what the server said, from any list or search we already fetched ----
export interface ServerTopic {
	title?: string;
	highest: number;
	last: string | null;
	category_id?: number;
}
export function scanServer(): { server: Map<number, ServerTopic>; feeds: string[] } {
	const server = new Map<number, ServerTopic>();
	const feeds = [...ls("search"), ...ls("list"), ...ls("tag"), ...ls("site")];
	for (const f of feeds) {
		const doc = readJson<FeedDoc>(f);
		const topics: FeedTopic[] = doc?.topics || doc?.topic_list?.topics || [];
		for (const t of topics) {
			if (!t || t.id == null) continue;
			const prev = server.get(Number(t.id)) || { highest: 0, last: null };
			server.set(Number(t.id), {
				title: t.title || prev.title,
				highest: Math.max(prev.highest || 0, t.highest_post_number || t.posts_count || 0),
				last: [prev.last, t.last_posted_at].filter(Boolean).sort().pop() || null,
				category_id: t.category_id != null ? t.category_id : prev.category_id,
			});
		}
	}
	return { server, feeds };
}

// A hole memo is permanent: once we asked for the ids above a hole and got nothing, it is a deleted post.
// A tail memo is only valid at the server height it was taken at -- otherwise a reply that landed after
// the last ask would stay invisible forever.
export interface Change {
	id: number;
	title?: string;
	localMax: number;
	serverHighest: number | null;
	from: number;
	to: number;
	kind: "gap-fill" | "new";
	urls: string[];
	waitingOn: string | null;
	last?: string | null;
}

const IDS_CHUNK = 50;

export function findChanges(
	local: Map<number, LocalTopic>,
	server: Map<number, ServerTopic>,
	knownIds: Set<string>,
	notes: Notes,
	noteRows: NoteRow[],
): Change[] {
	const changed: Change[] = [];
	for (const [id, l] of local.entries()) {
		const s = server.get(id);
		// the topic file itself remembers the highest post number at fetch time, so an unfinished topic
		// is spotted even when no feed we fetched happens to mention it
		const high = Math.max(s?.highest || 0, l.highest || 0);
		const have = new Set(l.nums);
		const serverAhead = high > l.max;

		const holes: [number, number][] = [];
		for (let n = 1; n <= l.max; n++) {
			if (have.has(n)) continue;
			const last = holes[holes.length - 1];
			if (last && n === last[1] + 1) last[1] = n;
			else holes.push([n, n]);
		}
		const openHoles = holes.filter(([a]) => a > 1 && !readJson(path.join(RAW, "ids", `${id}-at-${a - 1}.json`)));
		if (!serverAhead && !openHoles.length) continue;

		const pick = openHoles.length
			? { anchor: openHoles[0][0] - 1, range: openHoles[0], tail: false }
			: { anchor: l.max, range: [l.max + 1, high] as [number, number], tail: true };

		const urls: string[] = [];
		let waitingOn: string | null = null;
		const idsPath = path.join(RAW, "ids", `${id}-at-${pick.anchor}.json`);
		const idsDoc = readJson<IdsDoc>(idsPath);
		const tailIsFresh = !pick.tail || notes.asked.get(`${id}:${pick.anchor}`) === high;

		if (!idsDoc || !tailIsFresh) {
			// a stale ids table would answer the old question again; drop it so the next run must ask
			if (pick.tail && idsDoc) {
				try {
					fs.unlinkSync(idsPath);
				} catch {}
			}
			urls.push(`/t/${id}/post_ids.json?post_number=${pick.anchor}`);
			waitingOn = "post id table";
			if (pick.tail) noteRows.push({ t: "asked", id, anchor: pick.anchor, high });
		} else {
			const miss = (idsDoc.post_ids || [])
				.map(String)
				.filter((x) => !knownIds.has(`${id}:${x}`) && !notes.missing.has(`${id}:${x}`));
			for (let i = 0; i < miss.length; i += IDS_CHUNK) {
				const chunk = miss.slice(i, i + IDS_CHUNK);
				urls.push(`/t/${id}/posts.json?${chunk.map((x) => `post_ids[]=${x}`).join("&")}`);
			}
		}
		if (!urls.length) continue;

		changed.push({
			id,
			title: l.title,
			localMax: l.max,
			serverHighest: s ? s.highest : null,
			from: pick.range[0],
			to: pick.range[1],
			kind: openHoles.length ? "gap-fill" : "new",
			urls,
			waitingOn,
			last: s?.last,
		});
	}
	changed.sort((a, b) => String(b.last).localeCompare(String(a.last)));
	return changed;
}
