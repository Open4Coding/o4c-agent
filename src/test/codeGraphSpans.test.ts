import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractFile } from '../graph/tags.js';
import { GraphStore, GRAPH_SCHEMA_VERSION } from '../graph/graphStore.js';

const TS = `import { x } from './x';

/**
 * Adds two numbers.
 * Used everywhere.
 */
export function add(a: number, b: number): number {
  return a + b;
}

// A counter.
export class Counter {
  private n = 0;

  /** Bumps it. */
  bump(by = 1): void {
    this.n += by;
  }
}

function bare() {}
`;

const PY = `class Shape:
    """A shape with an area."""

    def area(self):
        '''Square units.'''
        return 0


# helper below
def helper(x,
           y=2):
    return x + y
`;

test('definitions carry their span, signature and doc comment (TypeScript)', async () => {
  const defs = (await extractFile(TS, 'typescript')).tags.filter((t) => t.kind === 'def');
  const by = (name: string) => defs.find((d) => d.name === name)!;
  assert.deepEqual({ ...by('add') }, {
    name: 'add',
    kind: 'def',
    capture: by('add').capture,
    line: 7,
    endLine: 9,
    signature: 'function add(a: number, b: number): number',
    doc: 'Adds two numbers. Used everywhere.',
  });
  assert.equal(by('Counter').endLine, 19);
  assert.equal(by('Counter').doc, 'A counter.');
  assert.equal(by('bump').signature, 'bump(by = 1): void');
  assert.equal(by('bump').doc, 'Bumps it.');
  assert.equal(by('bare').doc, undefined);
  // Document order is kept, as captures() gave it.
  const lines = (await extractFile(TS, 'typescript')).tags.map((t) => t.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
});

test('Python: docstrings, comments above, and a signature over several lines', async () => {
  const defs = (await extractFile(PY, 'python')).tags.filter((t) => t.kind === 'def');
  const by = (name: string) => defs.find((d) => d.name === name)!;
  assert.equal(by('Shape').doc, 'A shape with an area.');
  assert.equal(by('Shape').endLine, 6);
  assert.equal(by('area').doc, 'Square units.');
  assert.equal(by('helper').doc, 'helper below');
  assert.equal(by('helper').signature, 'def helper(x, y=2)');
});

test('the store keeps them (rows readable like any other), and a v3 database is upgraded in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-spans-'));
  const old = join(dir, 'old.db');
  const db = new DatabaseSync(old);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, language TEXT NOT NULL, file_hash TEXT NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL, def_count INTEGER NOT NULL, ref_count INTEGER NOT NULL, index_seq INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE defs (id INTEGER PRIMARY KEY, entity_uid TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, capture TEXT NOT NULL, line INTEGER NOT NULL, content_hash TEXT NOT NULL, search_text TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('schema_version', '3');`);
  db.close();

  const store = new GraphStore(old);
  const { tags, imports } = await extractFile(TS, 'typescript');
  store.indexFile({ path: 'src/a.ts', language: 'typescript', source: TS, tags, imports });
  const [add] = store.definitionsOf('add');
  assert.equal(add!.endLine, 9);
  assert.equal(add!.signature, 'function add(a: number, b: number): number');
  assert.equal(add!.doc, 'Adds two numbers. Used everywhere.');
  assert.equal(store.definitionsIn('src/a.ts').length, tags.filter((t) => t.kind === 'def').length);
  assert.equal(GRAPH_SCHEMA_VERSION, 5); // 5: refs.receiver / receiver_type (K1), added in place by the same upgrade
  store.close();
});
