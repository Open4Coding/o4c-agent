import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { extractFile } from '../graph/tags.js';
import { fuzzyCandidates } from '../graph/fuzzy.js';
import { renderNameProjection } from '../graph/projection.js';

/** Plan 0006 B14: an absent name answers with the closest real ones. */

const SRC = `export function computeArea(r: number) { return r * r; }
export function computeVolume(r: number) { return r * r * r; }
export function parseConfigFile(p: string) { return p; }
export class UserRepository {}
export function load_user_data() { return 1; }
`;

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-fuzzy-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    const { tags, imports } = await extractFile(SRC, 'typescript');
    store.indexFile({ path: 'src/geo.ts', language: 'typescript', source: SRC, tags, imports });
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('typos, case and separators, and parts of a name find the real one', async () => {
  await withStore(async (store) => {
    const names = (q: string) => fuzzyCandidates(store, q).map((d) => d.name);
    assert.equal(names('computArea')[0], 'computeArea');
    assert.equal(names('compute_area')[0], 'computeArea');
    assert.equal(names('parseConfig')[0], 'parseConfigFile');
    assert.equal(names('UserRepo')[0], 'UserRepository');
    assert.equal(names('loadUserData')[0], 'load_user_data');
    assert.deepEqual(names('frobnicate'), []);
  });
});

test('code_graph says the closest names only when the name is absent', async () => {
  await withStore(async (store) => {
    assert.match(renderNameProjection(store, 'computArea'), /absent[\s\S]*\n {2}closest names: computeArea \(function\) src\/geo\.ts:1/);
    assert.doesNotMatch(renderNameProjection(store, 'computeArea'), /closest names/);
    assert.doesNotMatch(renderNameProjection(store, 'frobnicate'), /closest names/);
  });
});
