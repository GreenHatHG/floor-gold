// Which month windows are still missing? Pure logic over data/raw/ + state: computes the
// list of URLs to fetch and the per-term relevance table. Sends no request, prints nothing.
import fs from "node:fs";
import path from "node:path";
import { FatalError } from "../lib/fatal";
import { searchFile } from "../lib/naming";
import { RAW, STATE } from "../lib/paths";
import type { FeedDoc, FeedTopic } from "../lib/types";

const PAGE_CAP = 50; // API hard limit per page; a shorter page is the last page
const PAGE_MAX = 40; // a month needing page 41 is not a month problem any more
const ISO = (d: Date): string => d.toISOString().slice(0, 10);
const dateArg = (raw: string): Date | null => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (!m) return null;
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	return d.toISOString().slice(0, 10) === raw ? d : null;
};

// The grid: month 0 is 2023-01, windows are [monthStart(i), monthStart(i+1)).
// i = 20 → new Date(Date.UTC(2023, 20, 1))  →  Sun Sep 01 2024 08:00:00 GMT+0800
const monthStart = (i: number): Date => new Date(Date.UTC(2023, i, 1));

//d = 2023-01-15 UTC → (2023-2023)*12 + 0 = 0
//d = 2024-03-01 UTC → (2024-2023)*12 + 2 = 14
const monthIndexOf = (d: Date): number => (d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth();

export interface SearchOptions {
	mode: "full" | "new";
	since?: string;
	until?: string;
}

export interface SearchStats {
	windows: number;
	cached: number;
	queued: number;
}

export interface RelevanceScore {
	hit: number;
	total: number;
}

export interface SearchResult {
	urls: string[];
	stats: SearchStats;
	/** term -> one score per month in the covered range, null = month not cached */
	relevance: Record<string, (RelevanceScore | null)[]>;
	/** first month label of the relevance range, e.g. "2023-01" */
	relevanceFrom: string;
	now: Date;
	liveIdx: number;
	startIdx: number;
}

const readTopics = (q: string, page: number | null): FeedTopic[] | null => {
	const f = path.join(RAW, searchFile(q, page));
	if (!fs.existsSync(f)) return null;
	try {
		const d = JSON.parse(fs.readFileSync(f, "utf8")) as FeedDoc;
		return d?.topics || [];
	} catch {
		return null;
	}
};

// Scoring runs AFTER the queue walk, over every cached page of every month, so freshly
// fetched months count too. posts[] carries blurb and topic_id; topics[] carries title and
// posts_count — joined by topic_id. score = (title hit ×2 + blurb hit ×1) weighted by
// posts_count; total = 3 × Σ weights, so pct stays in 0–100 and 50% ≈ one of the two
// fields hits per post on average.
interface SearchPost {
	topic_id?: number;
	blurb?: string;
}
const scoreMonth = (word: string, q: string): { hit: number; total: number } | null => {
	if (!word) return null;
	let hit = 0;
	let total = 0;
	let pages = 0;
	for (let p = 1; p <= PAGE_MAX; p++) {
		let doc: (FeedDoc & { posts?: SearchPost[] }) | null = null;
		try {
			doc = JSON.parse(fs.readFileSync(path.join(RAW, searchFile(q, p === 1 ? null : p)), "utf8"));
		} catch {
			doc = null;
		}
		if (!doc || !Array.isArray(doc.posts)) break;
		const topics = new Map<number, FeedTopic>();
		for (const t of doc.topics ?? []) topics.set(t.id, t);
		for (const post of doc.posts) {
			const t = post.topic_id === undefined ? undefined : topics.get(post.topic_id);
			const w = Math.max(1, t?.posts_count ?? 1);
			const s =
				(typeof t?.title === "string" && t.title.includes(word) ? 2 : 0) +
				(typeof post.blurb === "string" && post.blurb.includes(word) ? 1 : 0);
			hit += s * w;
			total += 3 * w;
		}
		pages++;
		if (doc.posts.length < PAGE_CAP) break;
	}
	return pages ? { hit, total } : null;
};

export function search(terms: string[], options: SearchOptions): SearchResult {
	const now = new Date();
	const liveIdx = monthIndexOf(now);

	let startIdx = 0;
	let endIdx = liveIdx;
	if (options.mode === "full" && options.since !== undefined) {
		const d = dateArg(options.since);
		if (!d) throw new FatalError(`--since must look like 2025-01-01, got: ${options.since}`);
		startIdx = monthIndexOf(d);
	}
	if (options.until !== undefined) {
		const d = dateArg(options.until);
		if (!d) throw new FatalError(`--until must look like 2025-01-01, got: ${options.until}`);
		endIdx = monthIndexOf(d);
	}
	if (startIdx > endIdx) throw new FatalError("--since is after --until: nothing to fetch");

	// --new starts at the watermark's month: overlap with already-fetched months is free, the
	// grid cache absorbs any staleness. No state file yet: fall back to last month.
	if (options.mode === "new") {
		let wmIdx = liveIdx - 1;
		try {
			const s = JSON.parse(fs.readFileSync(STATE, "utf8")) as { last_new?: string };
			const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s.last_new ?? ""));
			if (m) {
				wmIdx = monthIndexOf(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
			}
		} catch {
			// no state file: fall back to last month
		}
		startIdx = wmIdx;
		endIdx = liveIdx;
	}

	const urls: string[] = [];
	const stats: SearchStats = { windows: 0, cached: 0, queued: 0 };
	const relevance: Record<string, (RelevanceScore | null)[]> = {};

	for (const term of terms) {
		const word = term.trim().split(/\s+/)[0];
		relevance[term] = [];
		for (let mi = startIdx; mi <= endIdx; mi++) {
			const a = monthStart(mi);
			const b = monthStart(mi + 1);
			const q = `${term} after:${ISO(a)} before:${ISO(b)}`;
			const url = `/search.json?q=${encodeURIComponent(q)}`;
			stats.windows++;
			const live = mi === liveIdx;

			// page 1: the unfinished month is re-fetched and overwritten every run.
			const first = readTopics(q, null);
			if (first === null) {
				// Page 1 not on disk: only page 1 can be queued. Whether page 2 exists is unknown
				// until page 1 comes back full, so guessing it here would double the backfill.
				urls.push(url);
				stats.queued++;
				continue;
			}
			if (live) {
				urls.push(url);
				stats.queued++;
			} else {
				stats.cached++;
			}
			// page 2 only exists if page 1 is full; the live month may outgrow its cached page 1, so re-walk it.
			if (first.length < PAGE_CAP && !live) continue;
			for (let p = 2; ; p++) {
				if (p > PAGE_MAX)
					throw new FatalError(
						`${q} needs page ${p}, more than one month can hold. Not handled by design: ` +
							`split this month in two with --since/--until and fetch separately.`,
					);
				const t = readTopics(q, p);
				if (t === null) {
					urls.push(`${url}&page=${p}`);
					stats.queued++;
					break;
				}
				stats.cached++;
				if (t.length < PAGE_CAP) break;
			}
		}
		for (let mi = startIdx; mi <= endIdx; mi++) {
			const q = `${term} after:${ISO(monthStart(mi))} before:${ISO(monthStart(mi + 1))}`;
			relevance[term].push(scoreMonth(word, q));
		}
	}

	return { urls, stats, relevance, relevanceFrom: ISO(monthStart(startIdx)).slice(0, 7), now, liveIdx, startIdx };
}

/** Reads and validates data/terms.txt. Returns the term list; empty file means "nothing to do". */
export function readTerms(termsFile: string): string[] {
	return fs
		.readFileSync(termsFile, "utf8")
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith("#"));
}
