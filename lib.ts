// Shared naming rule: one query string must always land in the same file, in both scripts.
// If these two ever disagree, the cache silently re-downloads forever or never resumes.

import crypto from "node:crypto";

// ---- shapes of the JSON the scripts read and write ----

export interface TopicPost {
  id: number;
  post_number: number;
  username?: string;
  created_at?: string;
  cooked?: string;
  [field: string]: unknown;
}

export interface TopicStream {
  posts?: TopicPost[];
  stream?: number[];
}

export interface TopicTag {
  name: string;
}

export interface TopicDoc {
  id: number;
  title?: string;
  posts_count?: number;
  highest_post_number?: number;
  last_posted_at?: string;
  created_at?: string;
  category_id?: number;
  closed?: boolean;
  archived?: boolean;
  views?: number;
  tags?: TopicTag[];
  post_stream?: TopicStream;
  [field: string]: unknown;
}

export interface FeedTopic {
  id: number;
  title?: string;
  posts_count?: number;
  highest_post_number?: number;
  last_posted_at?: string;
  category_id?: number;
}

export interface FeedDoc {
  topics?: FeedTopic[];
  topic_list?: { topics?: FeedTopic[] };
}

export interface IdsDoc {
  id?: number;
  post_ids?: number[];
}

export interface IndexRow {
  id?: number;
  read_upto?: number;
  verdict?: string;
  note?: string;
}

export type NoteRow =
  | { t: "asked"; id: number; anchor: number; high: number }
  | { t: "missing"; id: number; pid: (string | number)[] };

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
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

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
