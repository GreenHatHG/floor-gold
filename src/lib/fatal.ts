// A fatal condition inside a core module: the CLI catches it, prints, and exits 1.
// Core modules must never process.exit() — the orchestrator (crawl.ts) decides what a
// failure means for the whole run.
export class FatalError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "FatalError";
	}
}
