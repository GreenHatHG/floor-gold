// Text helpers for digest.ts: HTML-to-text conversion and date/line formatting.

export function htmlToText(html: unknown): string {
	return String(html || "")
		.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, " $1 ")
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/</g, "<")
		.replace(/>/g, ">")
		.replace(/"/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&/g, "&")
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export const md = (iso?: string | null): string => {
	if (!iso) return "??-??";
	const d = new Date(iso);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const oneLine = (s: string): string => s.replace(/\s*\n+\s*/g, " ⏎ ").trim();
