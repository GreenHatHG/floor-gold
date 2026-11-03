// Reads data/index.jsonl (one judgement per line, last line wins, append-only) and
// data/notes.jsonl (machine bookkeeping appended by fetch.ts and pending.ts).

import fs from "node:fs";
import { INDEX, NOTES } from "../lib/paths";
import type { IndexRow, NoteRow } from "../lib/types";

export function readIndex(): Map<number, IndexRow> {
	const out = new Map<number, IndexRow>();
	if (!fs.existsSync(INDEX)) return out;
	for (const line of fs.readFileSync(INDEX, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as IndexRow;
			if (row && row.id != null) out.set(Number(row.id), Object.assign(out.get(Number(row.id)) || {}, row));
		} catch {}
	}
	return out;
}

export interface Notes {
	//   {t:"missing", id, pid:[]}  server said these post ids do not exist -> stop asking
	//   {t:"asked",   id, anchor, high}  we already asked for ids above `anchor` while the server
	//                                   claimed `high` -> nothing new came back, do not ask again
	asked: Map<string, number>;
	missing: Set<string>;
}

export function readNotes(): Notes {
	const asked = new Map<string, number>();
	const missing = new Set<string>();
	if (!fs.existsSync(NOTES)) return { asked, missing };
	for (const line of fs.readFileSync(NOTES, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as NoteRow;
			if (row.t === "missing" && row.id != null) for (const p of row.pid || []) missing.add(`${row.id}:${p}`);
			if (row.t === "asked" && row.id != null) asked.set(`${row.id}:${row.anchor}`, Number(row.high));
		} catch {}
	}
	return { asked, missing };
}

export function appendNoteRows(rows: NoteRow[]): void {
	if (!rows.length) return;
	fs.appendFileSync(NOTES, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
