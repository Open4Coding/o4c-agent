import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { extractTags } from '../graph/tags.js';
import { pageRank } from '../graph/pageRank.js';
import { rankDefinitions, fitToBudget, renderDefinitionMap } from '../graph/ranker.js';
import { estimateTextTokens } from '../agent/contextEntry.js';

/**
 * Build step 3: personalized PageRank over the definition/reference graph, aider's weighting
 * heuristics, and a binary search to a token budget.
 *
 * The heuristics are asserted individually because they are the part that cannot be re-derived -
 * the 8-character and 5-definition thresholds are tuned constants from aider's source, and a
 * well-meaning "simplification" of any of them would quietly degrade the ranking with nothing
 * failing.
 */

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-rank-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function addTs(store: GraphStore, path: string, source: string): Promise<void> {
  store.indexFile({ path, language: 'typescript', source, tags: await extractTags(source, 'typescript') });
}

// ------------------------------------------------------------------ pagerank itself

test('pagerank ranks a hub above its spokes and sums to one', () => {
  const nodes = ['hub', 'a', 'b', 'c'];
  const edges = [
    { from: 'a', to: 'hub', weight: 1, ident: 'x' },
    { from: 'b', to: 'hub', weight: 1, ident: 'x' },
    { from: 'c', to: 'hub', weight: 1, ident: 'x' },
  ];
  const { ranks, converged } = pageRank(nodes, edges);

  assert.ok(converged, 'should converge on a trivial graph');
  const total = [...ranks.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `ranks should sum to 1, got ${total}`);
  for (const spoke of ['a', 'b', 'c']) {
    assert.ok(ranks.get('hub')! > ranks.get(spoke)!, `hub should outrank ${spoke}`);
  }
});

test('isolated nodes still receive a rank', () => {
  // A file sharing no identifiers is a real file, just an unconnected one. Deriving the node set
  // from edges alone would drop it entirely.
  const { ranks } = pageRank(['lonely', 'a', 'b'], [{ from: 'a', to: 'b', weight: 1, ident: 'x' }]);
  assert.ok((ranks.get('lonely') ?? 0) > 0, 'an isolated node must not be rank zero');
});

test('personalization moves rank toward the seeded node', () => {
  const nodes = ['a', 'b', 'c'];
  const edges = [
    { from: 'a', to: 'b', weight: 1, ident: 'x' },
    { from: 'b', to: 'c', weight: 1, ident: 'x' },
    { from: 'c', to: 'a', weight: 1, ident: 'x' },
  ];
  const plain = pageRank(nodes, edges).ranks;
  const seeded = pageRank(nodes, edges, { personalization: new Map([['a', 1]]) }).ranks;

  // A symmetric cycle is uniform without personalization.
  assert.ok(Math.abs(plain.get('a')! - plain.get('b')!) < 1e-6, 'cycle should be uniform');
  assert.ok(seeded.get('a')! > plain.get('a')!, 'seeding a must raise its rank');
  assert.ok(seeded.get('a')! > seeded.get('b')!, 'seeded node should lead');
});

test('dangling nodes redistribute through the teleport vector, not uniformly', () => {
  // Without dangling handling, `leaf` leaks its mass evenly and dilutes the personalization.
  const nodes = ['seed', 'leaf', 'other'];
  const edges = [{ from: 'seed', to: 'leaf', weight: 1, ident: 'x' }];
  const { ranks } = pageRank(nodes, edges, { personalization: new Map([['seed', 1]]) });
  assert.ok(ranks.get('other')! < ranks.get('seed')!, 'unseeded node must not absorb dangling mass');
});

test('parallel edges accumulate', () => {
  const nodes = ['a', 'b', 'c'];
  const one = pageRank(nodes, [
    { from: 'a', to: 'b', weight: 1, ident: 'x' },
    { from: 'a', to: 'c', weight: 1, ident: 'y' },
  ]).ranks;
  const two = pageRank(nodes, [
    { from: 'a', to: 'b', weight: 1, ident: 'x' },
    { from: 'a', to: 'b', weight: 1, ident: 'y' },
    { from: 'a', to: 'c', weight: 1, ident: 'z' },
  ]).ranks;
  assert.ok(two.get('b')! > one.get('b')!, 'a second parallel edge should add weight');
});

test('an empty graph is handled rather than dividing by zero', () => {
  const empty = pageRank([], []);
  assert.equal(empty.ranks.size, 0);
  assert.ok(empty.converged);
  // Zero-weight edges must not produce NaN.
  const zero = pageRank(['a', 'b'], [{ from: 'a', to: 'b', weight: 0, ident: 'x' }]);
  for (const v of zero.ranks.values()) assert.ok(Number.isFinite(v), 'rank should be finite');
});

// ------------------------------------------------------------------ heuristics

test('a widely-defined name is damped relative to a distinctive one', async () => {
  await withStore(async (store) => {
    // `complete` is defined in 6 files (aider damps >5 by x0.1); `computeTrajectory` in one.
    for (let i = 0; i < 6; i++) {
      await addTs(store, `src/noise${i}.ts`, 'export function complete(): void {}');
    }
    await addTs(store, 'src/special.ts', 'export function computeTrajectory(): void {}');
    await addTs(
      store,
      'src/caller.ts',
      ['function run() {', '  complete();', '  computeTrajectory();', '}'].join('\n'),
    );

    const { definitions } = rankDefinitions(store);
    const trajectory = definitions.find((d) => d.ident === 'computeTrajectory');
    const complete = definitions.find((d) => d.ident === 'complete');

    assert.ok(trajectory, 'computeTrajectory should be ranked');
    assert.ok(complete, 'complete should still appear - damped, not deleted');
    assert.ok(
      trajectory.rank > complete.rank,
      `a distinctive long name should outrank a name defined in 6 files (${trajectory.rank} vs ${complete.rank})`,
    );
  });
});

test('a leading underscore is damped', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function _privateHelper(): void {}');
    await addTs(store, 'src/b.ts', 'export function publicHelper(): void {}');
    await addTs(store, 'src/c.ts', ['function run() {', '  _privateHelper();', '  publicHelper();', '}'].join('\n'));

    const { definitions } = rankDefinitions(store);
    const priv = definitions.find((d) => d.ident === '_privateHelper');
    const pub = definitions.find((d) => d.ident === 'publicHelper');
    assert.ok(priv && pub);
    assert.ok(pub.rank > priv.rank, 'a leading underscore should rank below an equivalent public name');
  });
});

test('a mentioned identifier is boosted', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/alpha.ts', 'export function alphaHandler(): void {}');
    await addTs(store, 'src/beta.ts', 'export function betaHandler(): void {}');
    await addTs(store, 'src/c.ts', ['function run() {', '  alphaHandler();', '  betaHandler();', '}'].join('\n'));

    const plain = rankDefinitions(store).definitions;
    const seeded = rankDefinitions(store, { mentionedIdents: ['betaHandler'] }).definitions;

    const plainBeta = plain.find((d) => d.ident === 'betaHandler')!.rank;
    const seededBeta = seeded.find((d) => d.ident === 'betaHandler')!.rank;
    assert.ok(seededBeta > plainBeta, 'mentioning an identifier should raise its rank');
  });
});

test('focus files are excluded from the output and amplify what they reference', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/target.ts', 'export function interestingThing(): void {}');
    await addTs(store, 'src/unrelated.ts', 'export function otherThing(): void {}');
    await addTs(store, 'src/open.ts', 'function run() { interestingThing(); }');
    await addTs(store, 'src/elsewhere.ts', 'function go() { otherThing(); }');

    const result = rankDefinitions(store, { focusFiles: ['src/open.ts'] });

    assert.ok(
      !result.definitions.some((d) => d.path === 'src/open.ts'),
      'a file already in context must not be spent from the budget again',
    );
    const target = result.definitions.find((d) => d.ident === 'interestingThing');
    const other = result.definitions.find((d) => d.ident === 'otherThing');
    assert.ok(target && other);
    assert.ok(
      target.rank > other.rank,
      'what the open file references should outrank what it does not (x50)',
    );
  });
});

test('a definition nothing references still appears, via its self-edge', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/orphan.ts', 'export function neverCalledAnywhere(): void {}');
    await addTs(store, 'src/other.ts', 'export function alsoUnused(): void {}');

    const { definitions } = rankDefinitions(store);
    assert.ok(
      definitions.some((d) => d.ident === 'neverCalledAnywhere'),
      'an unreferenced definition should rank low, not vanish',
    );
  });
});

test('ranking is deterministic across runs', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function sharedName(): void {}');
    await addTs(store, 'src/b.ts', 'export function sharedName(): void {}');
    await addTs(store, 'src/c.ts', 'function run() { sharedName(); }');

    // Equal ranks must break ties stably, or the prompt cache is invalidated for free.
    const first = rankDefinitions(store).definitions.map((d) => `${d.path}:${d.ident}`);
    const second = rankDefinitions(store).definitions.map((d) => `${d.path}:${d.ident}`);
    assert.deepEqual(first, second);
  });
});

test('every indexed file gets a rank, including ones with no tags', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function used(): void {}');
    await addTs(store, 'src/b.ts', 'function run() { used(); }');
    store.indexFile({ path: 'src/empty.ts', language: 'typescript', source: '// nothing\n', tags: [] });

    const { files } = rankDefinitions(store);
    assert.equal(files.length, 3);
    assert.ok(files.every((f) => Number.isFinite(f.rank) && f.rank > 0), 'no file should be rank zero or NaN');
  });
});

// ------------------------------------------------------------------ budget fitting

test('fitToBudget respects the budget and reports what it used', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 40; i++) {
      await addTs(store, `src/file${i}.ts`, `export function handlerNumber${i}(): void {}`);
    }
    await addTs(
      store,
      'src/caller.ts',
      ['function run() {', ...Array.from({ length: 40 }, (_, i) => `  handlerNumber${i}();`), '}'].join('\n'),
    );

    const { definitions } = rankDefinitions(store);
    assert.ok(definitions.length > 20, 'need a decent candidate list to search');

    const fit = fitToBudget(definitions, { maxTokens: 120, countTokens: estimateTextTokens });
    assert.ok(fit.used > 0, 'something should fit in 120 tokens');
    assert.ok(fit.used < definitions.length, 'not everything should fit');
    assert.ok(fit.tokens <= 120 * 1.15, `should respect the budget within tolerance, got ${fit.tokens}`);
    assert.ok(fit.probes > 0 && fit.probes < 20, `search should be cheap, took ${fit.probes} probes`);

    // The text must be the rendering of exactly what it says it used.
    assert.equal(fit.text, renderDefinitionMap(definitions.slice(0, fit.used)));
  });
});

test('a zero or empty budget yields nothing rather than throwing', () => {
  const defs = [{ path: 'a.ts', ident: 'x', rank: 1, line: 1, kind: 'function' }];
  assert.deepEqual(fitToBudget(defs, { maxTokens: 0, countTokens: estimateTextTokens }), {
    text: '',
    tokens: 0,
    used: 0,
    probes: 0,
  });
  assert.equal(fitToBudget([], { maxTokens: 1000, countTokens: estimateTextTokens }).used, 0);
});

test('a generous budget includes everything', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function onlyOne(): void {}');
    await addTs(store, 'src/b.ts', 'function run() { onlyOne(); }');

    const { definitions } = rankDefinitions(store);
    const fit = fitToBudget(definitions, { maxTokens: 100_000, countTokens: estimateTextTokens });
    assert.equal(fit.used, definitions.length, 'a large budget should fit the whole map');
  });
});

test('the rendered map cites a real file and line for every entry', async () => {
  await withStore(async (store) => {
    const source = ['// a comment', 'export function citedFunction(): void {}'].join('\n');
    await addTs(store, 'src/cited.ts', source);
    await addTs(store, 'src/caller.ts', 'function run() { citedFunction(); }');

    const { definitions } = rankDefinitions(store);
    const cited = definitions.find((d) => d.ident === 'citedFunction');
    assert.ok(cited);
    assert.equal(cited.line, 2, 'the citation must point at the declaring line, not the file start');
    assert.match(renderDefinitionMap([cited]), /^src\/cited\.ts:\n {2}2: function citedFunction$/);
  });
});

// ------------------------------------------------------------------ index filtering

test('generated and minified files are kept out of the graph', async () => {
  const { skipReasonFor, shouldIndex, MAX_INDEXED_BYTES } = await import('../graph/indexFilter.js');

  // The case that motivated this: a minified bundle ranked #1 on aider's repo at twice the
  // next file, because thousands of identifier references sat on a handful of lines.
  assert.equal(skipReasonFor('assets/asciinema-player.min.js', 'x'.repeat(100)), 'generated-path');
  assert.equal(skipReasonFor('web/app.bundle.js', 'x'), 'generated-path');
  assert.equal(skipReasonFor('types/api.d.ts', 'x'), 'generated-path');
  assert.equal(skipReasonFor('vendor/lib.js', 'x'), 'generated-path');
  assert.equal(skipReasonFor('src/schema-generated.ts', 'x'), 'generated-path');

  // Caught by content, so a bundle that does not advertise itself is still excluded.
  const oneLongLine = 'a'.repeat(5000);
  assert.equal(skipReasonFor('src/innocent-name.js', oneLongLine), 'no-newlines');
  const fewHugeLines = ['a'.repeat(5000), 'b'.repeat(5000)].join('\n');
  assert.equal(skipReasonFor('src/also-innocent.js', fewHugeLines), 'minified-content');

  assert.equal(skipReasonFor('src/big.ts', 'x'.repeat(MAX_INDEXED_BYTES + 1)), 'too-large');

  // Ordinary source passes, including long but normally-formatted files.
  const ordinary = Array.from({ length: 400 }, (_, i) => `export function handler${i}(): void {}`).join('\n');
  assert.equal(skipReasonFor('src/real.ts', ordinary), undefined);
  assert.ok(shouldIndex('src/real.ts', ordinary));
  assert.ok(shouldIndex('src/tiny.ts', 'export const a = 1;\n'));
});

test('a skipped file is a stated exclusion, not an empty file', async () => {
  const { skipReasonFor } = await import('../graph/indexFilter.js');
  // The reason is returned rather than a bare boolean precisely so a caller can say *why* it
  // has nothing for a path - the same distinction as `absent` versus `fresh` in the store.
  const reason = skipReasonFor('x.min.js', 'anything');
  assert.equal(typeof reason, 'string');
  assert.notEqual(reason, undefined);
});
