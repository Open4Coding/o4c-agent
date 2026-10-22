import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { extractFile } from '../graph/tags.js';
import { importTargets, importedTarget, isRelativeSpecifier } from '../graph/imports.js';
import { loadImportQuery } from '../graph/loadLanguage.js';
import { grammarDir } from '../graph/grammarPaths.js';
import { resolveName, resolveCallEdges } from '../graph/resolve.js';

/**
 * Import-aware disambiguation - build step 5's first half.
 *
 * Two things are being pinned here, and they pull in opposite directions.
 *
 * An import must **break a tie** a bare name cannot: that is the whole point, and the acceptance
 * measurement puts it at 365 extra correctly-resolved call sites in repomix with no loss of
 * precision.
 *
 * An import must **never rule a candidate out**. A specifier that is not relative looks like a
 * package but can be a `tsconfig` path alias, so negative reasoning here would turn a correct
 * answer into a declined or wrong one in any project configured that way. Several tests below
 * exist only to keep that asymmetry from being optimised away later.
 */

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-imports-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function addTs(store: GraphStore, path: string, source: string): Promise<void> {
  const { tags, imports } = await extractFile(source, 'typescript');
  store.indexFile({ path, language: 'typescript', source, tags, imports });
}

// ------------------------------------------------------------------ extraction

test('a named import binds the local name to the module', async () => {
  const { imports } = await extractFile("import { start } from './host.js';\n", 'typescript');
  assert.deepEqual(imports, [{ localName: 'start', module: './host.js', line: 1 }]);
});

test('several specifiers in one statement each get the module', async () => {
  const { imports } = await extractFile("import { a, b, c } from './m.js';\n", 'typescript');
  assert.deepEqual(
    imports.map((i) => i.localName).sort(),
    ['a', 'b', 'c'],
    'one binding per specifier, not one per statement',
  );
  assert.ok(imports.every((i) => i.module === './m.js'));
});

test('an alias binds the alias, never the original name', async () => {
  const { imports } = await extractFile("import { start as go } from './host.js';\n", 'typescript');
  // Binding the original would make `go()` unresolvable and `start()` resolve to something the
  // file cannot even refer to.
  assert.deepEqual(imports, [{ localName: 'go', module: './host.js', line: 1 }]);
});

test('default and namespace imports bind too', async () => {
  const source = "import host from './host.js';\nimport * as all from './all.js';\n";
  const { imports } = await extractFile(source, 'typescript');
  assert.deepEqual(
    imports.map((i) => [i.localName, i.module]),
    [
      ['host', './host.js'],
      ['all', './all.js'],
    ],
  );
});

test('a type-only import is a binding like any other', async () => {
  // The binding is real even though it exists only at compile time, and it resolves a type
  // annotation the same way a value import resolves a call.
  const { imports } = await extractFile("import type { Shape } from './shape.js';\n", 'typescript');
  assert.deepEqual(imports.map((i) => i.localName), ['Shape']);
});

test('tags and imports come out of one parse together', async () => {
  const source = "import { helper } from './h.js';\nexport function go() { return helper(); }\n";
  const { tags, imports } = await extractFile(source, 'typescript');
  assert.equal(imports.length, 1);
  assert.ok(tags.some((t) => t.kind === 'def' && t.name === 'go'));
  assert.ok(tags.some((t) => t.kind === 'ref' && t.name === 'helper'));
});

test('a language with no import query still extracts tags', async () => {
  // Thirteen of the fifteen bundled languages are in this state, so it is the normal case and
  // must not look like a failure.
  assert.equal(await loadImportQuery('python'), undefined);
  const { tags, imports } = await extractFile('def go():\n    return helper()\n', 'python');
  assert.deepEqual(imports, []);
  assert.ok(tags.length > 0, 'tags are unaffected by the absence of an import query');
});

test('every bundled import query compiles', async () => {
  // `codeGraphTags.test.ts` exists because every bundled grammar silently broke once. The same
  // applies here: a query file that does not compile throws at index time, per file.
  const files = await readdir(join(grammarDir(), 'queries'));
  const ids = files.filter((f) => f.endsWith('.imports.scm')).map((f) => f.replace('.imports.scm', ''));
  assert.ok(ids.length >= 3, `expected the ECMAScript family at least, found [${ids.join(', ')}]`);
  for (const id of ids) {
    assert.notEqual(await loadImportQuery(id), undefined, `${id}: import query did not load`);
  }
});

// ------------------------------------------------------------------ specifier -> path

test('a .js specifier is tried as .ts first, because that is what NodeNext writes', () => {
  const targets = importTargets('src/graph/startup.ts', './graphStore.js');
  assert.equal(targets[0], 'src/graph/graphStore.ts');
  assert.ok(targets.includes('src/graph/graphStore.js'), 'a real .js file is still a candidate');
});

test('an extensionless specifier tries source files and then index files', () => {
  const targets = importTargets('src/a/b.ts', '../c/d');
  assert.ok(targets.includes('src/c/d.ts'));
  assert.ok(targets.includes('src/c/d/index.ts'));
  assert.ok(targets.indexOf('src/c/d.ts') < targets.indexOf('src/c/d/index.ts'), 'file before directory');
});

test('a package specifier yields nothing to match against', () => {
  assert.equal(isRelativeSpecifier('node:path'), false);
  assert.equal(isRelativeSpecifier('web-tree-sitter'), false);
  assert.equal(isRelativeSpecifier('./host.js'), true);
  assert.deepEqual(importTargets('src/a.ts', 'node:path'), []);
  assert.deepEqual(importTargets('src/a.ts', 'react'), []);
});

test('a specifier that climbs out of the project yields nothing', () => {
  // Not an error to report: a file outside the root is genuinely not the graph's business.
  assert.deepEqual(importTargets('src/a.ts', '../../elsewhere/b.js'), []);
});

test('importedTarget picks the candidate the specifier names, or nothing', () => {
  const candidates = ['src/graph/graphStore.ts', 'src/session/store.ts'];
  assert.equal(
    importedTarget('src/graph/startup.ts', './graphStore.js', candidates),
    'src/graph/graphStore.ts',
  );
  assert.equal(importedTarget('src/graph/startup.ts', './nowhere.js', candidates), undefined);
  assert.equal(importedTarget('src/graph/startup.ts', 'some-package', candidates), undefined);
});

// ------------------------------------------------------------------ the store

test('import bindings round-trip, are replaced on reindex, and go with the file', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/use.ts', "import { start } from './host.js';\nstart();\n");
    assert.deepEqual(
      store.importsIn('src/use.ts').map((i) => [i.localName, i.module]),
      [['start', './host.js']],
    );
    assert.equal(store.importedModule('src/use.ts', 'start'), './host.js');

    // Replace, not merge: an import that has been deleted must stop answering.
    await addTs(store, 'src/use.ts', "import { stop } from './other.js';\nstop();\n");
    assert.equal(store.importedModule('src/use.ts', 'start'), undefined);
    assert.equal(store.importedModule('src/use.ts', 'stop'), './other.js');

    store.removeFile('src/use.ts');
    assert.deepEqual(store.importsIn('src/use.ts'), []);
  });
});

test('a name bound to two different modules in one file settles nothing', async () => {
  await withStore(async (store) => {
    // Not legal in one scope, so it means something is wrong - a generated file, or an index
    // mid-update. Picking one would be exactly the guess this evidence exists to avoid.
    await addTs(store, 'src/odd.ts', "import { x } from './a.js';\nimport { x as y } from './b.js';\n");
    assert.equal(store.importedModule('src/odd.ts', 'x'), './a.js');
    const rows = store.importsIn('src/odd.ts');
    assert.equal(rows.length, 2);

    await addTs(store, 'src/odd2.ts', "import { x } from './a.js';\nimport { x } from './b.js';\n");
    assert.equal(store.importedModule('src/odd2.ts', 'x'), undefined, 'two modules, no answer');
  });
});

// ------------------------------------------------------------------ resolution

const DEFINES_START = 'export function start(): void {}\n';

test('an import breaks a tie that the name alone cannot', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', "import { start } from './host.js';\nexport function go() { start(); }\n");

    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'ok', 'two candidates, but the import says which');
    assert.equal(result.definitions[0].path, 'src/host.ts');
    assert.match(result.note, /Imported from "\.\/host\.js"/);
    // The others stay in the list: the verdict is a claim about the first one, not a deletion.
    assert.equal(result.definitions.length, 2);
  });
});

test('without the import the same question is declined', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', 'export function go() { start(); }\n');

    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'low_confidence');
  });
});

test('an import pointing somewhere else is no help, and is not evidence against', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', "import { start } from 'some-package';\nstart();\n");

    // Positive evidence only. The specifier is not relative, which usually means a package - but
    // it can be a tsconfig path alias, so it must not be allowed to contradict the index.
    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'low_confidence');
    assert.equal(result.definitions.length, 2);
  });
});

test('a package import does not demote a name with a single definition', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', "import { start } from 'some-package';\nstart();\n");

    // The precision guard for the asymmetry: one candidate stays `ok`. Reading the bare
    // specifier as "the target is outside the repo" would decline a correct answer here.
    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'ok');
    assert.equal(result.definitions[0].path, 'src/host.ts');
  });
});

test('an import that settles the file but not the line stays low_confidence', async () => {
  await withStore(async (store) => {
    // `start` as both a function and a type in the target file. The import says which *file*,
    // and a caller is about to be handed a line, so this is not resolved.
    await addTs(store, 'src/host.ts', 'export function start(): void {}\nexport type start = number;\n');
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', "import { start } from './host.js';\nstart();\n");

    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'low_confidence');
  });
});

test('a definition in the referencing file still wins', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(
      store,
      'src/use.ts',
      "import { start } from './host.js';\nfunction start(): void {}\nstart();\n",
    );

    // Ordering, not a conflict: measured across both graded repositories, the same-file rule and
    // import evidence never disagreed once - 0 call sites out of 2,292 ambiguous ones. The order
    // is pinned anyway, because "never happens in two repositories" is not "cannot happen".
    const result = resolveName(store, 'start', 'src/use.ts');
    assert.equal(result.verdict, 'ok');
    assert.equal(result.definitions[0].path, 'src/use.ts');
    assert.match(result.note, /referencing file/);
  });
});

test('resolveCallEdges asserts an import-resolved call and counts it', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', "import { start } from './host.js';\nexport function go() { start(); }\n");

    const { edges, counts } = resolveCallEdges(store);
    assert.equal(counts.viaImport, 1);
    assert.equal(counts.ambiguous, 0, 'it is no longer ambiguous');

    const call = edges.filter((e) => e.fromPath === 'src/use.ts' && e.name === 'start');
    assert.equal(call.length, 1, 'one asserted edge, not one per candidate');
    assert.equal(call[0].kind, 'call');
    assert.equal(call[0].toPath, 'src/host.ts');
  });
});

test('resolveCallEdges still declines what no import settles', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/host.ts', DEFINES_START);
    await addTs(store, 'src/other.ts', DEFINES_START);
    await addTs(store, 'src/use.ts', 'export function go() { start(); }\n');

    const { edges, counts } = resolveCallEdges(store);
    assert.equal(counts.viaImport, 0);
    assert.equal(counts.ambiguous, 1);
    const emitted = edges.filter((e) => e.fromPath === 'src/use.ts' && e.name === 'start');
    assert.equal(emitted.length, 2, 'both candidates, as call_reference');
    assert.ok(emitted.every((e) => e.kind === 'call_reference'));
  });
});
