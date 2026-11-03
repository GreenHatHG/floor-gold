// GNU accepts both --opt value and --opt=value, and every option here has no optional value,
// so both forms must work. A value option swallowing the next --flag is the failure to stop:
// --file --new used to become the string "true".

export class UsageError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "UsageError";
	}
}

export type OptSpec = Record<string, "flag" | "value">;
export type Opts = Record<string, string | boolean>;

export interface ParsedArgs {
	opts: Opts;
	args: string[];
}

// hasOwn, not `in`: inherited names such as --toString would otherwise pass the check and
// swallow the next token as their value.
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

export function parseArgs(argv: string[], spec: OptSpec): ParsedArgs {
	const opts = Object.create(null) as Opts;
	const args: string[] = [];
	let literal = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (literal || !a.startsWith("--")) {
			args.push(a);
			continue;
		}
		if (a === "--") {
			literal = true;
			continue;
		}
		const eq = a.indexOf("=");
		const name = eq > -1 ? a.slice(2, eq) : a.slice(2);
		if (!has(spec, name)) throw new UsageError(`unknown option --${name}`);
		const kind = spec[name];
		if (kind === "flag") {
			if (eq > -1) throw new UsageError(`--${name} takes no value`);
			opts[name] = true;
			continue;
		}
		if (eq > -1) {
			const v = a.slice(eq + 1);
			if (!v) throw new UsageError(`--${name} needs a value`);
			opts[name] = v;
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
		opts[name] = next;
		i++;
	}
	return { opts, args };
}
