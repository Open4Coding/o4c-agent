import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { extractTags } from '../graph/tags.js';
import { indexSource } from '../graph/indexer.js';
import { nameProjection, renderFileProjection, renderNameProjection } from '../graph/projection.js';
import { CodeGraphComponent } from '../graph/toolHook.js';
import { createCodeGraphTool } from '../tools/codeGraph.js';
import { readFileTool } from '../tools/readFile.js';
import { writeFileTool } from '../tools/writeFile.js';
import type { Tool } from '../tools/types.js';

/**
 * The tool-dispatch hook - build step 4.
 *
 * Two contracts are being held here and they pull in opposite directions, which is why they are
 * tested together:
 *
 * - **The real tool's answer is never replaced.** The index holds identifiers, not lines, so an
 *   index-backed `grep` would silently be a subset of a real one. Every test below that touches
 *   `grep_files` checks the original output survives intact.
 * - **A volunteered annotation has to earn its tokens**, so `absent` and `degraded` are dropped
 *   from the `grep` annotation - while the `code_graph` tool, where the model actually asked, must
 *   still return them in full. That asymmetry is deliberate and is pinned in both directions.
 */

const AREA = 'export function computeArea(r: number): number { return r * r; }\n';
const USE = 'export function go() { return computeArea(2); }\n';

async function withStore(fn: (store: GraphStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-projection-'));
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

/** A built-in tool as the seam sees it - only `name` is consulted. */
function builtIn(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    execute: async () => 'unused',
  };
}

// ------------------------------------------------------------------ the name projection

test('a uniquely defined name projects as ok, cited, with its call sites', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', AREA);
    await addTs(store, 'src/use.ts', USE);

    const text = renderNameProjection(store, 'computeArea');
    const [header, ...rest] = text.split('\n');
    assert.match(header, /^\[code graph\] computeArea · ok · /);
    assert.match(header, /src\/area\.ts:1/, 'the claim carries its source');
    assert.equal(rest.length, 1, 'one definition needs no candidate list');
    assert.match(rest[0], /1 call site: src\/use\.ts:1/);
  });
});

test('a shared name projects as low_confidence with every candidate', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/a.ts', 'export function render() {}\n');
    await addTs(store, 'src/b.ts', 'export function render() {}\n');
    await addTs(store, 'src/c.ts', 'export function render() {}\n');

    const { verdict, text } = nameProjection(store, 'render');
    assert.equal(verdict, 'low_confidence');
    assert.match(text, /src\/a\.ts:1 \(function\) · src\/b\.ts:1 \(function\) · src\/c\.ts:1 \(function\)/);
    assert.match(text, /by name, not by type/, 'the limit travels with the answer');
  });
});

test('an absent name says how hard it looked, and a stale index downgrades that to degraded', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', AREA);

    const fresh = nameProjection(store, 'frobnicate');
    assert.equal(fresh.verdict, 'absent');
    assert.match(fresh.text, /1 indexed files/, 'a claim of absence states its own basis');

    // The distinction the whole four-state verdict exists for: absence may only be asserted over
    // an index that is known to be complete.
    const behind = nameProjection(store, 'frobnicate', { indexStatus: 'incomplete' });
    assert.equal(behind.verdict, 'degraded');
    assert.match(behind.text, /not evidence that none exists/);
  });
});

test('a type annotation is not reported as a call site', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/t.ts', 'export interface Shape { kind: string }\n');
    await addTs(store, 'src/u.ts', 'export function f(s: Shape): Shape { return s; }\n');

    // `Shape` is referenced twice, and neither is a call. Labelling one as such here would be
    // exactly the mistake `edgeKind.ts` was written to prevent.
    assert.doesNotMatch(renderNameProjection(store, 'Shape'), /call site/);
  });
});

test('long lists are capped rather than dumped', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 9; i++) await addTs(store, `src/d${i}.ts`, 'export function render() {}\n');
    for (let i = 0; i < 9; i++) await addTs(store, `src/c${i}.ts`, 'function go() { render(); }\n');

    const text = renderNameProjection(store, 'render');
    assert.match(text, /· \+3 more$/m, 'candidates beyond the cap are counted');
    assert.match(text, /9 call sites:/, 'the total is exact even when the list is not');
    assert.match(text, /\+3 more files/);
  });
});

// ------------------------------------------------------------------ the file projection

test('a file projects as an outline with its dependents', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', AREA);
    await addTs(store, 'src/use.ts', USE);

    const text = renderFileProjection(store, 'src/area.ts', 'fresh');
    assert.ok(text);
    assert.match(text, /^\[code graph\] src\/area\.ts · 1 definition · index fresh$/m);
    assert.match(text, /1 computeArea \(function\)/);
    assert.match(text, /referenced from 1 other file$/m);
  });
});

test('a file projection claims freshness only when it can', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', AREA);

    assert.match(renderFileProjection(store, 'src/area.ts', 'stale') ?? '', /· index stale$/m);
    // `unknown` is the ranged-read case: there are no file bytes to hash, so neither word is
    // honest and the clause is omitted entirely.
    const unknown = renderFileProjection(store, 'src/area.ts', 'unknown') ?? '';
    assert.match(unknown, /· 1 definition$/m);
    assert.doesNotMatch(unknown, /index (fresh|stale)/);
  });
});

test('a file projection distinguishes not-indexed from no-grammar', async () => {
  await withStore(async (store) => {
    await addTs(store, 'src/area.ts', AREA);

    const absent = renderFileProjection(store, 'src/other.ts', 'absent') ?? '';
    assert.match(absent, /· not indexed ·/);

    // Nothing at all for a file no grammar claims. `languages.ts` requires an unparseable file to
    // report `degraded` when *asked*; volunteering "I cannot read this" on every README read would
    // spend tokens every turn to say nothing.
    assert.equal(renderFileProjection(store, 'README.md', 'absent'), undefined);
  });
});

// ------------------------------------------------------------------ the hook

interface Hooked {
  readonly root: string;
  readonly store: GraphStore;
  readonly component: CodeGraphComponent;
}

async function withHook(fn: (h: Hooked) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-toolhook-'));
  const root = join(dir, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await writeFile(join(root, 'src/area.ts'), AREA, 'utf-8');
    await writeFile(join(root, 'src/use.ts'), USE, 'utf-8');
    const component = new CodeGraphComponent(store, root);
    await component.reindex();
    await fn({ root, store, component });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const GREP_OUTPUT = 'src/use.ts:1: return computeArea(2);';

test('a grep for a bare name gets the structural answer in front of its own output', async () => {
  await withHook(async ({ component }) => {
    const out = await component.aroundTool(
      { tool: builtIn('grep_files'), input: { pattern: 'computeArea' } },
      async () => GREP_OUTPUT,
    );

    // Prepended, because grep truncates at 200 matches and the window cap truncates again - both
    // from the end, and the line saying where the thing is defined must not be the one cut.
    assert.match(out, /^\[code graph\] computeArea · ok · /);
    assert.ok(out.endsWith(`\n\n${GREP_OUTPUT}`), "grep's own answer survives verbatim");
  });
});

test('a grep the index cannot speak to is left exactly alone', async () => {
  await withHook(async ({ component }) => {
    const cases = [
      'compute.*Area', // a real regex - a different question than "where is this name"
      'computeAre', // a partial word; the index knows names, not prefixes of them
      'TODO:', // not an identifier at all
      'frobnicate', // an identifier, but absent: grep already answered exhaustively
    ];
    for (const pattern of cases) {
      const out = await component.aroundTool(
        { tool: builtIn('grep_files'), input: { pattern } },
        async () => GREP_OUTPUT,
      );
      assert.equal(out, GREP_OUTPUT, `"${pattern}" should not be annotated`);
    }
  });
});

test('a grep scoped to a subdirectory says which root the graph paths use', async () => {
  await withHook(async ({ component }) => {
    // `grep_files` reports paths relative to its own `path` argument; the graph only ever knows
    // project-relative ones. `graph/resolve.ts` beside `src/graph/resolve.ts` reads as two files,
    // so when the two roots differ the result has to say so.
    const scoped = await component.aroundTool(
      { tool: builtIn('grep_files'), input: { pattern: 'computeArea', path: 'src' } },
      async () => 'use.ts:1: return computeArea(2);',
    );
    assert.match(scoped, /\n {2}\(graph paths are relative to the project root\)\n/);

    // And says nothing when there is nothing to say, which is the ordinary case.
    for (const input of [{ pattern: 'computeArea' }, { pattern: 'computeArea', path: '.' }]) {
      const whole = await component.aroundTool(
        { tool: builtIn('grep_files'), input },
        async () => GREP_OUTPUT,
      );
      assert.doesNotMatch(whole, /relative to the project root/);
    }
  });
});

test('a word-anchored grep pattern is still a name', async () => {
  await withHook(async ({ component }) => {
    const out = await component.aroundTool(
      { tool: builtIn('grep_files'), input: { pattern: '\\bcomputeArea\\b' } },
      async () => GREP_OUTPUT,
    );
    assert.match(out, /^\[code graph\] computeArea · ok · /);
  });
});

test('reading a file appends its outline and brings the index level with the bytes read', async () => {
  await withHook(async ({ root, store, component }) => {
    // Edited behind o4c's back - a git checkout, another editor - so the index is stale and the
    // model is about to read the new bytes.
    const edited = 'export function computeArea(r: number) { return r; }\nexport function perimeter() {}\n';
    await writeFile(join(root, 'src/area.ts'), edited, 'utf-8');
    assert.equal(store.freshness('src/area.ts', edited), 'stale');

    const out = await component.aroundTool(
      { tool: builtIn('read_file'), input: { path: 'src/area.ts' } },
      async () => edited,
    );

    // Appended, not prepended: an unranged read is byte-identical to disk and `readFile.ts` goes
    // out of its way to guarantee that.
    assert.ok(out.startsWith(edited), 'the file still starts at the top, unchanged');
    assert.match(out, /\[code graph\] src\/area\.ts · 2 definitions · index fresh/);
    assert.equal(store.freshness('src/area.ts', edited), 'fresh', 'reading reindexed it, for free');
    assert.equal(store.definitionsOf('perimeter').length, 1);
  });
});

test('a ranged read makes no freshness claim, and a failed read is not annotated', async () => {
  await withHook(async ({ component }) => {
    const ranged = await component.aroundTool(
      { tool: builtIn('read_file'), input: { path: 'src/area.ts', offset: 1, limit: 1 } },
      async () => '[read_file: lines 1-1 of 2 in "src/area.ts". Use offset/limit to read another range.]\nexport function computeArea(r: number): number { return r * r; }',
    );
    assert.match(ranged, /\[code graph\] src\/area\.ts · 1 definition$/m);
    assert.doesNotMatch(ranged, /index (fresh|stale)/);

    const failed = 'Error reading file "src/nope.ts": ENOENT';
    assert.equal(
      await component.aroundTool(
        { tool: builtIn('read_file'), input: { path: 'src/nope.ts' } },
        async () => failed,
      ),
      failed,
      'an error message is what was asked for; an outline on top of it is noise',
    );
  });
});

test('reading a file that defines nothing is not annotated, but asking about it answers', async () => {
  await withHook(async ({ root, component }) => {
    const bare = 'const x = computeArea(1);\nexport default x;\n';
    await writeFile(join(root, 'src/bare.ts'), bare, 'utf-8');

    const out = await component.aroundTool(
      { tool: builtIn('read_file'), input: { path: 'src/bare.ts' } },
      async () => bare,
    );
    assert.equal(out, bare, 'a header saying "0 definitions" is a line that buys nothing');

    // Asked directly, it is an answer rather than noise - the same asymmetry as `absent` on grep.
    assert.match(await component.describeFile('src/bare.ts'), /· 0 definitions · index fresh/);
  });
});

test('a file outside the project is not annotated and not indexed', async () => {
  await withHook(async ({ component }) => {
    const out = await component.aroundTool(
      { tool: builtIn('read_file'), input: { path: '../elsewhere/secrets.ts' } },
      async () => AREA,
    );
    assert.equal(out, AREA);
  });
});

test('a successful write updates the index and a failed one does not', async () => {
  await withHook(async ({ store, component }) => {
    const content = 'export function computeArea(r: number) { return r; }\nexport function midpoint() {}\n';

    await component.aroundTool(
      { tool: builtIn('write_file'), input: { path: 'src/area.ts', content } },
      async () => `Overwrote ${content.length} characters to src/area.ts`,
    );
    assert.equal(store.definitionsOf('midpoint').length, 1, 'the write landed in the index');
    assert.equal(store.freshness('src/area.ts', content), 'fresh');

    // A failed write left the file alone, so indexing its content would make the index
    // confidently wrong about a file nobody changed.
    await component.aroundTool(
      {
        tool: builtIn('write_file'),
        input: { path: 'src/area.ts', content: 'export function neverWritten() {}\n' },
      },
      async () => 'Error writing file "src/area.ts": EACCES',
    );
    assert.deepEqual(store.definitionsOf('neverWritten'), []);
    assert.equal(store.definitionsOf('midpoint').length, 1);
  });
});

test('a shell command sends the whole index back through a pass', async () => {
  await withHook(async ({ root, component }) => {
    await writeFile(join(root, 'src/added.ts'), 'export function addedByShell() {}\n', 'utf-8');

    const out = await component.aroundTool(
      { tool: builtIn('run_shell'), input: { command: 'git checkout main' } },
      async () => 'Switched to branch main',
    );
    assert.equal(out, 'Switched to branch main', 'the shell result is untouched');

    // A shell command can change anything, including files this process never saw, so the only
    // honest response is to treat the index as behind and rebuild. Awaiting the component's own
    // promise is how a test joins the pass it kicked off - `reindex` coalesces onto the one
    // already in flight rather than starting a second.
    await component.reindex();
    assert.equal(component.status().phase, 'ready');
    assert.equal(component.describeName('addedByShell').includes('· ok ·'), true);
  });
});

test('overlapping reindex requests coalesce into one pass that runs again', async () => {
  await withHook(async ({ component }) => {
    const a = component.reindex();
    const b = component.reindex();
    const c = component.reindex();
    assert.equal(b, a, 'a request while a pass is in flight joins it');
    assert.equal(c, a);
    await a;
    assert.equal(component.status().phase, 'ready');
    // Two passes, because the requests arriving mid-pass each have to be honoured by a pass that
    // starts after they did.
    assert.ok((component.status().lastRun?.unchanged ?? 0) > 0);
  });
});

test('a tool the graph has nothing to say about passes straight through', async () => {
  await withHook(async ({ component }) => {
    const out = await component.aroundTool(
      { tool: builtIn('glob_files'), input: { pattern: 'src/**/*.ts' } },
      async () => 'src/area.ts\nsrc/use.ts',
    );
    assert.equal(out, 'src/area.ts\nsrc/use.ts');
  });
});

test('a tool proxied from an MCP server is never annotated', async () => {
  await withHook(async ({ component }) => {
    const proxied: Tool = {
      ...builtIn('grep_files'),
      mcp: {
        serverId: 'search',
        serverToolName: 'grep_files',
        reach: 'local',
        hintsTrusted: false,
        autoApprove: false,
      },
    };
    const out = await component.aroundTool(
      { tool: proxied, input: { pattern: 'computeArea' } },
      async () => GREP_OUTPUT,
    );
    assert.equal(out, GREP_OUTPUT);
  });
});

test('a broken annotation costs the annotation and not the tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-toolhook-broken-'));
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await indexSource(store, 'src/area.ts', AREA);
    const component = new CodeGraphComponent(store, dir);
    // Every query now throws. `CoreRegistry.runTool` deliberately does not catch - re-running a
    // mutating tool would be worse than a crash - so the catch has to live in the component,
    // around work that is purely additive.
    store.close();

    const out = await component.aroundTool(
      { tool: builtIn('grep_files'), input: { pattern: 'computeArea' } },
      async () => GREP_OUTPUT,
    );
    assert.equal(out, GREP_OUTPUT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ pinned tool output shapes

test('the output prefixes the hook keys off still match the real tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-prefixes-'));
  try {
    // A deliberate coupling, pinned here so a change in readFile.ts or writeFile.ts fails a test
    // instead of quietly turning an error message into a file outline, or indexing content that a
    // failed write never put on disk.
    const missing = await readFileTool.execute({ path: join(dir, 'nope.ts') });
    assert.match(missing, /^Error reading file "/);

    const long = join(dir, 'long.ts');
    await writeFile(long, 'const a = 1;\n'.repeat(10), 'utf-8');
    const ranged = await readFileTool.execute({ path: long, offset: 2, limit: 3 });
    assert.match(ranged, /^\[read_file:/);

    // Parent is a file, so creating the directory for the write fails.
    const blocked = await writeFileTool.execute({ path: join(long, 'child.ts'), content: 'x' });
    assert.match(blocked, /^Error writing file "/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the one verb

test('code_graph answers either question and says what it needs', async () => {
  await withHook(async ({ component }) => {
    const tool = createCodeGraphTool(component);
    assert.equal(tool.name, 'code_graph');
    assert.equal(tool.mutating, undefined, 'asking the index changes nothing');

    assert.match(await tool.execute({ name: 'computeArea' }), /^\[code graph\] computeArea · ok · /);
    assert.match(await tool.execute({ path: 'src/area.ts' }), /· 1 definition · index fresh/);
    assert.match(await tool.execute({}), /needs either "name" .* or "path"/);
    assert.match(await tool.execute({ path: '../outside.ts' }), /outside the project/);
    // A path with no bundled grammar is asked about here, not volunteered, so it must come back
    // as `degraded` rather than as nothing.
    assert.match(await tool.execute({ path: 'notes.md' }), /· degraded ·/);
  });
});

test('code_graph returns absent and degraded in full, unlike the grep annotation', async () => {
  await withHook(async ({ component }) => {
    const tool = createCodeGraphTool(component);
    // The asymmetry, stated as a test: the same verdict the volunteered annotation drops is the
    // most useful answer in the set when the model went and asked for it.
    assert.match(await tool.execute({ name: 'frobnicate' }), /· absent · No definition of "frobnicate"/);
  });
});

test('code_graph prefers a definition in the file the question came from', async () => {
  await withHook(async ({ root, store, component }) => {
    await writeFile(join(root, 'src/a.ts'), 'export function render() {}\n', 'utf-8');
    await writeFile(join(root, 'src/b.ts'), 'export function render() {}\n', 'utf-8');
    await component.reindex();
    assert.equal(store.definitionsOf('render').length, 2);

    const tool = createCodeGraphTool(component);
    assert.match(await tool.execute({ name: 'render' }), /· low_confidence · /);
    assert.match(
      await tool.execute({ name: 'render', from: 'src/b.ts' }),
      /· ok · Defined in the referencing file \(src\/b\.ts\)/,
    );
  });
});
