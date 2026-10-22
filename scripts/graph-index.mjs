/**
 * Index a directory with the Code Graph, rank it, and print what came out.
 *
 * A development utility, not a shipped feature: `src/graph/` has no callers in the app yet
 * (the tool-dispatch hook is build step 4), so this is how to exercise it by hand.
 *
 *   node scripts/graph-index.mjs <directory> [search-term]
 *
 * Writes its index to a temporary directory and deletes it afterwards, so it never touches
 * the target project's own `.o4c/`.
 */
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HERE = resolve(import.meta.dirname, '..');
const DIST = join(HERE, 'dist');
const graphMod = (name) => pathToFileURL(join(DIST, 'graph', name)).href;

let GraphStore, GRAPH_DB_FILENAME, extractFileForPath, languageForPath;
let rankDefinitions, fitToBudget, estimateTextTokens, skipReasonFor;
let resolveCallEdges, resolveName;
try {
  ({ GraphStore, GRAPH_DB_FILENAME } = await import(graphMod('graphStore.js')));
  ({ extractFileForPath } = await import(graphMod('tags.js')));
  ({ languageForPath } = await import(graphMod('languages.js')));
  ({ rankDefinitions, fitToBudget } = await import(graphMod('ranker.js')));
  ({ skipReasonFor } = await import(graphMod('indexFilter.js')));
  ({ resolveCallEdges, resolveName } = await import(graphMod('resolve.js')));
  ({ estimateTextTokens } = await import(
    pathToFileURL(join(DIST, 'agent', 'contextEntry.js')).href
  ));
} catch (err) {
  console.error('Could not load dist/. Run `npm run build` first.');
  console.error(String(err?.message ?? err));
  process.exit(1);
}

const target = resolve(process.argv[2] ?? process.cwd());
const searchTerm = process.argv[3];
const SKIP = new Set(['node_modules', '.git', 'dist', '.o4c', 'out', 'build', 'target', 'vendor']);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-cli-'));
const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));

console.log('indexing ' + target);
console.log('FTS5: ' + (store.ftsAvailable ? 'available' : 'NOT available - name search falls back to LIKE'));
console.log('');

const files = await walk(target);
const byLanguage = new Map();
const t0 = performance.now();
let indexed = 0;
let skipped = 0;
const failures = [];
const skippedReasons = new Map();

for (const abs of files) {
  const rel = relative(target, abs).split('\\').join('/');
  const lang = languageForPath(rel);
  if (!lang) {
    skipped++;
    continue;
  }
  try {
    const source = await readFile(abs, 'utf8');
    const skip = skipReasonFor(rel, source);
    if (skip) {
      skippedReasons.set(skip, (skippedReasons.get(skip) ?? 0) + 1);
      skipped++;
      continue;
    }
    const extracted = await extractFileForPath(source, rel);
    if (!extracted) {
      skipped++;
      continue;
    }
    store.indexFile({
      path: rel,
      language: lang.id,
      source,
      tags: extracted.tags,
      imports: extracted.imports,
    });
    indexed++;
    byLanguage.set(lang.id, (byLanguage.get(lang.id) ?? 0) + 1);
  } catch (err) {
    failures.push(rel + ': ' + String(err?.message ?? err).slice(0, 80));
  }
}

const indexMs = performance.now() - t0;
const stats = store.stats();

console.log('files seen        ' + files.length);
console.log('indexed           ' + indexed);
console.log('skipped           ' + skipped + '  (no bundled grammar claims the extension)');
console.log('failed            ' + failures.length);
console.log('index time        ' + (indexMs / 1000).toFixed(2) + 's  (' +
  (indexMs / Math.max(indexed, 1)).toFixed(1) + ' ms/file)');
console.log('rows              ' + stats.defs + ' definitions, ' + stats.refs +
  ' references, ' + stats.calls + ' call-shaped');

if (skippedReasons.size) {
  console.log('');
  console.log('excluded as generated/minified');
  for (const [reason, n] of [...skippedReasons].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + reason.padEnd(18) + String(n).padStart(5) + ' files');
  }
}

if (byLanguage.size) {
  console.log('');
  console.log('by language');
  for (const [id, n] of [...byLanguage].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + id.padEnd(12) + String(n).padStart(5) + ' files');
  }
}

if (failures.length) {
  console.log('');
  console.log('failures');
  for (const f of failures.slice(0, 10)) console.log('  ' + f);
  if (failures.length > 10) console.log('  ... and ' + (failures.length - 10) + ' more');
}

// ---- Ranking: build step 3. The point of the exercise - what matters, in budget order.
const t1 = performance.now();
const ranked = rankDefinitions(store, {
  mentionedIdents: searchTerm ? [searchTerm] : [],
});
const rankMs = performance.now() - t1;

console.log('');
console.log('rank time         ' + rankMs.toFixed(0) + ' ms  (' + ranked.iterations +
  ' pagerank iterations, ' + (ranked.converged ? 'converged' : 'HIT ITERATION CAP') + ')');
console.log('candidates        ' + ranked.definitions.length + ' ranked definitions');
console.log('peak RSS          ' + (process.memoryUsage().rss / 1048576).toFixed(0) + ' MB');

console.log('');
console.log('top 12 files by rank');
for (const f of ranked.files.slice(0, 12)) {
  console.log('  ' + f.rank.toFixed(5) + '  ' + f.path);
}

console.log('');
console.log('top 12 definitions by rank');
for (const d of ranked.definitions.slice(0, 12)) {
  console.log('  ' + d.rank.toFixed(6) + '  ' + d.ident.padEnd(26) + ' ' + d.path + ':' + d.line);
}

console.log('');
for (const budget of [1000, 4000, 16000]) {
  const fit = fitToBudget(ranked.definitions, { maxTokens: budget, countTokens: estimateTextTokens });
  console.log('budget ' + String(budget).padStart(6) + ' -> ' + String(fit.tokens).padStart(6) +
    ' tokens, ' + fit.used + ' of ' + ranked.definitions.length + ' definitions, ' +
    fit.probes + ' probes');
}

// ---- Resolution. The first honest look at how much of the graph can be resolved at all.
{
  const t2 = performance.now();
  const r = resolveCallEdges(store);
  const ms = performance.now() - t2;
  const pct = (n) => ((n / Math.max(r.counts.callSites, 1)) * 100).toFixed(1) + '%';
  console.log('');
  console.log('resolve time      ' + ms.toFixed(0) + ' ms');
  console.log('call sites        ' + r.counts.callSites);
  console.log('  resolved        ' + String(r.counts.resolved).padStart(6) + '  ' + pct(r.counts.resolved));
  console.log('  ambiguous       ' + String(r.counts.ambiguous).padStart(6) + '  ' + pct(r.counts.ambiguous) + '  (call_reference, never asserted)');
  console.log('  unresolved      ' + String(r.counts.unresolved).padStart(6) + '  ' + pct(r.counts.unresolved) + '  (library/stdlib, or a gap)');
  console.log('edges emitted     ' + r.counts.edges);
}

if (searchTerm) {
  console.log('');
  console.log('searchDefinitions(' + JSON.stringify(searchTerm) + ')');
  const hits = store.searchDefinitions(searchTerm, 15);
  if (!hits.length) console.log('  no matches');
  for (const h of hits) {
    console.log('  ' + h.name.padEnd(28) + h.kind.padEnd(10) + h.path + ':' + h.line);
  }

  const verdict = resolveName(store, searchTerm);
  console.log('');
  console.log('resolveName(' + JSON.stringify(searchTerm) + ') -> ' + verdict.verdict);
  console.log('  ' + verdict.note);
  console.log('  scanned: ' + verdict.scanned.filesIndexed + ' files, ' +
    verdict.scanned.definitionsIndexed + ' definitions, ' +
    verdict.scanned.candidatesFound + ' candidates');

  const defs = store.definitionsOf(searchTerm);
  if (defs.length) {
    console.log('');
    console.log('definitionsOf(' + JSON.stringify(searchTerm) + ')');
    for (const d of defs) console.log('  ' + d.path + ':' + d.line + '  ' + d.kind);

    const calls = store.referencesTo(searchTerm, true);
    console.log('');
    console.log('referencesTo(' + JSON.stringify(searchTerm) + ', callsOnly) - ' +
      calls.length + ' call site(s)');
    for (const c of calls.slice(0, 15)) console.log('  ' + c.path + ':' + c.line);
    if (calls.length > 15) console.log('  ... and ' + (calls.length - 15) + ' more');
    console.log('');
    console.log('  Note: call sites are syntactic, matched by name. Recall against a compiler');
    console.log('  oracle varies widely by repository, so treat absence as "not found", not "none".');
  }
}

store.close();
await rm(dir, { recursive: true, force: true });
