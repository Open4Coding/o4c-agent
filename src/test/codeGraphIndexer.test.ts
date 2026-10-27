import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { indexProject, indexSource, repoRelative } from '../graph/indexer.js';
import { declaresGenerated } from '../graph/indexFilter.js';

/**
 * Building and maintaining the index.
 *
 * The behaviour worth pinning here is not "it indexes files" - that is `codeGraphStore.test.ts`'s
 * job - but the three things the tool hook depends on being true: an unchanged file is not
 * reparsed, a vanished file does not keep answering, and a file the graph cannot read is reported
 * as unreadable rather than as empty.
 */

interface Fixture {
  readonly root: string;
  readonly store: GraphStore;
}

async function withProject(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-indexer-'));
  const root = join(dir, 'project');
  await mkdir(root, { recursive: true });
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await fn({ root, store });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(root: string, rel: string, source: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, source, 'utf-8');
}

const AREA = 'export function computeArea(r: number): number { return r * r; }\n';
const USE = 'import { computeArea } from "./area.js";\nexport function go() { return computeArea(2); }\n';

// ------------------------------------------------------------------ a full pass

test('a full pass indexes the tree and the next one finds it unchanged', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/area.ts', AREA);
    await put(root, 'src/use.ts', USE);

    const first = await indexProject(store, root);
    assert.equal(first.indexed, 2, 'both TypeScript files indexed');
    assert.equal(first.unchanged, 0);
    assert.equal(store.stats().files, 2);

    // The second pass is the one that matters: it still reads both files (freshness is a hash of
    // the bytes, so there is no way to know without reading) but must skip the tree-sitter parse.
    const second = await indexProject(store, root);
    assert.equal(second.indexed, 0, 'nothing reparsed');
    assert.equal(second.unchanged, 2);
    assert.equal(second.removed, 0);
  });
});

test('an edited file is reindexed and the old definitions go', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/area.ts', AREA);
    await indexProject(store, root);
    assert.equal(store.definitionsOf('computeArea').length, 1);

    await put(root, 'src/area.ts', 'export function computeVolume(r: number): number { return r; }\n');
    const run = await indexProject(store, root);
    assert.equal(run.indexed, 1);
    assert.deepEqual(store.definitionsOf('computeArea'), [], 'the removed definition is gone');
    assert.equal(store.definitionsOf('computeVolume').length, 1);
  });
});

test('a deleted file stops answering', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/area.ts', AREA);
    await put(root, 'src/use.ts', USE);
    await indexProject(store, root);

    await rm(join(root, 'src/area.ts'));
    const run = await indexProject(store, root);
    assert.equal(run.removed, 1, 'the index drops what the walk no longer sees');
    assert.equal(store.indexedFile('src/area.ts'), undefined);
    // Serving definitions from a file that no longer exists is the one error the model has no way
    // to detect, which is why this is checked rather than assumed from `removed`.
    assert.deepEqual(store.definitionsOf('computeArea'), []);
  });
});

test('a file no bundled grammar claims is reported, not indexed', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'README.md', '# hello\n');
    await put(root, 'data.json', '{"a":1}\n');
    const run = await indexProject(store, root);

    assert.equal(run.indexed, 0);
    assert.equal(run.outcomes.get('no-grammar'), 2);
    assert.equal(store.stats().files, 0);
  });
});

test('a minified file is excluded with its reason and leaves the index', async () => {
  await withProject(async ({ root, store }) => {
    // Written as real code first so it is genuinely in the index, then replaced by the kind of
    // bundle `indexFilter.ts` exists to keep out - the transition is the interesting case.
    await put(root, 'src/area.ts', AREA);
    await indexProject(store, root);
    assert.notEqual(store.indexedFile('src/area.ts'), undefined);

    await put(root, 'src/area.ts', `${'const a=1;'.repeat(500)}\n`);
    const run = await indexProject(store, root);
    assert.equal(run.outcomes.get('minified-content'), 1);
    assert.equal(store.indexedFile('src/area.ts'), undefined, 'and it is no longer in the index');
  });
});

test('an unreadable file costs that file and not the pass', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/area.ts', AREA);
    await put(root, 'src/broken.ts', AREA);

    // Through the read seam, because every portable way to make a real read fail is something
    // `walkFiles` filters out before `indexProject` sees it. One unreadable file in a tree is not
    // a reason to have no index, and that is what is being pinned.
    const run = await indexProject(store, root, {
      readSource: async (path) => {
        if (path.endsWith('broken.ts')) throw new Error('EACCES: permission denied');
        return AREA;
      },
    });

    assert.equal(run.indexed, 1, 'the healthy file is still indexed');
    assert.equal(run.outcomes.get('failed'), 1);
    assert.equal(run.failures.length, 1);
    assert.match(run.failures[0], /^src\/broken\.ts: EACCES/);
  });
});

test('a file that reads but will not parse keeps its honestly stale rows', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/area.ts', AREA);
    await indexProject(store, root);
    assert.equal(store.definitionsOf('computeArea').length, 1);

    // The real trigger for this is a grammar that will not load (`GrammarUnavailableError` -
    // `codeGraphTags.test.ts` exists because every bundled grammar silently broke once). Forced
    // here by handing `indexSource` something that is not a string, which is the only way to fail
    // *after* the read through the one seam this function has.
    const run = await indexProject(store, root, {
      readSource: (async () => undefined) as unknown as (p: string) => Promise<string>,
    });

    assert.equal(run.outcomes.get('failed'), 1);
    assert.equal(run.removed, 0, 'a parse failure is not a deletion');
    // The rows survive, and `freshness` is what keeps them honest: the file is there and its
    // record is simply out of date, which the verdict carries. Discarding them would turn "I
    // cannot parse this today" into "this file defines nothing".
    assert.equal(store.definitionsOf('computeArea').length, 1);
    assert.equal(store.freshness('src/area.ts', `${AREA}// edited\n`), 'stale');
  });
});

// ------------------------------------------------------------------ indexSource

test('indexSource skips the parse for identical bytes and reindexes changed ones', async () => {
  await withProject(async ({ store }) => {
    assert.equal(await indexSource(store, 'src/area.ts', AREA), 'indexed');
    assert.equal(await indexSource(store, 'src/area.ts', AREA), 'unchanged');
    assert.equal(await indexSource(store, 'src/area.ts', `${AREA}// edited\n`), 'indexed');
  });
});

test('indexSource reports what it cannot or will not read', async () => {
  await withProject(async ({ store }) => {
    assert.equal(await indexSource(store, 'notes.md', '# hi\n'), 'no-grammar');
    assert.equal(await indexSource(store, 'src/big.ts', `${'const a=1;'.repeat(500)}\n`), 'minified-content');
    assert.equal(store.stats().files, 0, 'neither reached the index');
  });
});

// ------------------------------------------------------------------ repoRelative


// ------------------------------------------------------------------ generated files

const GENERATED = [
  '// Code generated by protoc-gen-ts_proto. DO NOT EDIT.',
  'import { helper } from "./helper.js";',
  'export class User { name = helper(); }',
  'export function encodeUser(u: User) { return helper(u); }',
  '',
].join('\n');

test('a file that says it is generated keeps its definitions and drops its call sites', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/user.pb.ts', GENERATED);
    const run = await indexProject(store, root);

    assert.equal(run.indexed, 1, 'it still counts as indexed');
    assert.equal(run.outcomes.get('generated-header'), 1, 'and is reported as generated');
    assert.deepEqual(store.definitionsOf('User').map((d) => d.path), ['src/user.pb.ts']);
    assert.equal(store.definitionsOf('encodeUser').length, 1);
    assert.deepEqual(store.referencesIn('src/user.pb.ts'), [], 'no call sites');
    assert.deepEqual(store.importsIn('src/user.pb.ts'), [], 'no imports');
  });
});

test('a file that stops saying it is generated gets its call sites back', async () => {
  await withProject(async ({ root, store }) => {
    await put(root, 'src/user.ts', GENERATED);
    await indexProject(store, root);
    await put(root, 'src/user.ts', GENERATED.split('\n').slice(1).join('\n'));
    const run = await indexProject(store, root);

    assert.equal(run.outcomes.get('generated-header'), undefined);
    assert.ok(store.referencesIn('src/user.ts').some((r) => r.name === 'helper'));
  });
});

test('only a strict marker near the top counts as generated', () => {
  const generated = [
    '// Code generated by protoc-gen-go. DO NOT EDIT.',
    '# Generated by the protocol buffer compiler.  DO NOT EDIT!',
    '/* Automatically @generated by tree-sitter */',
    '// Automatically generated by SWIG',
  ];
  for (const header of generated) assert.equal(declaresGenerated(`${header}\nx\n`), true, header);

  // Both hit a looser rule in the survey, and both are hand-written.
  assert.equal(declaresGenerated('# Do NOT edit or update existing history entries\n'), false);
  assert.equal(declaresGenerated('// This table is NOT auto-generated yet\n'), false);
  // A marker deep in the file is a string or a comment about generators, not a header.
  const deep = `${'line\n'.repeat(6)}// Code generated by x. DO NOT EDIT.\n`;
  assert.equal(declaresGenerated(deep), false);
  assert.equal(declaresGenerated('// Code generated by x. DO NOT EDIT.'), true, 'no newline at all');
});

test('repoRelative normalises a path into an index key', () => {
  const root = resolve('/project');
  assert.equal(repoRelative(root, 'src/area.ts'), 'src/area.ts');
  assert.equal(repoRelative(root, join(root, 'src', 'area.ts')), 'src/area.ts');
  assert.equal(repoRelative(root, 'src\\area.ts'), 'src/area.ts', 'separators are normalised');
  assert.equal(repoRelative(root, './src/./area.ts'), 'src/area.ts');
});

test('repoRelative refuses a path outside the project', () => {
  const root = resolve('/project');
  // Not an error to report: a file outside the root is genuinely none of the graph's business,
  // and the right answer is to say nothing about it rather than index a home directory.
  assert.equal(repoRelative(root, '../secrets.ts'), undefined);
  assert.equal(repoRelative(root, 'src/../../secrets.ts'), undefined);
  assert.equal(repoRelative(root, ''), undefined);
  assert.equal(repoRelative(root, root), undefined, 'the root itself is not a file in it');
});
