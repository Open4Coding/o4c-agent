// Grades the code graph's RANKING against git history.
//
// The question this answers, and why it is worth a harness: "rebuild the window fresh for each
// prompt" (David's fourth context-window method) either needs a model call per turn to decide what
// is relevant, or it needs the relevance to fall out of a pre-indexed store mechanically. The
// machinery for the second already exists - `rankDefinitions` + `fitToBudget` - but it shipped
// ungraded, so which of those two worlds we are in has never been established. This measures it.
//
// **The oracle is git history, and every commit is a free labelled example:**
//
//   repo state   = the commit's PARENT tree       (what the ranker gets to see)
//   the "prompt" = the commit MESSAGE             (what the user would have typed)
//   ground truth = the files the commit MODIFIED  (what the task actually needed)
//
// Indexing the parent tree rather than HEAD is the whole methodological point. Ranking against
// HEAD would leak: a message naming `flushDeltaBuffer` would rank the file highly partly *because
// the commit being graded already added that identifier to it*. The parent tree cannot know.
//
// Only `--diff-filter=M` (modified) counts as ground truth. A file the commit ADDED does not exist
// in the parent and is unrankable by construction, so including it would cap recall at a number
// that says nothing about the ranker.
//
// Two context variants, modelling two real moments:
//   cold - identifiers from the message only.      "I typed a task with nothing open."
//   warm - plus focusFiles = one changed file.     "I am already working somewhere."
// `rankDefinitions` excludes focus files from its own output, so warm is scored on the REMAINING
// changed files - which is exactly the useful question: given where I am, what else matters?
//
// Usage: npm run build && node scripts/rank-grade.mjs [repoRoot] [--commits N]

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const g = (name) => pathToFileURL(join(O4C, 'dist', 'graph', name)).href;

const { GraphStore, GRAPH_DB_FILENAME } = await import(g('graphStore.js'));
const { extractFileForPath } = await import(g('tags.js'));
const { languageForPath } = await import(g('languages.js'));
const { skipReasonFor } = await import(g('indexFilter.js'));
const { rankDefinitions, fitToBudget } = await import(g('ranker.js'));
const { walkFiles } = await import(pathToFileURL(join(O4C, 'dist', 'tools', 'searchUtils.js')).href);

const args = process.argv.slice(2);
const REPO = resolve(args.find((a) => !a.startsWith('--')) ?? O4C);
const COMMIT_ARG = args.find((a) => a.startsWith('--commits='));
const MAX_COMMITS = COMMIT_ARG ? Number(COMMIT_ARG.split('=')[1]) : 60;

/** Commits touching more than this are bulk renames/reformats, which teach nothing about relevance. */
const MAX_CHANGED_FILES = 25;
/** The budget `fitToBudget` is asked to hit - a plausible slice of a local model's window. */
const BUDGET_TOKENS = 8000;
/** char/4, the same rough estimator the product uses when no real usage figure is available. */
const countTokens = (text) => Math.ceil(text.length / 4);

function git(...a) {
  return execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

/** Source files this commit MODIFIED - present in the parent, so rankable. */
function modifiedSourceFiles(sha) {
  return git('show', '--name-only', '--format=', '--diff-filter=M', sha)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && languageForPath(l));
}

/**
 * Materialises a commit's tree into a temp directory.
 *
 * `git archive` rather than a checkout or a worktree: it touches nothing in the repository, which
 * matters because this runs against repositories the user is actively working in.
 */
async function materialise(tree) {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-rank-'));
  execFileSync('git', ['archive', '--format=tar', '-o', join(dir, 't.tar'), tree], { cwd: REPO });
  // Extracted with `cwd` and a bare relative filename, deliberately. MSYS/GNU tar reads any
  // argument containing a colon as `host:path` and tries to resolve "C" as a remote machine
  // ("tar: Cannot connect to C: resolve failed"), so no absolute Windows path may appear in argv.
  execFileSync('tar', ['-xf', 't.tar'], { cwd: dir });
  return dir;
}

/** Indexes a directory exactly as o4c would - the product's own walk, filter and extractor. */
async function indexTree(root) {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-rankdb-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  const walked = await walkFiles(root);
  for (const entry of walked.entries) {
    if (entry.isDirectory) continue;
    const language = languageForPath(entry.path);
    if (!language) continue;
    let source;
    try {
      source = await readFile(join(root, entry.path), 'utf8');
    } catch {
      continue;
    }
    if (skipReasonFor(entry.path, source)) continue;
    const extracted = await extractFileForPath(source, entry.path);
    if (!extracted) continue;
    store.indexFile({
      path: entry.path,
      language: language.id,
      source,
      tags: extracted.tags,
      imports: extracted.imports,
    });
  }
  return { store, dbDir: dir };
}

/**
 * The lexical anchor: message words that are actually identifiers in this tree.
 *
 * Deliberately an intersection with the index rather than a cleverer parse. A commit message is
 * prose with code words in it; the index already knows which words are code. Anything fancier
 * would be tuning the oracle rather than measuring the ranker.
 */
function mentionedIdents(message, knownIdents) {
  const out = new Set();
  for (const token of message.split(/[^A-Za-z0-9_$]+/)) {
    if (token.length >= 3 && knownIdents.has(token)) out.add(token);
  }
  return [...out];
}

function recallAt(rankedPaths, truth, k) {
  const top = new Set(rankedPaths.slice(0, k));
  let hit = 0;
  for (const path of truth) if (top.has(path)) hit++;
  return truth.length === 0 ? null : hit / truth.length;
}

/** Reciprocal rank of the FIRST ground-truth file - how near the top the ranker got. */
function reciprocalRank(rankedPaths, truth) {
  const want = new Set(truth);
  for (let i = 0; i < rankedPaths.length; i++) {
    if (want.has(rankedPaths[i])) return 1 / (i + 1);
  }
  return 0;
}

function mean(values) {
  const real = values.filter((v) => v !== null);
  return real.length === 0 ? 0 : real.reduce((a, b) => a + b, 0) / real.length;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------- the run

const shas = git('rev-list', '--no-merges', '-n', String(MAX_COMMITS * 3), 'HEAD')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const cold = { r10: [], r25: [], r50: [], mrr: [], budget: [] };
const warm = { r10: [], r25: [], r50: [], mrr: [], budget: [] };
const misses = [];
const coverage = [];
const firstHits = [];
let evaluated = 0;
let skippedNoParent = 0;
let skippedTooBig = 0;
let skippedNoTruth = 0;

console.log(`repo: ${REPO}`);
console.log(`sampling up to ${MAX_COMMITS} commits (of ${shas.length} candidates)\n`);

for (const sha of shas) {
  if (evaluated >= MAX_COMMITS) break;

  let parent;
  try {
    parent = git('rev-parse', `${sha}^`).trim();
  } catch {
    skippedNoParent++;
    continue;
  }

  const truth = modifiedSourceFiles(sha);
  if (truth.length === 0) {
    skippedNoTruth++;
    continue;
  }
  if (truth.length > MAX_CHANGED_FILES) {
    skippedTooBig++;
    continue;
  }

  const message = git('log', '-1', '--format=%B', sha).trim();

  let treeDir;
  let db;
  try {
    treeDir = await materialise(parent);
    db = await indexTree(treeDir);
  } catch (err) {
    await rm(treeDir ?? '', { recursive: true, force: true }).catch(() => {});
    console.log(`  ${sha.slice(0, 8)} skipped: ${err.message.split('\n')[0]}`);
    continue;
  }

  try {
    const { store } = db;
    const indexedPaths = new Set(store.files().map((f) => f.path));
    // Only ground-truth files the parent actually contains and the indexer actually took. A file
    // the walk skips (generated, minified, no grammar) is not a ranking failure.
    const scorable = truth.filter((p) => indexedPaths.has(p));
    if (scorable.length === 0) {
      skippedNoTruth++;
      continue;
    }

    const knownIdents = new Set();
    for (const file of store.files()) {
      for (const def of store.definitionsIn(file.path)) knownIdents.add(def.name);
    }
    const idents = mentionedIdents(message, knownIdents);

    // --- cold -------------------------------------------------------------
    const coldResult = rankDefinitions(store, { mentionedIdents: idents });
    const coldPaths = coldResult.files.map((f) => f.path);
    cold.r10.push(recallAt(coldPaths, scorable, 10));
    cold.r25.push(recallAt(coldPaths, scorable, 25));
    cold.r50.push(recallAt(coldPaths, scorable, 50));
    cold.mrr.push(reciprocalRank(coldPaths, scorable));

    // What a real window build would actually contain at this budget.
    const fitted = fitToBudget(coldResult.definitions, { maxTokens: BUDGET_TOKENS, countTokens });
    const inBudget = new Set(
      coldResult.definitions.slice(0, fitted.used).map((d) => d.path),
    );
    cold.budget.push(scorable.filter((p) => inBudget.has(p)).length / scorable.length);
    // Recorded so the budget figure can be read honestly: "86% of the wanted files were in the
    // map" means nothing if the map was most of the repository. Coverage says which it was.
    coverage.push({ inMap: inBudget.size, indexed: indexedPaths.size, tokens: fitted.tokens });
    // Where the first wanted file actually landed - the number MRR compresses away.
    const firstHit = coldPaths.findIndex((p) => scorable.includes(p));
    firstHits.push(firstHit < 0 ? Infinity : firstHit + 1);

    // --- warm -------------------------------------------------------------
    if (scorable.length >= 2) {
      const focus = scorable[0];
      const rest = scorable.slice(1);
      const warmResult = rankDefinitions(store, { focusFiles: [focus], mentionedIdents: idents });
      const warmPaths = warmResult.files.map((f) => f.path);
      warm.r10.push(recallAt(warmPaths, rest, 10));
      warm.r25.push(recallAt(warmPaths, rest, 25));
      warm.r50.push(recallAt(warmPaths, rest, 50));
      warm.mrr.push(reciprocalRank(warmPaths, rest));
      const warmFit = fitToBudget(warmResult.definitions, { maxTokens: BUDGET_TOKENS, countTokens });
      const warmInBudget = new Set(warmResult.definitions.slice(0, warmFit.used).map((d) => d.path));
      warm.budget.push(rest.filter((p) => warmInBudget.has(p)).length / rest.length);
    }

    // The census: where did it find nothing at all, and what did the message give it to work with?
    if (recallAt(coldPaths, scorable, 50) === 0) {
      misses.push({
        sha: sha.slice(0, 8),
        subject: message.split('\n')[0].slice(0, 60),
        idents: idents.length,
        files: scorable.length,
      });
    }

    evaluated++;
    if (evaluated % 10 === 0) process.stdout.write(`  ...${evaluated} commits\n`);
  } finally {
    db?.store?.close?.();
    await rm(treeDir, { recursive: true, force: true }).catch(() => {});
    await rm(db?.dbDir ?? '', { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------- report

console.log(`\nevaluated ${evaluated} commits`);
console.log(
  `skipped: ${skippedNoParent} rootless, ${skippedTooBig} over ${MAX_CHANGED_FILES} files, ${skippedNoTruth} no indexable modified source\n`,
);

const row = (name, m) =>
  `${name.padEnd(6)} ${pct(mean(m.r10)).padStart(7)} ${pct(mean(m.r25)).padStart(7)} ${pct(mean(m.r50)).padStart(7)} ${mean(m.mrr).toFixed(3).padStart(7)} ${pct(mean(m.budget)).padStart(9)}`;

console.log(`${''.padEnd(6)} ${'r@10'.padStart(7)} ${'r@25'.padStart(7)} ${'r@50'.padStart(7)} ${'MRR'.padStart(7)} ${`@${BUDGET_TOKENS / 1000}K`.padStart(9)}`);
console.log(row('cold', cold));
console.log(row('warm', warm));

// The budget figure has to be read against how much of the repository the map actually held:
// "86% of the wanted files were in it" says nothing if it held 86% of everything.
const finite = (xs) => xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const median = (xs) => (finite(xs).length ? finite(xs)[Math.floor(finite(xs).length / 2)] : Infinity);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const avgInMap = avg(coverage.map((c) => c.inMap));
const avgIndexed = avg(coverage.map((c) => c.indexed));
console.log(
  `\nbudget coverage: the ${BUDGET_TOKENS / 1000}K map held ${avgInMap.toFixed(0)} of ${avgIndexed.toFixed(0)} indexed files on average - ${pct(avgInMap / Math.max(1, avgIndexed))} of the repository`,
);
console.log(`median rank of the first wanted file: ${median(firstHits)}`);

console.log(`\ncomplete misses (nothing in top 50): ${misses.length}/${evaluated}`);
for (const m of misses.slice(0, 12)) {
  console.log(`  ${m.sha}  idents=${String(m.idents).padStart(2)}  files=${String(m.files).padStart(2)}  ${m.subject}`);
}

console.log(
  `\nJSON ${JSON.stringify({
    repo: REPO,
    evaluated,
    budgetTokens: BUDGET_TOKENS,
    cold: { r10: mean(cold.r10), r25: mean(cold.r25), r50: mean(cold.r50), mrr: mean(cold.mrr), budget: mean(cold.budget) },
    warm: { r10: mean(warm.r10), r25: mean(warm.r25), r50: mean(warm.r50), mrr: mean(warm.mrr), budget: mean(warm.budget) },
    completeMisses: misses.length,
  })}`,
);
