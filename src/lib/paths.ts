// All data/ paths in one place. ROOT is the repo root: under `bun run src/<script>.ts`,
// __dirname is src/lib, so two levels up. A script that joins data/ from its own __dirname
// instead would look OUTSIDE the repo (found by the monthly-grid rewrite: cache never hit).
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const DATA = path.join(ROOT, "data");
export const RAW = path.join(DATA, "raw");
export const STATE = path.join(DATA, "search-state.json");
export const NOTES = path.join(DATA, "notes.jsonl");
export const INDEX = path.join(DATA, "index.jsonl");
export const TERMS = path.join(DATA, "terms.txt");
export const URLS_FILE = path.join(DATA, "urls.txt");
export const TODO_FILE = path.join(DATA, "todo.txt");
