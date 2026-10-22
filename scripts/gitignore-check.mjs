#!/usr/bin/env node
// Checks the hand-written .gitignore matcher in src/tools/gitignore.ts against git itself.
//
// The matcher decides what `grep_files`, `glob_files` and the Code Graph can see, and the
// dangerous direction is one-sided: showing a file git ignores wastes tokens, while HIDING a file
// git tracks turns an empty search result into a false "it is not there anywhere". So the two
// directions are reported separately and only one of them is allowed to be non-zero.
//
// Not a unit test, because it needs a git binary and a real repository. It is the same move as
// grading the Code Graph against `tsc`: compare against the thing that defines the answer rather
// than against a second opinion.
//
//   node scripts/gitignore-check.mjs [repo ...]      (defaults to this repository)

import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { walkFiles } = await import(pathToFileURL(join(HERE, 'dist', 'tools', 'searchUtils.js')).href);

/** Paths git considers ignored, out of the ones given. */
async function gitIgnored(repo, paths) {
  return new Promise((resolvePromise, reject) => {
    // `--stdin -z` because a repository's path list is far longer than any command line, and
    // because a path may contain anything a filesystem allows.
    const child = spawn('git', ['check-ignore', '--stdin', '-z', '--no-index'], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      // 0 = some ignored, 1 = none ignored, anything else is a real failure.
      if (code !== 0 && code !== 1) {
        reject(new Error(`git check-ignore exited ${code}: ${err.trim()}`));
        return;
      }
      resolvePromise(new Set(out.split('\0').filter(Boolean)));
    });
    child.stdin.end(paths.join('\0'));
  });
}

let worstMissing = 0;

for (const repo of process.argv.slice(2).length ? process.argv.slice(2) : [HERE]) {
  const root = resolve(repo);
  const all = await walkFiles(root, { respectGitignore: false });
  const visible = await walkFiles(root);

  const everything = all.entries.map((e) => e.path);
  const shown = new Set(visible.entries.map((e) => e.path));
  const mine = new Set(everything.filter((p) => !shown.has(p)));
  const git = await gitIgnored(root, everything);

  // Git reports every path under an ignored directory as ignored; so does the walker, by never
  // descending. The two sets are therefore directly comparable.
  const hiddenButTracked = [...mine].filter((p) => !git.has(p));
  const shownButIgnored = [...git].filter((p) => !mine.has(p));

  console.log(`\n${root}`);
  console.log(`  paths walked ignoring nothing: ${everything.length}`);
  console.log(`  hidden by the matcher:         ${mine.size}`);
  console.log(`  ignored by git:                ${git.size}`);
  console.log(`  HIDDEN BUT NOT IGNORED BY GIT: ${hiddenButTracked.length}  <- must be 0`);
  console.log(`  ignored by git but still shown: ${shownButIgnored.length}`);

  for (const p of hiddenButTracked.slice(0, 20)) console.log(`    hidden: ${p}`);
  for (const p of shownButIgnored.slice(0, 20)) console.log(`    shown:  ${p}`);

  worstMissing = Math.max(worstMissing, hiddenButTracked.length);
}

process.exit(worstMissing === 0 ? 0 : 1);
