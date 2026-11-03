// CLI entry helpers: the shared arg-parsing prologue so each script reads HELP -> parse -> main.
// Behavior is fixed here: UsageError prints the message plus a "More:" line and exits 2;
// a bad number prints "--name must be a number >= min" and exits 2. Entries must not redefine these.

import type { OptSpec, Opts, ParsedArgs } from "./args";
import { parseArgs, UsageError } from "./args";

export function parseOrExit(argv: string[], spec: OptSpec, script: string): ParsedArgs {
	try {
		return parseArgs(argv, spec);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		console.error(e.message);
		console.error(`Usage: bun run src/${script} -h`);
		process.exit(2);
	}
}

export function optOf(opts: Opts, name: string, dflt = ""): string {
	const v = opts[name];
	return typeof v === "string" ? v : dflt;
}

export const flagOf = (opts: Opts, name: string): boolean => !!opts[name];

export function numOf(opts: Opts, name: string, dflt: number, min: number): number {
	const raw = optOf(opts, name, String(dflt));
	const v = Number(raw);
	if (!Number.isFinite(v) || v < min) {
		console.error(`--${name} must be a number >= ${min}, got: ${raw}`);
		process.exit(2);
	}
	return v;
}

export const showHelp = (help: string): never => {
	console.log(help);
	process.exit(0);
};

export const showUsage = (help: string, script: string): never => {
	console.error(help);
	console.error(`More: bun run src/${script} --help`);
	process.exit(2);
};
