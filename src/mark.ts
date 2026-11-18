#!/usr/bin/env bun
// Advance a topic's read cursor / verdict in data/index.jsonl. Never fetches, never judges.
// The contract is HELP (-h / --help), not this comment.
const HELP = `mark.ts — record what you read into data/index.jsonl (append-only, last line wins).

Usage:
  bun run src/mark.ts <topic_id> --upto 45
  bun run src/mark.ts <topic_id> --upto 45 --verdict 中性 --note "上海后端,远程,org:公开留存6人4人在岗"

Options:
  --upto N         highest post number you read (required; digest.ts --new only shows posts above it)
  --verdict VALUE  free text, e.g. 避开 / 人味强 / 中性 / 人味弱 / 信号不足 (whether floors are read is --upto, not the verdict)
  --note VALUE     one line of evidence, e.g. "org:公开留存6人4人在岗"
  --opt=VALUE works too. A bare -- ends options. Unknown options are errors.

Only the given fields change; the rest of your judgement on that topic is carried forward
by the last-line-wins read. Exit codes: 0 written · 1 no prior record and --verdict/--note
given without --upto (a verdict without a cursor makes --new wrong) · 2 bad arguments
`;

import { appendIndexRow, readIndex } from "./cli/index-store";
import { numOf, optOf, parseOrExit, showHelp, showUsage } from "./lib/cli";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) showHelp(HELP);
const { opts, args } = parseOrExit(argv, { upto: "value", verdict: "value", note: "value" }, "mark.ts");

const id = Number(args[0]?.replace(/\D/g, ""));
if (!args[0] || !id || String(id) !== args[0].replace(/\D/g, "")) {
	console.error("usage: bun run src/mark.ts <topic_id> --upto 45 [--verdict ...] [--note ...]");
	process.exit(2);
}
const verdict = optOf(opts, "verdict");
const note = optOf(opts, "note");
const uptoRaw = opts.upto;

// a verdict without a cursor makes digest --new silently skip or repeat posts
if (!uptoRaw && (verdict || note) && !readIndex().has(id)) {
	console.error(`topic ${id} has no record yet: give --upto first, so --new knows where you are.`);
	process.exit(1);
}
const row: { id: number; read_upto?: number; verdict?: string; note?: string } = { id };
if (uptoRaw) row.read_upto = numOf(opts, "upto", 0, 0);
if (verdict) row.verdict = verdict;
if (note) row.note = note;

if (Object.keys(row).length === 1) showUsage(HELP, "mark.ts");
appendIndexRow(row);

const prev = readIndex().get(id) || {};
const bits = [`topic ${id}`, `read_upto ${row.read_upto ?? prev.read_upto ?? "-"}`];
if (row.verdict ?? prev.verdict) bits.push(`verdict: ${row.verdict ?? prev.verdict}`);
if (row.note ?? prev.note) bits.push(`note: ${row.note ?? prev.note}`);
console.log(`recorded: ${bits.join(" · ")}`);
