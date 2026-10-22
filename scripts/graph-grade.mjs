// Grades the code graph's resolved call edges against the TypeScript compiler.
//
// Four cells: two repositories, each reported with and without its test files. Two repositories
// because the independent-grading review found recall varying from 0.026 to 0.967 ACROSS
// repositories with no query-time signal to say which you are in - a figure from one repository
// is not a property of the tool. With and without tests because o4c's own call sites are
// dominated by `assert.equal` and friends, and a figure propped up by test code would not survive
// contact with a real codebase.
//
// The oracle program is identical across the two cells of a repository: only the reporting filter
// on the CALLER path changes. That keeps the cells differing by exactly one thing.
//
// Writes the raw counts to .docs/code-graph-acceptance.json, which
// src/test/codeGraphAcceptance.test.ts re-derives every figure in .docs/code-graph-acceptance.md
// from - so a number in the prose cannot drift away from the measurement that produced it.
//
// Usage: npm run build && node scripts/graph-grade.mjs

import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildOracle } from './graph-oracle.mjs';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const g = (name) => pathToFileURL(join(O4C, 'dist', 'graph', name)).href;

const { GraphStore, GRAPH_DB_FILENAME } = await import(g('graphStore.js'));
const { extractFileForPath } = await import(g('tags.js'));
const { languageForPath } = await import(g('languages.js'));
const { skipReasonFor } = await import(g('indexFilter.js'));
const { resolveCallEdges } = await import(g('resolve.js'));
const { isAssertedCall } = await import(g('edgeKind.js'));
const { walkFiles } = await import(pathToFileURL(join(O4C, 'dist', 'tools', 'searchUtils.js')).href);
const { grade, rate, formatRate, pct } = await import(g('grading.js'));

// The second repository is a clone outside this one, so its location is not knowable from here.
// Override with the first argument or O4C_GRADE_SECOND_REPO. Missing, the run reports the o4c
// cells alone and says so, rather than failing - one repository's figures are still worth having,
// as long as nobody mistakes them for two.
const SECOND_REPO =
  process.argv[2] ??
  process.env.O4C_GRADE_SECOND_REPO ??
  'D:/AngelCode/research/code-graph/repomix';

const REPOS = [{ name: 'o4c-agent', root: O4C, tsconfig: 'tsconfig.test.json' }];
if (existsSync(join(SECOND_REPO, 'tsconfig.json'))) {
  REPOS.push({ name: 'repomix', root: SECOND_REPO, tsconfig: 'tsconfig.json' });
} else {
  console.log(`no second repository at ${SECOND_REPO}; grading o4c-agent only.`);
  console.log('Pass one as the first argument to restore the cross-repository cells.\n');
}

// No skip list of its own any more. Until 2026-10-22 this file walked the tree itself and skipped
// `lib`, `.o4c`, `coverage` and every dotted directory, which meant the graded figures were taken
// over a *different* file set than the product indexes - and the difference was invisible from
// either side. It now uses the product's own `walkFiles`, which is what makes "indexes a
// repository exactly as o4c would" below a statement rather than an aspiration.

/** A test file by path, on both sides of the comparison, by the same rule. */
function isTestPath(path) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

/** Indexes a repository exactly as o4c would, and returns the resolver's own output. */
async function indexRepo(root) {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-grade-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  let indexed = 0;
  let skipped = 0;
  let noGrammar = 0;

  const walked = await walkFiles(root);
  for (const entry of walked.entries) {
    if (entry.isDirectory) continue;
    const path = entry.path;
    const absolute = join(root, path);
    const language = languageForPath(path);
    if (!language) {
      noGrammar++;
      continue;
    }
    const source = await readFile(absolute, 'utf8');
    if (skipReasonFor(path, source)) {
      skipped++;
      continue;
    }
    // `extractFileForPath`, not `extractTagsForPath`: the store this grades must carry import
    // bindings, or the run would silently measure the pre-step-5 resolver.
    const extracted = await extractFileForPath(source, path);
    if (!extracted) continue;
    store.indexFile({ path, language: language.id, source, tags: extracted.tags, imports: extracted.imports });
    indexed++;
  }

  const resolved = resolveCallEdges(store);

  // Every call-shaped reference, whether or not it resolved. Needed to tell a miss caused by
  // extraction (the call site was never seen) from one caused by resolution (seen, not matched).
  const extractedSites = new Set();
  for (const file of store.files()) {
    for (const ref of store.referencesIn(file.path)) {
      if (isAssertedCall(ref.edgeKind)) extractedSites.add(`${file.path}:${ref.line}:${ref.name}`);
    }
  }

  // How many distinct files define each name - the only thing needed to tell a name that was
  // never ambiguous from one the same-file rule had to choose between.
  const defFileCount = new Map();
  for (const file of store.files()) {
    for (const def of store.definitionsIn(file.path)) {
      const seen = defFileCount.get(def.name);
      if (seen) seen.add(file.path);
      else defFileCount.set(def.name, new Set([file.path]));
    }
  }
  for (const [name, paths] of defFileCount) defFileCount.set(name, paths.size);

  const out = { resolved, extractedSites, defFileCount, files: { indexed, skipped, noGrammar }, store };
  out.dispose = async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  };
  return out;
}

const key = (path, line, name) => `${path}:${line}:${name}`;

/** Deterministic, spread across the sorted list rather than taken from its head. */
function sample(items, wanted = 20) {
  const sorted = [...items].sort();
  if (sorted.length <= wanted) return sorted;
  const stride = sorted.length / wanted;
  return Array.from({ length: wanted }, (_, i) => sorted[Math.floor(i * stride)]);
}

function compare(oracleSites, constructorSites, predictedEdges, extractedSites, defFileCount, includeCaller) {
  // Deduplicate both sides by call-site key. `foo(foo(1))` is two call sites on one line sharing
  // a name; neither side can tell them apart, so both sides collapse them identically.
  const oracleByKey = new Map();
  for (const site of oracleSites) {
    if (!includeCaller(site.fromPath)) continue;
    oracleByKey.set(key(site.fromPath, site.fromLine, site.name), site);
  }

  const assertedByKey = new Map();
  const candidatesByKey = new Map();
  for (const edge of predictedEdges) {
    if (!includeCaller(edge.fromPath)) continue;
    const k = key(edge.fromPath, edge.fromLine, edge.name);
    if (edge.kind === 'call') {
      assertedByKey.set(k, edge);
    } else {
      let list = candidatesByKey.get(k);
      if (!list) candidatesByKey.set(k, (list = []));
      list.push(edge);
    }
  }

  let truePositives = 0;
  let falsePositives = 0;
  let exactLine = 0;
  // resolve.ts prefers a definition in the referencing file when a name is shared, on the
  // argument that lexical scope makes it overwhelmingly likely. Its own comment says the
  // acceptance test is what decides whether that earns its place, so count both sides of it:
  // how often it was the ONLY reason an answer was right, and how often it was the reason an
  // answer was wrong.
  let sameFilePreferenceWon = 0;
  let sameFilePreferenceLost = 0;
  let crossFileWrong = 0;
  let recoverableByCandidate = 0;
  let missedByExtraction = 0;
  let missedByResolution = 0;
  const falsePositiveDetail = [];
  const falseNegativeDetail = [];

  for (const [k, site] of oracleByKey) {
    const asserted = assertedByKey.get(k);
    if (asserted) {
      const sharedName = (defFileCount.get(site.name) ?? 0) > 1;
      if (asserted.toPath === site.toPath) {
        truePositives++;
        if (asserted.toLine === site.toLine) exactLine++;
        if (sharedName && asserted.toPath === asserted.fromPath) sameFilePreferenceWon++;
      } else {
        falsePositives++;
        if (asserted.toPath === asserted.fromPath) sameFilePreferenceLost++;
        else crossFileWrong++;
        falsePositiveDetail.push(
          `${k}  said ${asserted.toPath}:${asserted.toLine}  truth ${site.toPath}:${site.toLine}`,
        );
      }
      continue;
    }

    // A miss. Which half of the pipeline lost it?
    const candidates = candidatesByKey.get(k);
    const rightOneOffered = candidates?.some((c) => c.toPath === site.toPath) ?? false;
    if (rightOneOffered) recoverableByCandidate++;

    if (extractedSites.has(k)) missedByResolution++;
    else missedByExtraction++;

    falseNegativeDetail.push(
      `${k}  truth ${site.toPath}:${site.toLine}  ` +
        `[${extractedSites.has(k) ? 'site extracted' : 'site NOT extracted'}` +
        `${candidates ? `, ${candidates.length} ambiguous candidates${rightOneOffered ? ' incl. the right one' : ''}` : ''}]`,
    );
  }

  // Every oracle edge not recovered, which includes the ones answered WRONGLY. A site given the
  // wrong target is both a false positive (precision) and an unrecovered edge (recall) - the
  // partition check in grading.ts rejected an earlier version of this line that counted such a
  // site in neither, which would have overstated recall by however often the graph guesses wrong.
  const falseNegatives = oracleByKey.size - truePositives;

  // Asserted edges whose call site the oracle never ruled on: calls into node_modules and the
  // standard library, mostly. Neither right nor wrong - outside the oracle's universe.
  let outOfUniverse = 0;
  for (const k of assertedByKey.keys()) if (!oracleByKey.has(k)) outOfUniverse++;

  const counts = {
    asserted: assertedByKey.size,
    truePositives,
    falsePositives,
    falseNegatives,
    outOfUniverse,
    oracleEdges: oracleByKey.size,
  };

  // The same recall, over a denominator widened by the constructor calls the graded universe
  // excludes. `new X()` is excluded because the graph captures it as a class reference rather
  // than an asserted call, which is defensible - but the exclusion also makes recall look
  // better, so the figure without it belongs beside the figure with it.
  const constructorsInCell = constructorSites.filter((s) => includeCaller(s.fromPath)).length;
  const widened = rate(truePositives, oracleByKey.size + constructorsInCell);

  return {
    counts,
    grade: grade(counts),
    constructorsInCell,
    widenedRecall: widened,
    sameFilePreferenceWon,
    sameFilePreferenceLost,
    crossFileWrong,
    exactLine,
    recoverableByCandidate,
    missedByExtraction,
    missedByResolution,
    samples: {
      falsePositives: sample(falsePositiveDetail),
      falseNegatives: sample(falseNegativeDetail),
    },
  };
}

// ------------------------------------------------------------------ run

// Local date, not UTC: a report stamped tomorrow is a small thing that makes a reader doubt
// everything else in the file.
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

// Which tree the figures describe. This matters more than it looks: o4c is one of the two graded
// repositories, so its own test files are part of what gets indexed, and adding a test file - even
// the one that guards these very figures - moves the counts slightly. The numbers are a snapshot
// of a tree, not a constant, and the snapshot has to say which tree.
let commit = 'unknown';
let dirty = false;
try {
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', args, { cwd: O4C, encoding: 'utf8' }).trim();
  commit = git('rev-parse', 'HEAD');
  dirty = git('status', '--porcelain').length > 0;
} catch {
  // Not a checkout, or no git: the figures are still valid, they just cannot be pinned.
}

const report = { generated: stamp, commit, workingTreeDirty: dirty, cells: {} };

for (const repo of REPOS) {
  console.log(`\n${'='.repeat(78)}\n${repo.name}\n${'='.repeat(78)}`);

  const started = Date.now();
  const oracle = buildOracle(repo.root, repo.tsconfig);
  const oracleMs = Date.now() - started;

  const indexStarted = Date.now();
  const indexed = await indexRepo(repo.root);
  const indexMs = Date.now() - indexStarted;

  console.log(`oracle   ${oracle.sites.length} in-repo edges in ${(oracleMs / 1000).toFixed(1)}s`);
  console.log(`         ${oracle.diagnostics.callExpressions} call expressions, ` +
    `${oracle.diagnostics.outOfRepo} out of repo, ` +
    `${oracle.diagnostics.unsupportedShape} shapes the graph never captures, ` +
    `${oracle.diagnostics.newExpressions} constructor calls excluded by design`);
  console.log(`graph    ${indexed.files.indexed} files indexed ` +
    `(${indexed.files.skipped} filtered, ${indexed.files.noGrammar} no grammar) in ${(indexMs / 1000).toFixed(1)}s`);
  console.log(`         ${indexed.resolved.counts.callSites} call sites, ` +
    `${indexed.resolved.counts.resolved} resolved, ` +
    `${indexed.resolved.counts.ambiguous} ambiguous, ` +
    `${indexed.resolved.counts.unresolved} unresolved` +
    `, ${indexed.resolved.counts.viaImport} of the resolved via an import` +
    `, ${indexed.resolved.counts.viaCallShape} via the call's shape`);

  for (const [cellName, includeCaller] of [
    ['with tests', () => true],
    ['without tests', (path) => !isTestPath(path)],
  ]) {
    const result = compare(
      oracle.sites,
      oracle.constructorSites,
      indexed.resolved.edges,
      indexed.extractedSites,
      indexed.defFileCount,
      includeCaller,
    );
    const id = `${repo.name} / ${cellName}`;
    report.cells[id] = {
      counts: result.counts,
      constructorsInCell: result.constructorsInCell,
      sameFilePreferenceWon: result.sameFilePreferenceWon,
      sameFilePreferenceLost: result.sameFilePreferenceLost,
      crossFileWrong: result.crossFileWrong,
      exactLine: result.exactLine,
      recoverableByCandidate: result.recoverableByCandidate,
      missedByExtraction: result.missedByExtraction,
      missedByResolution: result.missedByResolution,
    };

    console.log(`\n--- ${id} ---`);
    console.log(`  precision  ${formatRate(result.grade.precision)}`);
    console.log(`  recall     ${formatRate(result.grade.recall)}`);
    console.log(`  F1         ${result.grade.f1.toFixed(3)}`);
    console.log(`  recall if the ${result.constructorsInCell} in-repo constructor calls are ` +
      `counted as misses: ${formatRate(result.widenedRecall)}`);
    console.log(`  out of the oracle's universe (library calls): ${result.counts.outOfUniverse}`);
    console.log(`  exact target line too: ${result.exactLine}/${result.counts.truePositives} ` +
      `(${pct(rate(result.exactLine, result.counts.truePositives).value)})`);
    console.log(`  same-file preference: right ${result.sameFilePreferenceWon} times on a shared name, ` +
      `wrong ${result.sameFilePreferenceLost} times; ${result.crossFileWrong} wrong for other reasons`);
    console.log(`  misses: ${result.missedByExtraction} never extracted, ` +
      `${result.missedByResolution} extracted but unresolved ` +
      `(${result.recoverableByCandidate} had the right target among ambiguous candidates)`);

    console.log(`\n  20 sampled false positives:`);
    for (const line of result.samples.falsePositives) console.log(`    ${line}`);
    if (result.samples.falsePositives.length === 0) console.log('    (none)');
    console.log(`\n  20 sampled false negatives:`);
    for (const line of result.samples.falseNegatives) console.log(`    ${line}`);
    if (result.samples.falseNegatives.length === 0) console.log('    (none)');
  }

  report.cells[`${repo.name} / with tests`].oracleDiagnostics = oracle.diagnostics;
  report.cells[`${repo.name} / with tests`].graphCounts = indexed.resolved.counts;
  report.cells[`${repo.name} / with tests`].graphFiles = indexed.files;

  await indexed.dispose();
}

const out = join(O4C, '.docs', 'code-graph-acceptance.json');
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nraw counts written to ${out}`);
