import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LANGUAGES, languageForPath, languageById } from '../graph/languages.js';
import { grammarDir, setGrammarDir, wasmPathFor, queryPathFor } from '../graph/grammarPaths.js';
import { initParser, loadLanguage, isKnownLanguage, GrammarUnavailableError } from '../graph/loadLanguage.js';
import { extractTags, extractTagsForPath } from '../graph/tags.js';

/**
 * Build step 1 of `docs/research/code-graph/0000.DECISION.md`: "parse a file of each default
 * language and extract tags". Revised 2026-10-18 when the bundle grew to everything loadable
 * (`0002.TOP20-LANGUAGE-POLICY.md`).
 *
 * The references half of each assertion is the point of this file, not padding. Three of the
 * shipped tag queries - C, C++ and Swift - captured **zero** references as published by aider,
 * which would have produced a graph with nodes and no edges for three of the twenty most-used
 * languages. The reference patterns in `grammars/queries/{c,cpp,swift}.scm` are authored here,
 * and these tests are what stop them silently regressing.
 *
 * The load test exists for a scarier reason: `tree-sitter-wasms@0.1.13` ships 36 grammars that
 * all fail to load under `web-tree-sitter@0.27.1`, and a size-optimising pass across grammar
 * payloads during this build swapped several working grammars for broken ones - Rust among
 * them - with no symptom other than a load-time throw. ABI compatibility is not visible in a
 * file listing, so it gets asserted.
 */

/** One small source file per registered language, each containing at least one call. */
const SAMPLES: Record<string, { source: string; path: string; defines: string[]; references: string[] }> = {
  javascript: {
    path: 'dog.js',
    source: ['class Dog { bark() { return makeSound("woof"); } }', 'function makeSound(s) { return s.toUpperCase(); }'].join('\n'),
    defines: ['Dog', 'bark', 'makeSound'],
    references: ['makeSound'],
  },
  python: {
    path: 'animal.py',
    source: ['class Animal:', '    def speak(self):', '        return make_sound("moo")', '', 'def make_sound(s):', '    return s.upper()'].join('\n'),
    defines: ['Animal', 'speak', 'make_sound'],
    references: ['make_sound'],
  },
  bash: {
    path: 'deploy.sh',
    source: ['build() {', '  make clean', '}', '', 'build', 'rsync -a ./dist/ server:/srv/'].join('\n'),
    defines: ['build'],
    references: ['build', 'make'],
  },
  typescript: {
    path: 'shapes.ts',
    source: [
      'interface Shape { area(): number; }',
      'export class Circle implements Shape {',
      '  constructor(private r: number) {}',
      '  area(): number { return computeArea(this.r); }',
      '}',
      'function computeArea(r: number): number { return square(r); }',
      'const square = (n: number) => n * n;',
    ].join('\n'),
    defines: ['Shape', 'Circle', 'computeArea'],
    references: ['computeArea', 'square'],
  },
  tsx: {
    path: 'Button.tsx',
    source: [
      'interface Props { label: string; }',
      'export function Button({ label }: Props) {',
      '  return <button onClick={() => fireEvent(label)}>{label}</button>;',
      '}',
      'function fireEvent(n: string) { report(n); }',
    ].join('\n'),
    defines: ['Props', 'Button', 'fireEvent'],
    references: ['fireEvent', 'report'],
  },
  c_sharp: {
    path: 'Circle.cs',
    source: [
      'public interface IShape { double Area(); }',
      'public class Circle : IShape {',
      '    private double r;',
      '    public double Area() { return ComputeArea(r); }',
      '    private double ComputeArea(double x) { return Square(x); }',
      '    private double Square(double n) { return n * n; }',
      '}',
    ].join('\n'),
    defines: ['IShape', 'Circle', 'Area'],
    references: ['ComputeArea', 'Square'],
  },
  java: {
    path: 'Circle.java',
    source: [
      'public class Circle {',
      '    private double r;',
      '    public double area() { return computeArea(r); }',
      '    private double computeArea(double x) { return square(x); }',
      '    private double square(double n) { return n * n; }',
      '}',
    ].join('\n'),
    defines: ['Circle', 'area', 'computeArea', 'square'],
    references: ['computeArea', 'square'],
  },
  cpp: {
    path: 'circle.cpp',
    source: [
      'namespace ns { int square(int n); }',
      'class C {',
      'public:',
      '  int area() { return compute(r_); }',
      '  int compute(int x) { return ns::square(x); }',
      'private:',
      '  int r_ = 0;',
      '};',
      'void go() { C c; c.area(); free_fn(1); }',
    ].join('\n'),
    defines: ['C', 'area', 'compute', 'go'],
    references: ['compute', 'square', 'area', 'free_fn'],
  },
  c: {
    path: 'area.c',
    source: [
      'int square(int n) { return n * n; }',
      'int compute(int r) { return square(r); }',
      'void go(void) { compute(3); helper(); }',
    ].join('\n'),
    defines: ['square', 'compute', 'go'],
    references: ['square', 'compute', 'helper'],
  },
  php: {
    path: 'Shape.php',
    source: [
      '<?php',
      'class Circle {',
      '    private $r;',
      '    public function area() { return $this->computeArea($this->r); }',
      '    private function computeArea($x) { return square($x); }',
      '}',
      'function square($n) { return $n * $n; }',
    ].join('\n'),
    defines: ['Circle', 'area', 'computeArea', 'square'],
    references: ['computeArea', 'square'],
  },
  go: {
    path: 'area.go',
    source: [
      'package main',
      'type Shape interface { Area() float64 }',
      'func computeArea(r float64) float64 { return square(r) }',
      'func square(n float64) float64 { return n * n }',
    ].join('\n'),
    defines: ['Shape', 'computeArea', 'square'],
    references: ['square'],
  },
  rust: {
    path: 'circle.rs',
    source: [
      'pub struct Circle { r: f64 }',
      'pub trait Shape { fn area(&self) -> f64; }',
      'fn compute_area(r: f64) -> f64 { square(r) }',
      'fn square(n: f64) -> f64 { n * n }',
    ].join('\n'),
    defines: ['Circle', 'Shape', 'compute_area', 'square'],
    references: ['square'],
  },
  ruby: {
    path: 'animal.rb',
    source: [
      'class Animal',
      '  def speak',
      '    make_sound("moo")',
      '  end',
      'end',
      '',
      'def make_sound(s)',
      '  s.upcase',
      'end',
    ].join('\n'),
    defines: ['Animal', 'speak', 'make_sound'],
    references: ['make_sound'],
  },
  dart: {
    path: 'circle.dart',
    source: [
      'abstract class Shape { double area(); }',
      'class Circle implements Shape {',
      '  double r = 0;',
      '  double area() => computeArea(r);',
      '  double computeArea(double x) => square(x);',
      '}',
      'double square(double n) => n * n;',
    ].join('\n'),
    defines: ['Shape', 'Circle', 'square'],
    references: ['computeArea', 'square'],
  },
  swift: {
    path: 'Circle.swift',
    source: [
      'protocol Shape { func area() -> Double }',
      'class Circle: Shape {',
      '    var r: Double = 0',
      '    func area() -> Double { return computeArea(r) }',
      '    func computeArea(_ x: Double) -> Double { return square(x) }',
      '}',
      'func square(_ n: Double) -> Double { return n * n }',
    ].join('\n'),
    defines: ['Shape', 'Circle', 'area'],
    references: ['computeArea', 'square'],
  },
};

test('every registered language parses and yields definitions and references', async () => {
  for (const lang of DEFAULT_LANGUAGES) {
    const sample = SAMPLES[lang.id];
    assert.ok(sample, `no sample source for registered language "${lang.id}"`);

    const tags = await extractTags(sample.source, lang.id);
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    const refs = tags.filter((t) => t.kind === 'ref').map((t) => t.name);

    assert.ok(defs.length > 0, `${lang.id}: no definitions extracted`);
    assert.ok(refs.length > 0, `${lang.id}: no references extracted - a graph with no edges`);

    for (const name of sample.defines) {
      assert.ok(defs.includes(name), `${lang.id}: expected a definition of "${name}", got [${defs.join(', ')}]`);
    }
    for (const name of sample.references) {
      assert.ok(refs.includes(name), `${lang.id}: expected a reference to "${name}", got [${refs.join(', ')}]`);
    }
  }
});

test('the sample set covers the registered set exactly', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), DEFAULT_LANGUAGES.map((l) => l.id).sort());
});

test('every bundled grammar is ABI-compatible with the pinned runtime', async () => {
  // `tree-sitter-wasms@0.1.13`'s 36 grammars all fail here. A grammar file that exists but
  // cannot load is invisible in a listing and fatal at use, so it is asserted.
  await initParser();
  setGrammarDir(undefined);

  const files = (await readdir(join(grammarDir(), 'wasm'))).filter((f) => f.endsWith('.wasm'));
  assert.ok(files.length >= DEFAULT_LANGUAGES.length, `only ${files.length} grammars on disk`);

  const broken: string[] = [];
  for (const file of files) {
    const id = file.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '');
    try {
      await loadLanguage(id);
    } catch {
      broken.push(id);
    }
  }
  assert.deepEqual(broken, [], `grammars present but not loadable: ${broken.join(', ')}`);
});

test('every registered language has a query file and a grammar on disk', async () => {
  const { access } = await import('node:fs/promises');
  setGrammarDir(undefined);
  for (const lang of DEFAULT_LANGUAGES) {
    await assert.doesNotReject(() => access(wasmPathFor(lang.id)), `missing grammar for ${lang.id}`);
    await assert.doesNotReject(() => access(queryPathFor(lang.id)), `missing query for ${lang.id}`);
  }
});

test('no extension is claimed by two languages', () => {
  const owner = new Map<string, string>();
  for (const lang of DEFAULT_LANGUAGES) {
    for (const ext of lang.extensions) {
      const prev = owner.get(ext);
      assert.equal(prev, undefined, `extension ${ext} claimed by both ${prev} and ${lang.id}`);
      owner.set(ext, lang.id);
    }
  }
});

test('tags carry a 1-based line and the full capture name', async () => {
  const tags = await extractTags(SAMPLES.typescript.source, 'typescript');
  const circle = tags.find((t) => t.name === 'Circle' && t.kind === 'def');

  assert.ok(circle, 'no definition of Circle');
  assert.equal(circle.line, 2, 'Circle is declared on line 2 of the sample');
  assert.ok(circle.capture.startsWith('name.definition.'), `unexpected capture ${circle.capture}`);
});

test('references are matched by capture prefix, not by exact capture name', async () => {
  // Java emits `name.reference.method` for an invocation where the others emit
  // `name.reference.call`. Keying on an exact name yields zero references for Java.
  const tags = await extractTags(SAMPLES.java.source, 'java');
  const captures = new Set(tags.filter((t) => t.kind === 'ref').map((t) => t.capture));

  assert.ok(captures.size > 0, 'java produced no reference captures at all');
  assert.ok(
    !captures.has('name.reference.call'),
    'java now emits name.reference.call - the prefix rule still holds, but this test no longer proves it',
  );
});

test('language selection is by extension, and an unknown extension is undefined', () => {
  assert.equal(languageForPath('src/cli.ts')?.id, 'typescript');
  assert.equal(languageForPath('src/ui/App.tsx')?.id, 'tsx');
  assert.equal(languageForPath('scripts/build.mjs')?.id, 'javascript');
  assert.equal(languageForPath('a/b/c.PY')?.id, 'python', 'extension match is case-insensitive');
  assert.equal(languageForPath('deploy.sh')?.id, 'bash');
  assert.equal(languageForPath('Program.cs')?.id, 'c_sharp');
  assert.equal(languageForPath('main.c')?.id, 'c');
  assert.equal(languageForPath('util.h')?.id, 'cpp', 'ambiguous .h goes to the superset grammar');

  assert.equal(languageForPath('README.md'), undefined);
  assert.equal(languageForPath('data.json'), undefined, 'no JSON grammar is bundled, on purpose');
  assert.equal(languageForPath('styles.css'), undefined, 'css grammar ships but has no query yet');
  assert.equal(languageForPath('q.sql'), undefined, 'no ABI-compatible SQL grammar exists');
  assert.equal(languageForPath('Makefile'), undefined, 'a file with no extension at all');
});

test('extractTagsForPath distinguishes "no grammar" from "no tags"', async () => {
  const unknown = await extractTagsForPath('# Heading\n', 'notes.md');
  assert.equal(unknown, undefined, 'an unparseable path must be undefined, not an empty array');

  const empty = await extractTagsForPath('// just a comment\n', 'empty.ts');
  assert.deepEqual(empty, [], 'a parsed file with nothing in it is an empty array, not undefined');
});

test('a missing grammar raises GrammarUnavailableError rather than returning nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-grammars-'));
  try {
    setGrammarDir(dir);
    await assert.rejects(() => loadLanguage('elixir'), GrammarUnavailableError);
    // The cache must not be poisoned: the same id can succeed once the directory is corrected.
    setGrammarDir(undefined);
    assert.ok(await loadLanguage('typescript'), 'a good load after a failed one must still work');
  } finally {
    setGrammarDir(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('grammar paths resolve under the bundled directory by default', async () => {
  await initParser();
  setGrammarDir(undefined);
  delete process.env.O4C_WASM_DIR;

  assert.ok(grammarDir().replace(/\\/g, '/').endsWith('/grammars'), `unexpected grammar dir ${grammarDir()}`);
  assert.ok(wasmPathFor('go').replace(/\\/g, '/').endsWith('/grammars/wasm/tree-sitter-go.wasm'));
  assert.ok(queryPathFor('go').replace(/\\/g, '/').endsWith('/grammars/queries/go.scm'));
});

test('setGrammarDir takes precedence over the environment variable', () => {
  try {
    process.env.O4C_WASM_DIR = '/from/env';
    assert.equal(grammarDir(), '/from/env');

    setGrammarDir('/explicit');
    assert.equal(grammarDir(), '/explicit', 'an explicit override must win over the env var');
  } finally {
    setGrammarDir(undefined);
    delete process.env.O4C_WASM_DIR;
  }
});

test('isKnownLanguage and languageById agree with the bundled set', () => {
  assert.ok(isKnownLanguage('typescript'));
  assert.ok(!isKnownLanguage('cobol'));
  assert.equal(languageById('rust')?.extensions[0], '.rs');
  assert.equal(languageById('cobol'), undefined);
});

test('a function assigned to a const is a definition, including the React HOC form', async () => {
  // Found by sampling unresolved call sites: aider's javascript query has this pattern and its
  // typescript one does not, so `const f = () => {}` was invisible. In modern TypeScript and
  // React that is most functions - `pushBlock` in src/ui/App.tsx had 75 call sites and no
  // definition at all.
  const source = [
    'const plainArrow = (n: number) => n * n;',
    'const funcExpr = function (n: number) { return n; };',
    'const wrapped = useCallback((lines: string[]) => lines, []);',
    'const notAFunction = compute(1, 2);',
  ].join('\n');

  const defs = (await extractTags(source, 'typescript')).filter((t) => t.kind === 'def').map((t) => t.name);

  assert.ok(defs.includes('plainArrow'), `arrow function missing from [${defs.join(', ')}]`);
  assert.ok(defs.includes('funcExpr'), 'function expression should be a definition');
  assert.ok(defs.includes('wrapped'), 'useCallback-wrapped arrow should be a definition');
  assert.ok(
    !defs.includes('notAFunction'),
    'a plain call assigned to a const is a value, not a function definition - matching on the ' +
      'arrow-function argument is what keeps this precise',
  );

  // The same patterns must be in the tsx query, since .tsx is where React code lives.
  const tsxDefs = (await extractTags(source, 'tsx')).filter((t) => t.kind === 'def').map((t) => t.name);
  assert.ok(tsxDefs.includes('plainArrow') && tsxDefs.includes('wrapped'), 'tsx query should match typescript');
});
