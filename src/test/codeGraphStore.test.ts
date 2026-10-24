import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GraphStore,
  GRAPH_DB_FILENAME,
  LEGACY_GRAPH_DB_FILENAME,
  migrateLegacyIndex,
} from '../graph/graphStore.js';
import { extractTags } from '../graph/tags.js';
import { entityUid, contentHash, fileHash, normalisePath, kindFromCapture } from '../graph/entityId.js';
import { edgeKindForCapture, isAssertedCall } from '../graph/edgeKind.js';
import { splitIdentifier, searchTextFor } from '../graph/identifierSplit.js';
import { dbDirFor } from '../session/projectContext.js';
import { INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';

/**
 * Build step 2 of `docs/research/code-graph/0000.DECISION.md`: tag extraction into
 * `.o4c/db/datagraph.db`, WAL, content-hash keyed, with an FTS5 capability check.
 */

async function withStore(fn: (store: GraphStore, dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const TS_SOURCE = [
  'interface Shape { area(): number; }',
  'export class Circle implements Shape {',
  '  constructor(private r: number) {}',
  '  area(): number { return computeArea(this.r); }',
  '}',
  'function computeArea(r: number): number { return square(r); }',
  'const square = (n: number) => n * n;',
  // The type annotation and the `new` are here deliberately: they are the only things in this
  // sample that produce *usage* references rather than calls, which is what the edge-kind split
  // has to be tested against. An `implements` clause does not - the TypeScript query does not
  // capture it at all.
  'let picked: Shape = new Circle(1);',
].join('\n');

// ---------------------------------------------------------------- identity

test('entityUid is stable across line drift but changes with name, kind, path or language', () => {
  const base = { language: 'typescript', path: 'src/a.ts', kind: 'function', name: 'computeArea' };
  const uid = entityUid(base);

  // The identity carries no line, so inserting code above an entity cannot change it.
  assert.equal(entityUid({ ...base }), uid, 'identity must be deterministic');

  assert.notEqual(entityUid({ ...base, name: 'computeAreaV2' }), uid);
  assert.notEqual(entityUid({ ...base, kind: 'method' }), uid);
  assert.notEqual(entityUid({ ...base, path: 'src/b.ts' }), uid);
  assert.notEqual(entityUid({ ...base, language: 'javascript' }), uid);
  assert.notEqual(entityUid({ ...base, scope: ['Circle'] }), uid, 'scope distinguishes same-named methods');
});

test('entityUid treats Windows and POSIX separators as the same path', () => {
  assert.equal(
    entityUid({ language: 'typescript', path: 'src\\ui\\App.ts', kind: 'function', name: 'f' }),
    entityUid({ language: 'typescript', path: 'src/ui/App.ts', kind: 'function', name: 'f' }),
  );
  assert.equal(normalisePath('./src\\a.ts'), 'src/a.ts');
});

test('contentHash ignores trailing whitespace and surrounding blank lines, not indentation', () => {
  assert.equal(contentHash('function f() {}'), contentHash('function f() {}   '));
  assert.equal(contentHash('function f() {}'), contentHash('\n\nfunction f() {}\n\n'));
  assert.notEqual(
    contentHash('def f():\n    return 1'),
    contentHash('def f():\nreturn 1'),
    'indentation is semantic in Python and must not be normalised away',
  );
});

test('the uid/hash pair classifies modified versus moved', () => {
  const a = { language: 'typescript', path: 'src/a.ts', kind: 'function', name: 'f' };
  const b = { ...a, path: 'src/b.ts' };

  // Same place, different body -> modified in place.
  assert.equal(entityUid(a), entityUid({ ...a }));
  assert.notEqual(contentHash('return 1'), contentHash('return 2'));

  // Different place, identical body -> moved. This is the case `path:line` cannot express.
  assert.notEqual(entityUid(a), entityUid(b));
  assert.equal(contentHash('return 1'), contentHash('return 1'));
});

test('kindFromCapture reads the suffix and tolerates a malformed capture', () => {
  assert.equal(kindFromCapture('name.definition.function'), 'function');
  assert.equal(kindFromCapture('name.reference.call'), 'call');
  assert.equal(kindFromCapture('name.definition.ocaml.module'), 'ocaml.module');
  assert.equal(kindFromCapture('weird'), 'unknown', 'a third-party query must not throw');
});

// ---------------------------------------------------------------- edge kinds

test('only call-shaped captures become call edges', () => {
  for (const capture of ['name.reference.call', 'name.reference.method', 'name.reference.send']) {
    assert.equal(edgeKindForCapture(capture), 'call', capture);
  }
  // The measured failure this prevents: lidx reported 410 of 454 TypeScript false positives as
  // constants and variables read in a function, recorded as CALLS.
  for (const capture of ['name.reference.class', 'name.reference.type', 'name.reference.interface', 'name.reference.implementation']) {
    assert.equal(edgeKindForCapture(capture), 'usage', capture);
  }
});

test('call_reference is never asserted as a call', () => {
  assert.ok(isAssertedCall('call'));
  assert.ok(!isAssertedCall('usage'));
  assert.ok(!isAssertedCall('call_reference'), 'an unresolved call must not be served as a call');
});

// ---------------------------------------------------------------- identifier splitting

test('identifiers split on camel, snake, kebab and acronym boundaries', () => {
  assert.deepEqual(splitIdentifier('parseFile'), ['parseFile', 'parse', 'File']);
  assert.deepEqual(splitIdentifier('parse_file'), ['parse_file', 'parse', 'file']);
  assert.deepEqual(splitIdentifier('parse-file'), ['parse-file', 'parse', 'file']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['HTTPServer', 'HTTP', 'Server']);
  assert.deepEqual(splitIdentifier('parseHTTPFile'), ['parseHTTPFile', 'parse', 'HTTP', 'File']);
  assert.deepEqual(splitIdentifier('__dunder__'), ['__dunder__', 'dunder']);
  assert.deepEqual(splitIdentifier('simple'), ['simple'], 'no spurious duplicate of the whole');
  assert.equal(searchTextFor('parseFile'), 'parseFile parse File');
});

// ---------------------------------------------------------------- the store

test('indexing a file stores its definitions and references', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });

    const stats = store.stats();
    assert.equal(stats.files, 1);
    assert.ok(stats.defs > 0, 'no definitions stored');
    assert.ok(stats.refs > 0, 'no references stored');
    assert.ok(stats.calls > 0, 'no call edges classified');
    assert.ok(stats.calls <= stats.refs, 'calls are a subset of references');

    const defs = store.definitionsOf('computeArea');
    assert.equal(defs.length, 1);
    assert.equal(defs[0].path, 'src/shapes.ts');
    assert.equal(defs[0].kind, 'function');
    assert.ok(defs[0].entityUid.length === 32, 'uid should be stored');

    const refs = store.referencesTo('square');
    assert.ok(refs.length > 0, 'square is called but has no reference row');
  });
});

test('re-indexing replaces a file rather than accumulating duplicates', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    const first = store.stats();

    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    assert.deepEqual(store.stats(), first, 're-indexing the same file must be idempotent');

    // A smaller version of the file must *remove* what is gone, not merge.
    const smaller = 'function computeArea(r: number): number { return r; }';
    store.indexFile({
      path: 'src/shapes.ts',
      language: 'typescript',
      source: smaller,
      tags: await extractTags(smaller, 'typescript'),
    });
    assert.equal(store.definitionsOf('Circle').length, 0, 'a deleted definition must not survive');
    assert.equal(store.definitionsOf('computeArea').length, 1);
  });
});

test('freshness distinguishes fresh, stale and never-indexed', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });

    assert.equal(store.freshness('src/shapes.ts', TS_SOURCE), 'fresh');
    assert.equal(store.freshness('src/shapes.ts', TS_SOURCE + '\n// edited\n'), 'stale');
    assert.equal(
      store.freshness('src/never.ts', 'anything'),
      'absent',
      'never-indexed must be distinct from stale, or unindexed reads as empty',
    );
  });
});

test('removeFile forgets a file and its rows', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    store.removeFile('src/shapes.ts');

    assert.deepEqual(store.stats(), { files: 0, defs: 0, refs: 0, calls: 0 }, 'cascade should clear rows');
    assert.equal(store.freshness('src/shapes.ts', TS_SOURCE), 'absent');
  });
});

test('callsOnly narrows references to asserted call sites', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });

    // `Shape` appears only as a type annotation - a usage, never a call.
    const all = store.referencesTo('Shape');
    const calls = store.referencesTo('Shape', true);
    assert.ok(all.length > 0, 'Shape should be referenced as a type');
    assert.equal(
      all.every((r) => r.edgeKind === 'usage'),
      true,
      'a type annotation is not a call',
    );
    assert.equal(calls.length, 0, 'a type annotation must not appear as a call edge');

    // And the converse: computeArea is called, so it must survive callsOnly.
    assert.ok(store.referencesTo('computeArea', true).length > 0, 'a real call must survive callsOnly');
  });
});

test('name search is camel-aware and reports whether FTS5 is present', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });

    // Whether or not FTS5 was compiled in, a partial-word search must find computeArea -
    // that is the point of pre-splitting search_text.
    const hits = store.searchDefinitions('compute');
    assert.ok(
      hits.some((h) => h.name === 'computeArea'),
      `"compute" should find computeArea (fts=${store.ftsAvailable}); got [${hits.map((h) => h.name).join(', ')}]`,
    );

    assert.deepEqual(store.searchDefinitions('   '), [], 'a blank query returns nothing, not everything');
    assert.equal(typeof store.ftsAvailable, 'boolean');
  });
});

test('a search query containing FTS5 operator characters does not throw', async () => {
  await withStore(async (store) => {
    const tags = await extractTags(TS_SOURCE, 'typescript');
    store.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    for (const nasty of ['compute OR area', 'a"b', 'NEAR(x y)', '*', '-foo', 'x:y']) {
      assert.doesNotThrow(() => store.searchDefinitions(nasty), `threw on ${nasty}`);
    }
  });
});

test('the database is in WAL mode and survives reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    const path = join(dir, GRAPH_DB_FILENAME);
    const first = new GraphStore(path);
    const tags = await extractTags(TS_SOURCE, 'typescript');
    first.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    const before = first.stats();
    first.checkpoint();
    first.close();

    // WAL sidecars appear next to the database, which is what `dbDirFor`'s comment promises.
    const names = await readdir(dir);
    assert.ok(names.includes(GRAPH_DB_FILENAME));

    const second = new GraphStore(path);
    try {
      assert.deepEqual(second.stats(), before, 'data must survive a close/reopen');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('indexing several languages into one store keeps them distinct', async () => {
  await withStore(async (store) => {
    const py = 'def speak():\n    return make_sound("moo")\n\ndef make_sound(s):\n    return s';
    const go = 'package main\nfunc computeArea(r float64) float64 { return square(r) }\nfunc square(n float64) float64 { return n }';

    store.indexFile({ path: 'a.py', language: 'python', source: py, tags: await extractTags(py, 'python') });
    store.indexFile({ path: 'b.go', language: 'go', source: go, tags: await extractTags(go, 'go') });

    assert.equal(store.stats().files, 2);
    assert.equal(store.definitionsIn('a.py').length > 0, true);
    assert.equal(store.definitionsIn('b.go').length > 0, true);
    assert.ok(store.referencesIn('a.py').some((r) => r.name === 'make_sound'));

    // Same-named entities in different languages must not collide.
    const languages = new Set(store.files().map((f) => f.language));
    assert.deepEqual([...languages].sort(), ['go', 'python']);
  });
});

test('a schema-version mismatch discards the derived index rather than migrating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    const path = join(dir, GRAPH_DB_FILENAME);
    const first = new GraphStore(path);
    const tags = await extractTags(TS_SOURCE, 'typescript');
    first.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    assert.equal(first.stats().files, 1);
    first.close();

    // Simulate an older index written by a previous schema.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    raw.close();

    const second = new GraphStore(path);
    try {
      assert.equal(second.stats().files, 0, 'a stale schema should be cleared, not read');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the .o4c/db layout

test('both databases live in .o4c/db with distinct filenames', () => {
  const dir = dbDirFor('/project');
  assert.ok(dir);
  assert.equal(dir.replace(/\\/g, '/'), '/project/.o4c/db');
  assert.equal(dbDirFor(undefined), undefined, 'no project root means no database location');

  assert.equal(GRAPH_DB_FILENAME, 'datagraph.db');
  assert.equal(INFINITE_CONTEXT_DB_FILENAME, 'history.db');
  assert.notEqual(
    GRAPH_DB_FILENAME,
    INFINITE_CONTEXT_DB_FILENAME,
    'separate files: WAL allows one writer per database, and the graph is disposable while history is not',
  );
});

// ------------------------------------------------- renaming graph.db -> datagraph.db

test('an index written under the old name is moved, not abandoned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    // A real index under the pre-2026-10-24 name.
    const legacy = new GraphStore(join(dir, LEGACY_GRAPH_DB_FILENAME));
    const tags = await extractTags(TS_SOURCE, 'typescript');
    legacy.indexFile({ path: 'src/shapes.ts', language: 'typescript', source: TS_SOURCE, tags });
    const before = legacy.stats();
    legacy.checkpoint();
    legacy.close();

    migrateLegacyIndex(dir);

    const names = await readdir(dir);
    assert.ok(names.includes(GRAPH_DB_FILENAME), 'the new name exists');
    assert.ok(!names.includes(LEGACY_GRAPH_DB_FILENAME), 'and the old one is gone, not orphaned');

    // The point of moving rather than deleting: the index survives, so no cold pass is owed.
    const moved = new GraphStore(join(dir, GRAPH_DB_FILENAME));
    try {
      assert.deepEqual(moved.stats(), before);
    } finally {
      moved.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the write-ahead log moves with the database it belongs to', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    // SQLite matches these to a database by filename, so a rename that left them behind would
    // strand whatever had not been checkpointed.
    await writeFile(join(dir, LEGACY_GRAPH_DB_FILENAME), 'db', 'utf-8');
    await writeFile(join(dir, `${LEGACY_GRAPH_DB_FILENAME}-wal`), 'wal', 'utf-8');
    await writeFile(join(dir, `${LEGACY_GRAPH_DB_FILENAME}-shm`), 'shm', 'utf-8');

    migrateLegacyIndex(dir);

    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, [
      GRAPH_DB_FILENAME,
      `${GRAPH_DB_FILENAME}-shm`,
      `${GRAPH_DB_FILENAME}-wal`,
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live index is never clobbered by an older leftover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    await writeFile(join(dir, GRAPH_DB_FILENAME), 'the live one', 'utf-8');
    await writeFile(join(dir, LEGACY_GRAPH_DB_FILENAME), 'leftovers', 'utf-8');

    migrateLegacyIndex(dir);

    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(dir, GRAPH_DB_FILENAME), 'utf-8'), 'the live one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing to move, and nowhere to move it, are both quiet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-graph-'));
  try {
    // The common case by far - every project created after the rename.
    assert.doesNotThrow(() => migrateLegacyIndex(dir));
    assert.deepEqual(await readdir(dir), []);
    // And a directory that does not exist at all: this runs before the store creates it.
    assert.doesNotThrow(() => migrateLegacyIndex(join(dir, 'absent')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
