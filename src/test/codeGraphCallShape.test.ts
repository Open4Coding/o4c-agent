import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME, type DefinitionRow } from '../graph/graphStore.js';
import { extractFile } from '../graph/tags.js';
import { callShapeFor, chooseTarget, resolveCallEdges } from '../graph/resolve.js';
import { nameProjection } from '../graph/projection.js';

/**
 * Telling `f()` from `o.f()`, and the three kinds that distinction needs.
 *
 * The measurement that asked for this found the largest remaining group of both misses and wrong
 * answers was `receiver.method()`, which the index could not tell from a plain call because both
 * were stored as `name.reference.call`.
 *
 * The first attempt at it was **worse than nothing**: it sorted definitions into `function` and
 * `method` only, which put a function-typed interface property under `function` - a kind a member
 * call is not allowed to reach - and so resolved `confirmDialog.resolve(...)` to an unrelated
 * `async resolve()` in another file, nine times in one graded cell. The fix was the third kind,
 * `field`, for a function held in a property or a parameter: reachable either way, excluded by
 * neither shape. Most of this file guards that distinction, because losing it again would cost
 * precision rather than fail loudly.
 */

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-shape-'));
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

function definition(path: string, kind: string, line = 1): DefinitionRow {
  return { entityUid: `${path}:${kind}`, path, name: 'f', kind, capture: '', line, contentHash: '' };
}

// ------------------------------------------------------------------ extraction

test('a member call and a plain call are stored as different kinds', async () => {
  const { tags } = await extractFile('function go(o: X) { plain(); o.member(); }\n', 'typescript');
  const refs = tags.filter((t) => t.kind === 'ref');
  assert.equal(refs.find((r) => r.name === 'plain')?.capture, 'name.reference.call');
  assert.equal(refs.find((r) => r.name === 'member')?.capture, 'name.reference.method');
});

test('both call shapes are still call edges, not usage edges', async () => {
  // The edge kind must not change: `method` is already a call kind in `edgeKind.ts` because that
  // is the word Java's query uses for an invocation. Only the stored `kind` is new information.
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'function go(o: X) { plain(); o.member(); }\n');
    const refs = store.referencesIn('src/a.ts');
    assert.equal(refs.find((r) => r.name === 'plain')?.edgeKind, 'call');
    assert.equal(refs.find((r) => r.name === 'member')?.edgeKind, 'call');
  });
});

test('a function-typed property or parameter is a field, not a function', async () => {
  const source = [
    'export interface Dialog {',
    '  resolve: (id: string) => void;',
    '}',
    'export function run(onToken: (t: string) => void): void {}',
    'export function plain(): void {}',
  ].join('\n');
  const { tags } = await extractFile(source, 'typescript');
  const defs = new Map(tags.filter((t) => t.kind === 'def').map((t) => [t.name, t.capture]));
  assert.equal(defs.get('resolve'), 'name.definition.field');
  assert.equal(defs.get('onToken'), 'name.definition.field');
  assert.equal(defs.get('plain'), 'name.definition.function', 'a declaration is still a function');
});

// ------------------------------------------------------------------ the shape of a reference

test('a call shape is only read from a language whose query distinguishes them', () => {
  assert.equal(callShapeFor('typescript', 'call'), 'bare');
  assert.equal(callShapeFor('typescript', 'method'), 'member');
  assert.equal(callShapeFor('tsx', 'method'), 'member');
  assert.equal(callShapeFor('javascript', 'method'), 'member');

  // Java's query emits `name.reference.method` for *every* invocation and Python's emits
  // `name.reference.call` for every one, so in neither does the kind say anything about shape.
  // Reading the ECMAScript meaning into them would narrow by a distinction never made.
  assert.equal(callShapeFor('java', 'method'), undefined);
  assert.equal(callShapeFor('python', 'call'), undefined);
  assert.equal(callShapeFor('typescript', 'type'), undefined, 'a type reference is not a call');
});

// ------------------------------------------------------------------ narrowing

test('a member call cannot reach a top-level function', () => {
  const chosen = chooseTarget([definition('src/a.ts', 'function'), definition('src/b.ts', 'method')], {
    callShape: 'member',
  });
  assert.equal(chosen?.route, 'call-shape');
  assert.equal(chosen?.definition.path, 'src/b.ts');
});

test('a plain call cannot reach a method', () => {
  const chosen = chooseTarget([definition('src/a.ts', 'function'), definition('src/b.ts', 'method')], {
    callShape: 'bare',
  });
  assert.equal(chosen?.route, 'call-shape');
  assert.equal(chosen?.definition.path, 'src/a.ts');
});

test('a field is reachable by either shape and is never excluded', () => {
  // The nine-wrong-answers case. Both calls below must decline, because a field and the other
  // kind are both reachable and nothing says which.
  const candidates = [definition('src/a.ts', 'field'), definition('src/b.ts', 'method')];
  assert.equal(chooseTarget(candidates, { callShape: 'member' }), undefined);
  assert.equal(
    chooseTarget([definition('src/a.ts', 'field'), definition('src/b.ts', 'function')], {
      callShape: 'bare',
    }),
    undefined,
  );
});

test('a call no candidate can take is declined, not given the only namesake', () => {
  // `s.trim()` with one top-level `function trim` in the index is a call into a library. Asserting
  // it was most of what the stricter grading line found on 2026-10-27.
  assert.equal(chooseTarget([definition('src/a.ts', 'function')], { callShape: 'member' }), undefined);
  assert.equal(chooseTarget([definition('src/a.ts', 'method')], { callShape: 'bare' }), undefined);
});

test('a member call reaches a top-level function through a module the file imported', () => {
  const functions = [definition('src/a.ts', 'function'), definition('src/b.ts', 'function')];
  const chosen = chooseTarget(functions, {
    callShape: 'member',
    fromPath: 'src/use.ts',
    importedModules: ['./b.js', 'node:path'],
  });
  assert.equal(chosen?.route, 'import', '`ns.f()` after `import * as ns from "./b.js"`');
  assert.equal(chosen?.definition.path, 'src/b.ts');
  assert.equal(chosen?.module, './b.js');
  // Both files imported: the receiver could be either module object, so the call is declined.
  assert.equal(
    chooseTarget(functions, { callShape: 'member', fromPath: 'src/use.ts', importedModules: ['./a.js', './b.js'] }),
    undefined,
  );
});

test('an unknown shape narrows nothing', () => {
  const candidates = [definition('src/a.ts', 'function'), definition('src/b.ts', 'method')];
  assert.equal(chooseTarget(candidates, {}), undefined, 'still ambiguous without the shape');
});

// ------------------------------------------------------------------ order within the ladder

test('the shape narrows before the same-file rule, not after', async () => {
  await withStore(async (store) => {
    // `go()` is a plain call, and the referencing file's own `go` is a method. Were the same-file
    // rule to run first it would answer with the method, which a plain call cannot reach.
    await addTs(store, 'src/target.ts', 'export function go(): void {}\n');
    await addTs(
      store,
      'src/caller.ts',
      ['class Holder {', '  go(): void {}', '}', 'export function run() { go(); }'].join('\n'),
    );

    const { edges, counts } = resolveCallEdges(store);
    assert.equal(counts.viaCallShape, 1);
    const call = edges.filter((e) => e.fromPath === 'src/caller.ts' && e.name === 'go');
    assert.equal(call.length, 1);
    assert.equal(call[0].kind, 'call');
    assert.equal(call[0].toPath, 'src/target.ts');
  });
});

test('a same-file definition the shape allows still wins', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/other.ts', 'export function go(): void {}\n');
    await addTs(store, 'src/caller.ts', 'function go(): void {}\nexport function run() { go(); }\n');

    const { counts } = resolveCallEdges(store);
    assert.equal(counts.viaCallShape, 0, 'the shape allowed both, so the same-file rule decided');
    assert.equal(counts.resolved, 1);
  });
});

test('the counts separate the two rules, so each can be judged alone', async () => {
  await withStore(async (store) => {
    // One call resolved by shape, one by import, in one index - the two are independent and the
    // measurement reports them separately because they turned out to help different repositories.
    await addTs(store, 'src/target.ts', 'export function shaped(): void {}\n');
    await addTs(store, 'src/holder.ts', 'class H {\n  shaped(): void {}\n}\n');
    await addTs(store, 'src/host.ts', 'export function imported(): void {}\n');
    await addTs(store, 'src/other.ts', 'export function imported(): void {}\n');
    await addTs(
      store,
      'src/caller.ts',
      ["import { imported } from './host.js';", 'export function run() { shaped(); imported(); }'].join('\n'),
    );

    const { counts } = resolveCallEdges(store);
    assert.equal(counts.viaCallShape, 1);
    assert.equal(counts.viaImport, 1);
    assert.equal(counts.ambiguous, 0);
  });
});

// ------------------------------------------------------------------ type-only namesakes

const CALL = { isCall: true } as const;

test('a call cannot reach a TypeScript type alias or interface', () => {
  // The stub that sent a "who calls this" question back to grep: `type f = any` beside the real
  // function. No call reaches a type, so the function is the answer.
  const chosen = chooseTarget([definition('src/stub/f.ts', 'type'), definition('src/f.ts', 'function')], CALL);
  assert.equal(chosen?.route, 'callable');
  assert.equal(chosen?.definition.path, 'src/f.ts');
  assert.equal(
    chooseTarget([definition('src/a.ts', 'interface'), definition('src/b.tsx', 'function')], CALL)?.definition.path,
    'src/b.tsx',
  );
});

test('a bare name question does not apply the type-only rule', () => {
  // The name may be used as a type, so picking the function would be a claim the index cannot back.
  assert.equal(chooseTarget([definition('src/stub/f.ts', 'type'), definition('src/f.ts', 'function')]), undefined);
});

test('the type-only rule is per language and never empties the list', () => {
  // Go's `T(x)` is a conversion recorded as a call, so a Go type stays a candidate.
  assert.equal(chooseTarget([definition('a.go', 'type'), definition('b.go', 'function')], CALL), undefined);
  // Only types: the rule narrows nothing rather than declining or choosing.
  assert.equal(chooseTarget([definition('src/a.ts', 'type'), definition('src/b.ts', 'interface')], CALL), undefined);
  assert.equal(chooseTarget([definition('src/a.ts', 'type')], CALL)?.route, 'unique');
});

test('each language excludes only what it cannot call', () => {
  const pick = (a: DefinitionRow, b: DefinitionRow) => chooseTarget([a, b], CALL)?.definition.path;
  assert.equal(pick(definition('A.java', 'interface'), definition('B.java', 'method')), 'B.java');
  assert.equal(pick(definition('a.rs', 'interface'), definition('b.rs', 'function')), 'b.rs', 'a trait');
  assert.equal(pick(definition('a.rs', 'module'), definition('b.rs', 'function')), 'b.rs', 'a mod');
  assert.equal(pick(definition('A.cs', 'module'), definition('B.cs', 'method')), 'B.cs', 'a namespace');
  assert.equal(pick(definition('a.swift', 'interface'), definition('b.swift', 'function')), 'b.swift', 'a protocol');
  assert.equal(pick(definition('a.rb', 'module'), definition('b.rb', 'method')), 'b.rb');
  assert.equal(pick(definition('a.ts', 'enum'), definition('b.ts', 'function')), 'b.ts');
  assert.equal(pick(definition('a.ts', 'module'), definition('b.ts', 'function')), 'b.ts', 'a namespace');
  // Callable in their language, so they stay candidates: a Rust tuple struct, a Dart typedef,
  // a C++ typedef (functional cast), a Python class.
  assert.equal(pick(definition('a.rs', 'class'), definition('b.rs', 'function')), undefined);
  assert.equal(pick(definition('a.dart', 'type'), definition('b.dart', 'function')), undefined);
  assert.equal(pick(definition('a.cpp', 'type'), definition('b.cpp', 'function')), undefined);
  assert.equal(pick(definition('a.py', 'class'), definition('b.py', 'function')), undefined);
});

test('two callable definitions stay ambiguous beside a type', () => {
  const candidates = [definition('src/a.ts', 'function'), definition('src/b.ts', 'function'), definition('src/c.ts', 'type')];
  assert.equal(chooseTarget(candidates, CALL), undefined);
});

test('call edges resolve past a type-only namesake', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/stub/f.ts', 'export type helper = any;\n');
    await addTs(store, 'src/f.ts', 'export function helper(): void {}\n');
    await addTs(store, 'src/use.ts', 'function go(): void { helper(); }\n');
    const { edges, counts } = resolveCallEdges(store);
    const edge = edges.find((e) => e.name === 'helper');
    assert.equal(edge?.kind, 'call');
    assert.equal(edge?.toPath, 'src/f.ts');
    assert.equal(counts.viaCallable, 1);
    assert.equal(counts.ambiguous, 0);
  });
});

test('the projection lists call sites past a type-only namesake', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/stub/f.ts', 'export type helper = any;\n');
    await addTs(store, 'src/f.ts', 'export function helper(): void {}\n');
    await addTs(store, 'src/use.ts', "import { helper } from './f.js';\nhelper();\n");
    const { verdict, text } = nameProjection(store, 'helper');
    assert.equal(verdict, 'low_confidence', 'the name itself is still shared with a type');
    assert.match(text, /only src\/f\.ts:1 can be called - the others are types/);
    assert.match(text, /src\/use\.ts:2/, 'the call site is listed');
  });
});

test('nothing is attributed when there are no calls to attribute', async () => {
  // An interface the query also files as a class: no call sites, so no "can be called" claim.
  await withStore(async (store) => {
    await addTs(store, 'src/t.ts', 'export interface Shape { kind: string }\n');
    await addTs(store, 'src/u.ts', 'export function f(s: Shape): Shape { return s; }\n');
    assert.doesNotMatch(nameProjection(store, 'Shape').text, /can be called|call site/);
  });
});
