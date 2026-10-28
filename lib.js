// Shared naming rule: one query string must always land in the same file, in both scripts.
// If these two ever disagree, the cache silently re-downloads forever or never resumes.

const crypto = require("crypto");

const slug = (s) =>
  String(s)
    .replace(/[^\w\u4e00-\u9fa5.@=-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

// sanitising drops characters, and "C++" / "C#" / "C" would all share one file. Punctuation that
// carries meaning gets a short hash suffix; a normal query keeps its plain readable name.
const LOSSY = /[^\w\u4e00-\u9fa5.@=\-\s:]/;
const safe = (s) => {
  const raw = String(s ?? "");
  const base = slug(raw) || "empty";
  // the name is cut at 80 chars, so a long query can collide even when nothing was lost
  const ambiguous = LOSSY.test(raw) || raw.length > 80;
  return ambiguous ? `${base}-${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 4)}` : base;
};

const searchFile = (q, page) => `search/${safe(q || "_empty")}${page ? `-p${page}` : ""}.json`;

// GNU accepts both --opt value and --opt=value, and every option here has no optional value,
// so both forms must work. A value option swallowing the next --flag is the failure to stop:
// --file --new used to become the string "true".
class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "UsageError";
  }
}

// spec: { name: "value" | "flag" }. Anything not in spec is an error, so a typo like --urll
// says so instead of being silently ignored. hasOwn, not `in`: inherited names such as
// --toString would otherwise pass the check and swallow the next token as their value.
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function parseArgs(argv, spec) {
  const opts = Object.create(null);
  const args = [];
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

module.exports = { safe, searchFile, slug, parseArgs, UsageError };
