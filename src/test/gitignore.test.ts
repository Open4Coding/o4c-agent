import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IgnoreRules } from '../tools/gitignore.js';
import { walkFiles } from '../tools/searchUtils.js';

/**
 * The `.gitignore` matcher, and the walk that uses it.
 *
 * The stakes are one-sided, which is what this file is shaped around. Showing a file git ignores
 * wastes a few tokens; **hiding a file git tracks** turns an empty `grep_files` result into a
 * false "that does not exist anywhere", which is the inference this whole area exists to protect.
 * So every pattern form gets a case for what it hides *and* a case for what it must leave alone.
 *
 * These cases are the semantics `gitignore(5)` specifies. They were also checked against git
 * itself rather than against my reading of the spec: `scripts/gitignore-check.mjs` compares the
 * matcher with `git check-ignore` over every path in a repository, and on four real repositories
 * plus a purpose-built one covering negation, nesting, anchoring, `**`, character classes and
 * dir-only patterns, the two agreed on every path in both directions.
 */

function rules(...files: Array<[base: string, text: string]>): IgnoreRules {
  let r = IgnoreRules.empty();
  for (const [base, text] of files) r = r.with(base, text);
  return r;
}

function file(r: IgnoreRules, path: string): boolean {
  return r.ignores(path, false);
}

function dir(r: IgnoreRules, path: string): boolean {
  return r.ignores(path, true);
}

// ------------------------------------------------------------------ pattern forms

test('a bare pattern matches at any depth', () => {
  const r = rules(['', 'build.log\n']);
  assert.equal(file(r, 'build.log'), true);
  assert.equal(file(r, 'src/build.log'), true);
  assert.equal(file(r, 'a/b/c/build.log'), true);
  assert.equal(file(r, 'build.log.bak'), false, 'it is a whole-name match, not a prefix');
});

test('a leading slash anchors the pattern to its own directory', () => {
  const r = rules(['', '/temp\n']);
  assert.equal(file(r, 'temp'), true);
  assert.equal(file(r, 'src/temp'), false, 'anchored patterns do not float');
});

test('a slash in the middle anchors it too', () => {
  const r = rules(['', 'docs/private\n']);
  assert.equal(dir(r, 'docs/private'), true);
  assert.equal(dir(r, 'src/docs/private'), false);
});

test('a trailing slash matches a directory and never a file', () => {
  const r = rules(['', 'build/\n']);
  assert.equal(dir(r, 'build'), true);
  assert.equal(file(r, 'build'), false, 'a FILE named build is not what the pattern asked for');
});

test('comments, blank lines and trailing whitespace are not patterns', () => {
  const r = rules(['', '# a comment\n\n   \nkeep.txt   \n']);
  assert.equal(file(r, 'keep.txt'), true, 'trailing spaces are stripped from the pattern');
  assert.equal(file(r, '# a comment'), false);
});

test('a star does not cross a directory boundary but a double star does', () => {
  const r = rules(['', 'src/*.ts\nlogs/**/*.txt\n']);
  assert.equal(file(r, 'src/a.ts'), true);
  assert.equal(file(r, 'src/nested/a.ts'), false, 'one star stops at the slash');
  assert.equal(file(r, 'logs/a.txt'), true, '**/ also matches zero directories');
  assert.equal(file(r, 'logs/a/b/c.txt'), true);
});

test('a character class works and so does its negation', () => {
  const r = rules(['', 'cache[12]/\ntmp[!0-9].txt\n']);
  assert.equal(dir(r, 'cache1'), true);
  assert.equal(dir(r, 'cache2'), true);
  assert.equal(dir(r, 'cacheX'), false);
  assert.equal(file(r, 'tmpa.txt'), true);
  assert.equal(file(r, 'tmp7.txt'), false);
});

test('an escaped hash or bang is a literal first character', () => {
  const r = rules(['', '\\#weird\n\\!odd\n']);
  assert.equal(file(r, '#weird'), true);
  assert.equal(file(r, '!odd'), true);
});

test('a pattern that cannot compile is dropped rather than guessed at', () => {
  // An unbalanced `[` is a literal `[` to git. Either reading leaves the file visible, which is
  // the only safe direction for a failure here.
  const r = rules(['', 'a[b\nkeep.txt\n']);
  assert.equal(file(r, 'keep.txt'), true, 'the rest of the file still applies');
  assert.equal(file(r, 'src/other.ts'), false);
});

// ------------------------------------------------------------------ negation and precedence

test('the last matching line in a file wins, which is what makes ! work', () => {
  const r = rules(['', '*.log\n!important.log\n']);
  assert.equal(file(r, 'debug.log'), true);
  assert.equal(file(r, 'important.log'), false);
  assert.equal(file(r, 'logs/important.log'), false);
});

test('order matters: a re-include can be undone by a later line', () => {
  const r = rules(['', '*.log\n!important.log\nimportant.log\n']);
  assert.equal(file(r, 'important.log'), true);
});

test('a deeper .gitignore overrides a shallower one', () => {
  const r = rules(['', '*.test.ts\n'], ['src', '!*.test.ts\n']);
  assert.equal(file(r, 'other/a.test.ts'), true);
  assert.equal(file(r, 'src/a.test.ts'), false, 'the file in src/ re-includes it');
});

test("a nested .gitignore's patterns do not apply outside its own directory", () => {
  const r = rules(['src', 'local.ts\n']);
  assert.equal(file(r, 'src/local.ts'), true);
  assert.equal(file(r, 'src/deep/local.ts'), true);
  assert.equal(file(r, 'other/local.ts'), false);
  assert.equal(file(r, 'local.ts'), false);
});

test('no rules means nothing is ignored', () => {
  const r = IgnoreRules.empty();
  assert.equal(r.isEmpty, true);
  assert.equal(file(r, 'anything.ts'), false);
});

// ------------------------------------------------------------------ the walk

interface Walked {
  readonly paths: Set<string>;
  readonly ignored: number;
}

async function walkProject(
  files: Record<string, string>,
  options?: { respectGitignore?: boolean },
): Promise<Walked> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-ignorewalk-'));
  try {
    // A `.git` directory, because the rules only apply inside a repository - that is how the
    // walker knows where an unanchored pattern is measured from.
    await mkdir(join(root, '.git'), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const result = await walkFiles(root, options);
    return { paths: new Set(result.entries.map((e) => e.path)), ignored: result.ignored };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the walk drops ignored files and keeps the rest', async () => {
  const walked = await walkProject({
    '.gitignore': '*.log\n!keep.log\nbuild/\n',
    'app.ts': 'x',
    'debug.log': 'x',
    'keep.log': 'x',
    'build/out.js': 'x',
    'src/app.log': 'x',
  });

  assert.ok(walked.paths.has('app.ts'));
  assert.ok(walked.paths.has('keep.log'), 'the negation survives the walk');
  assert.ok(!walked.paths.has('debug.log'));
  assert.ok(!walked.paths.has('src/app.log'));
  assert.ok(!walked.paths.has('build'), 'the directory itself is not listed either');
  assert.ok(!walked.paths.has('build/out.js'), 'and nothing inside it was visited');
  assert.ok(walked.ignored >= 3, `expected a count of what was dropped, got ${walked.ignored}`);
});

test('a nested .gitignore is picked up during the walk', async () => {
  const walked = await walkProject({
    '.gitignore': 'top.txt\n',
    'top.txt': 'x',
    'src/.gitignore': 'local.txt\n',
    'src/local.txt': 'x',
    'src/kept.txt': 'x',
    'other/local.txt': 'x',
  });

  assert.ok(!walked.paths.has('src/local.txt'));
  assert.ok(walked.paths.has('src/kept.txt'));
  assert.ok(walked.paths.has('other/local.txt'), "a nested file's rules stay in its own subtree");
});

test('the ignore rules can be turned off entirely', async () => {
  const walked = await walkProject(
    { '.gitignore': '*.log\n', 'debug.log': 'x', 'app.ts': 'x' },
    { respectGitignore: false },
  );
  assert.ok(walked.paths.has('debug.log'));
  assert.equal(walked.ignored, 0);
});

test('.git/info/exclude is honoured like a root .gitignore', async () => {
  const walked = await walkProject({
    '.git/info/exclude': 'private.txt\n',
    'private.txt': 'x',
    'public.txt': 'x',
  });
  assert.ok(!walked.paths.has('private.txt'));
  assert.ok(walked.paths.has('public.txt'));
});

test('a directory that is not a repository is walked as before', async () => {
  // No `.git`, so there is nothing to consult and the old hard-coded skip of `dist` applies -
  // which is why that one is kept as a fallback rather than deleted outright.
  const root = await mkdtemp(join(tmpdir(), 'o4c-norepo-'));
  try {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'bundle.js'), 'x');
    await writeFile(join(root, '.gitignore'), 'app.ts\n');
    await writeFile(join(root, 'app.ts'), 'x');

    const { entries, ignored } = await walkFiles(root);
    const paths = new Set(entries.map((e) => e.path));
    assert.ok(paths.has('app.ts'), 'a .gitignore outside a repository is not applied');
    assert.ok(!paths.has('dist/bundle.js'));
    assert.equal(ignored, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a walk started in a subdirectory still obeys the rules above it', async () => {
  // The case that is easy to get wrong: `grep_files` with a `path` argument walks a subtree, and
  // the repository root's .gitignore still governs it.
  const root = await mkdtemp(join(tmpdir(), 'o4c-ignoresub-'));
  try {
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '*.log\nsrc/generated/\n');
    await writeFile(join(root, 'src', 'app.ts'), 'x');
    await writeFile(join(root, 'src', 'trace.log'), 'x');
    await mkdir(join(root, 'src', 'generated'), { recursive: true });
    await writeFile(join(root, 'src', 'generated', 'api.ts'), 'x');

    const { entries } = await walkFiles(join(root, 'src'));
    const paths = new Set(entries.map((e) => e.path));
    assert.ok(paths.has('app.ts'));
    assert.ok(!paths.has('trace.log'), 'an unanchored pattern from the root still applies');
    assert.ok(!paths.has('generated'), 'and so does one anchored above this directory');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
