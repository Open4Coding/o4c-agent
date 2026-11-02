import type { DefinitionRow, GraphStore } from './graphStore.js';
import { splitIdentifier } from './identifierSplit.js';

/**
 * Names close to one that is not in the index (plan 0006 B14): a typo (`computArea`), a different
 * case or separator (`compute_area`), or a part of the real name (`area`). Asked for only when the
 * exact lookup came back `absent` - "not there" plus three real names to try saves the model a
 * round of grepping for spellings.
 *
 * Candidates come from `searchDefinitions` (FTS5 prefix search over the pre-split identifier
 * words) for each word of the query, and for each word's first four letters so a typo past the
 * start still finds its word; they are then ranked by edit distance on the whole name.
 */
export function fuzzyCandidates(store: GraphStore, name: string, limit = 3): DefinitionRow[] {
  const words = splitIdentifier(name).map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  const pool = new Map<string, DefinitionRow>();
  for (const term of new Set(words.flatMap((w) => (w.length > 4 ? [w, w.slice(0, 4)] : [w])))) {
    for (const row of store.searchDefinitions(term, 50)) pool.set(`${row.name}|${row.path}|${row.line}`, row);
  }
  const target = name.toLowerCase().replace(/[_\-\s]/g, '');
  const scored = [...pool.values()]
    .map((row) => {
      const candidate = row.name.toLowerCase().replace(/[_\-\s]/g, '');
      const contains = candidate.includes(target) || target.includes(candidate);
      return { row, d: contains ? Math.abs(candidate.length - target.length) / 10 : distance(candidate, target) };
    })
    .filter((x) => x.d <= Math.max(2, Math.floor(target.length / 3)));
  scored.sort((a, b) => a.d - b.d || a.row.name.length - b.row.name.length || a.row.path.localeCompare(b.row.path));
  const seen = new Set<string>();
  const out: DefinitionRow[] = [];
  for (const { row } of scored) {
    if (row.name === name || seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}
