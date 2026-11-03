// Page-side fetcher, as a real typed function. fetch-core serializes it with
// .toString() and hands it to `playwright-cli eval`, so it MUST stay self-contained:
// no imports, no closure over module-level values, all inputs via the PageCfg argument.
export interface PageCfg {
	urls: string[];
	conc: number;
	rateN: number;
	rateWindow: number;
}

export interface PageResult {
	url: string;
	ok?: boolean;
	status?: number;
	bytes?: number;
	body?: string;
	attempts?: number;
	ms?: number;
	blocked?: boolean;
	skipped?: boolean;
	error?: string;
}

export interface PageOut {
	requested: number;
	blocked: boolean;
	results: PageResult[];
}

export async function pageFetch(cfg: PageCfg): Promise<PageOut> {
	const URLS: string[] = cfg.urls;
	const LIMIT: number = cfg.rateN;
	const WINDOW: number = cfg.rateWindow;
	const CONC: number = cfg.conc;
	let inflight = 0;
	const starts: number[] = [];
	const waiting: Array<() => void> = [];
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	// Chrome clamps setTimeout in background tabs, so never poll on a short timer:
	// take a slot from a queue, and sleep exactly until the window frees up.
	const acquire = async (): Promise<void> => {
		if (inflight < CONC) {
			inflight++;
			return;
		}
		await new Promise<void>((r) => waiting.push(r));
	};
	const release = (): void => {
		const next = waiting.shift();
		if (next) next();
		else inflight--;
	};
	const slot = async (): Promise<void> => {
		for (;;) {
			await acquire();
			const now = Date.now();
			while (starts.length && now - starts[0] >= WINDOW) starts.shift();
			if (starts.length < LIMIT) {
				starts.push(now);
				return;
			}
			release();
			await sleep(WINDOW - (Date.now() - starts[0]) + 10);
		}
	};
	// A 429 here is Cloudflare's challenge page, not a polite rate limit. Retrying while it is
	// watching makes it worse, so one 429 stops the whole batch and hands the rest back.
	let blocked = false;
	const grab = async (u: string): Promise<PageResult> => {
		const back = (r: Omit<PageResult, "url">): PageResult => Object.assign({ url: u }, r);
		const t0 = Date.now();
		let attempts = 0;
		for (;;) {
			attempts++;
			if (blocked) return back({ ok: false, status: 0, skipped: true, ms: Date.now() - t0 });
			try {
				const r = await fetch(u, { headers: { Accept: "application/json" }, credentials: "same-origin" });
				const txt = await r.text();
				if (r.status === 429 || r.status === 403) {
					blocked = true;
					return back({
						ok: false,
						status: r.status,
						bytes: txt.length,
						blocked: true,
						attempts,
						ms: Date.now() - t0,
					});
				}
				if (r.status >= 500 && attempts < 2) {
					await sleep(4000);
					continue;
				}
				return back({ ok: r.ok, status: r.status, bytes: txt.length, body: txt, attempts, ms: Date.now() - t0 });
			} catch (e) {
				if (attempts >= 2) return back({ ok: false, status: 0, error: String(e), attempts, ms: Date.now() - t0 });
				await sleep(2000);
			}
		}
	};
	const results: PageResult[] = new Array(URLS.length);
	await Promise.all(
		URLS.map(async (u, i) => {
			await slot();
			try {
				results[i] = Object.assign({ url: u }, await grab(u));
			} catch (e) {
				results[i] = { url: u, ok: false, status: 0, error: String(e) };
			} finally {
				release();
			}
		}),
	);
	return { requested: URLS.length, blocked, results };
}
