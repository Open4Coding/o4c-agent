import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { extractTags } from '../graph/tags.js';
import { resolveName, resolveCallEdges } from '../graph/resolve.js';
import { isAssertedCall } from '../graph/edgeKind.js';

/**
 * Resolution, and the honesty contract that goes with it.
 *
 * The verdict distinctions are the point of this file. o4c intercepts `grep`, which the model
 * trusts to be exhaustive, so "no definition found" has to be separable from "my index cannot
 * answer" - the first licenses deleting code and the second does not.
 */

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-resolve-'));
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

// ------------------------------------------------------------------ verdicts

test('a uniquely defined name resolves ok', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', 'export function computeArea(r: number): number { return r; }');
    await addTs(store, 'src/use.ts', 'function go() { computeArea(1); }');

    const result = resolveName(store, 'computeArea');
    assert.equal(result.verdict, 'ok');
    assert.equal(result.definitions.length, 1);
    assert.equal(result.definitions[0].path, 'src/area.ts');
    assert.match(result.note, /Defined once/);
  });
});

test('a name defined in several files is low_confidence, not a guess', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function helper(): void {}');
    await addTs(store, 'src/b.ts', 'export function helper(): void {}');
    await addTs(store, 'src/c.ts', 'export function helper(): void {}');

    const result = resolveName(store, 'helper');
    assert.equal(result.verdict, 'low_confidence');
    assert.equal(result.definitions.length, 3);
    assert.equal(result.scanned.candidatesFound, 3);
    // The note must say *why*, because the model has to decide whether to trust it.
    assert.match(result.note, /name alone cannot distinguish/);
    assert.match(result.note, /by name, not by type/);
  });
});

test('absent is a positive claim and carries the scan counts that back it', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function present(): void {}');

    const result = resolveName(store, 'definitelyNotHere');
    assert.equal(result.verdict, 'absent');
    assert.deepEqual(result.definitions, []);
    assert.equal(result.scanned.filesIndexed, 1);
    assert.ok(result.scanned.definitionsIndexed > 0);
    // A claim this strong has to be falsifiable - it states what was searched.
    assert.match(result.note, /1 indexed files/);
    assert.match(result.note, /without a bundled grammar are not covered/);
  });
});

test('a stale index downgrades absent to degraded', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function present(): void {}');

    const fresh = resolveName(store, 'missing', undefined, { indexStatus: 'fresh' });
    assert.equal(fresh.verdict, 'absent');

    const stale = resolveName(store, 'missing', undefined, { indexStatus: 'incomplete' });
    assert.equal(stale.verdict, 'degraded', 'absent must never be asserted over a stale index');
    assert.match(stale.note, /not evidence that none exists/);
  });
});

test('an empty index is degraded, never absent', async () => {
  await withStore(async (store) => {
    const result = resolveName(store, 'anything');
    assert.equal(result.verdict, 'degraded');
    assert.equal(result.scanned.filesIndexed, 0);
    // The failure this prevents: an unbuilt index reading as "this name exists nowhere".
    assert.notEqual(result.verdict, 'absent');
  });
});

test('a same-file definition wins even when the name is shared', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/here.ts', ['export function shared(): void {}', 'function go() { shared(); }'].join('\n'));
    await addTs(store, 'src/elsewhere.ts', 'export function shared(): void {}');
    await addTs(store, 'src/third.ts', 'export function shared(): void {}');

    // Without a referencing file, three candidates means no way to choose.
    assert.equal(resolveName(store, 'shared').verdict, 'low_confidence');

    // From inside the file that defines it, lexical scope decides.
    const scoped = resolveName(store, 'shared', 'src/here.ts');
    assert.equal(scoped.verdict, 'ok');
    assert.equal(scoped.definitions[0].path, 'src/here.ts');
    assert.match(scoped.note, /other file\(s\) define the same name/);
  });
});

test('candidate order is stable and puts the referencing file first', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/zeta.ts', 'export function dup(): void {}');
    await addTs(store, 'src/alpha.ts', 'export function dup(): void {}');

    const plain = resolveName(store, 'dup').definitions.map((d) => d.path);
    assert.deepEqual(plain, ['src/alpha.ts', 'src/zeta.ts'], 'alphabetical when nothing favours either');

    const fromZeta = resolveName(store, 'dup', 'src/zeta.ts').definitions.map((d) => d.path);
    assert.equal(fromZeta[0], 'src/zeta.ts');
  });
});

test('Windows-style paths resolve the same as POSIX ones', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/here.ts', ['export function shared(): void {}', 'function go() { shared(); }'].join('\n'));
    await addTs(store, 'src/other.ts', 'export function shared(): void {}');

    const posix = resolveName(store, 'shared', 'src/here.ts');
    const windows = resolveName(store, 'shared', 'src\\here.ts');
    assert.equal(windows.verdict, posix.verdict);
    assert.equal(windows.definitions[0].path, posix.definitions[0].path);
  });
});

// ------------------------------------------------------------------ bulk edges

test('unambiguous call sites become call edges', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', 'export function computeArea(r: number): number { return r; }');
    await addTs(store, 'src/use.ts', 'function go() { computeArea(1); }');

    const { edges, counts } = resolveCallEdges(store);
    const found = edges.find((e) => e.name === 'computeArea');

    assert.ok(found, 'the call to computeArea should resolve');
    assert.equal(found.kind, 'call');
    assert.equal(found.fromPath, 'src/use.ts');
    assert.equal(found.toPath, 'src/area.ts');
    assert.ok(counts.resolved > 0);
    assert.equal(counts.edges, edges.length);
  });
});

test('an ambiguous call site yields call_reference, which is never asserted as a call', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function shared(): void {}');
    await addTs(store, 'src/b.ts', 'export function shared(): void {}');
    await addTs(store, 'src/caller.ts', 'function go() { shared(); }');

    const { edges, counts } = resolveCallEdges(store);
    const sharedEdges = edges.filter((e) => e.name === 'shared');

    assert.equal(counts.ambiguous, 1, 'one ambiguous call site');
    assert.equal(sharedEdges.length, 2, 'both candidates are offered');
    assert.ok(sharedEdges.every((e) => e.kind === 'call_reference'));
    assert.ok(
      sharedEdges.every((e) => !isAssertedCall(e.kind)),
      'a guess must not count toward a precision figure over asserted calls',
    );
  });
});

test('a call with no in-repo definition is counted as unresolved, not invented', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'function go() { someLibraryFunction(1); }');

    const { edges, counts } = resolveCallEdges(store);
    assert.equal(counts.unresolved, 1);
    assert.equal(edges.filter((e) => e.name === 'someLibraryFunction').length, 0);
    // Reported rather than hidden: most of it is legitimate (node_modules, stdlib), but this
    // is also where a systematic extraction gap would surface first.
    assert.equal(counts.callSites, counts.resolved + counts.ambiguous + counts.unresolved);
  });
});

test('only call-shaped references are resolved, never type usages', async () => {
  await withStore(async (store) => {
    const source = [
      'interface Shape { area(): number; }',
      'export function build(): void { make(); }',
      'function make(): void {}',
      'let picked: Shape;',
    ].join('\n');
    await addTs(store, 'src/a.ts', source);

    const { edges } = resolveCallEdges(store);
    assert.ok(edges.some((e) => e.name === 'make'), 'a real call should resolve');
    assert.equal(
      edges.filter((e) => e.name === 'Shape').length,
      0,
      'a type annotation must not appear in a call-graph comparison',
    );
  });
});

test('the counts partition every call site exactly once', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/one.ts', 'export function only(): void {}');
    await addTs(store, 'src/dup1.ts', 'export function twice(): void {}');
    await addTs(store, 'src/dup2.ts', 'export function twice(): void {}');
    await addTs(
      store,
      'src/caller.ts',
      ['function go() {', '  only();', '  twice();', '  external();', '}'].join('\n'),
    );

    const { counts } = resolveCallEdges(store);
    assert.equal(
      counts.callSites,
      counts.resolved + counts.ambiguous + counts.unresolved,
      'a call site must land in exactly one bucket or the figures do not add up',
    );
    assert.ok(counts.resolved >= 1);
    assert.ok(counts.ambiguous >= 1);
    assert.ok(counts.unresolved >= 1);
  });
});

test('resolution is deterministic', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function shared(): void {}');
    await addTs(store, 'src/b.ts', 'export function shared(): void {}');
    await addTs(store, 'src/caller.ts', 'function go() { shared(); }');

    const key = (r: ReturnType<typeof resolveCallEdges>) =>
      r.edges.map((e) => `${e.fromPath}:${e.fromLine}->${e.toPath}:${e.toLine}:${e.kind}`).join('|');
    assert.equal(key(resolveCallEdges(store)), key(resolveCallEdges(store)));
  });
});

test('an empty index resolves to nothing rather than throwing', async () => {
  await withStore(async (store) => {
    const { edges, counts } = resolveCallEdges(store);
    assert.deepEqual(edges, []);
    assert.equal(counts.callSites, 0);
    assert.equal(counts.edges, 0);
  });
});
