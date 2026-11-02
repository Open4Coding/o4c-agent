import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { indexSource } from '../graph/indexer.js';
import { renderFileProjection } from '../graph/projection.js';
import { CodeGraphComponent } from '../graph/toolHook.js';
import { createCodeGraphTool } from '../tools/codeGraph.js';

/** Plan 0006 B12: read a definition by name, and a file as a skeleton, through code_graph. */

const SHAPES = `/** Area of a circle. Radius in metres. */
export function circleArea(r: number): number {
  const pi = Math.PI;
  return pi * r * r;
}

// Squares.
export class Square {
  constructor(private side: number) {}

  /** The area. */
  area(): number {
    return this.side * this.side;
  }
}
`;

async function withProject(fn: (h: { root: string; store: GraphStore; tool: ReturnType<typeof createCodeGraphTool> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-readsym-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'shapes.ts'), SHAPES);
  const store = new GraphStore(join(root, '.o4c', GRAPH_DB_FILENAME));
  try {
    await indexSource(store, 'src/shapes.ts', SHAPES);
    const component = new CodeGraphComponent(store, root);
    await fn({ root, store, tool: createCodeGraphTool(component) });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('code_graph name + source returns the definition, numbered, read from disk', async () => {
  await withProject(async ({ tool }) => {
    const out = await tool.execute({ name: 'circleArea', source: true });
    assert.match(out, /src\/shapes\.ts:2-5\n {4}2 {2}export function circleArea\(r: number\): number \{\n {4}3 {2} {2}const pi = Math\.PI;\n {4}4 .*\n {4}5 {2}\}$/);
    assert.doesNotMatch(await tool.execute({ name: 'circleArea' }), /const pi/, 'no source unless asked');
  });
});

test('a file that moved under the index is said, not guessed around', async () => {
  await withProject(async ({ root, tool }) => {
    await writeFile(join(root, 'src', 'shapes.ts'), `// a new first line\n${SHAPES}`);
    assert.match(await tool.execute({ name: 'circleArea', source: true }), /changed since it was indexed - read it with read_file/);
  });
});

test('code_graph path gives the skeleton; the read_file annotation keeps its one-line outline', async () => {
  await withProject(async ({ store, tool }) => {
    const out = await tool.execute({ path: 'src/shapes.ts' });
    assert.match(out, /^ {2}2-5 +function circleArea\(r: number\): number - Area of a circle\.$/m);
    assert.match(out, /^ {2}8-15 +class Square - Squares\.$/m);
    assert.match(out, /^ {2}12-14 +area\(\): number - The area\.$/m);
    const annotation = renderFileProjection(store, 'src/shapes.ts', 'fresh') ?? '';
    assert.match(annotation, /2 circleArea \(function\) · 8 Square \(class\)/);
  });
});
