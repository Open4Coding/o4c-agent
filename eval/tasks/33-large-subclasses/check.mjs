import assert from 'node:assert/strict';
import { atCommit, changedFiles, check, exists, finish, pathsIn, read, run } from '../../lib/check.mjs';

function score(truth) {
  assert.ok(exists('ANSWER.md'), 'no ANSWER.md');
  const said = new Set(pathsIn(read('ANSWER.md')));
  const hit = truth.filter((f) => said.has(f));
  const extra = [...said].filter((f) => !truth.includes(f));
  const recall = hit.length / truth.length;
  const precision = said.size ? hit.length / said.size : 0;
  console.log(`truth ${truth.length}, named ${said.size}, recall ${recall.toFixed(2)}, precision ${precision.toFixed(2)}`);
  if (extra.length) console.log(`not in the truth: ${extra.slice(0, 8).join(', ')}`);
  const missed = truth.filter((f) => !said.has(f));
  if (missed.length) console.log(`missed: ${missed.slice(0, 8).join(', ')}`);
  assert.ok(recall >= 0.9 && precision >= 0.9, 'recall and precision must both be at least 0.9');
}
/** Files at the commit (not the working tree) matching a git grep pattern, tests excluded. */
function grepCommit(args) {
  const r = run('git', ['grep', '-l', ...args, 'HEAD', '--', 'src/vs', ':!**/test/**']);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, ''));
}

await check('every direct subclass of EditorModel', () => score(grepCommit(['-E', 'extends EditorModel\\b'])));

await check('nothing but ANSWER.md changed', () => assert.deepEqual(changedFiles(), ['ANSWER.md']));
finish();
