// Shared naming rule: one query string must always land in the same file, in every script.
// If these ever disagree, the cache silently re-downloads forever or never resumes.

import crypto from "node:crypto";

export const slug = (s: unknown): string =>
	String(s)
		.replace(/[^\w\u4e00-\u9fa5.@=-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);

// sanitising drops characters, and "C++" / "C#" / "C" would all share one file. Punctuation that
// carries meaning gets a short hash suffix; a normal query keeps its plain readable name.
const LOSSY = /[^\w\u4e00-\u9fa5.@=\-\s:]/;
export const safe = (s: unknown): string => {
	const raw = String(s ?? "");
	const base = slug(raw) || "empty";
	// the name is cut at 80 chars, so a long query can collide even when nothing was lost
	const ambiguous = LOSSY.test(raw) || raw.length > 80;
	return ambiguous ? `${base}-${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 4)}` : base;
};

export const searchFile = (q: string | null | undefined, page?: number | string | null): string =>
	`search/${safe(q || "_empty")}${page ? `-p${page}` : ""}.json`;
