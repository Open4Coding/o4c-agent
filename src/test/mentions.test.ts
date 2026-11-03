import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeMention, expandMentions, mentionCandidates, mentionPrefix, parseMentions } from '../ui/mentions.js';

/** Plan 0006 E6: @file and @file:10-40 attach contents; typing @ suggests and Tab completes. */

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'o4c-mention-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  writeFileSync(join(root, 'README.md'), '# readme');
  return root;
}

test('only existing files count; ranges are parsed; trailing punctuation is not part of the path', () => {
  const root = project();
  const m = parseMentions('see @src/app.ts:10-12 and @README.md, ask @someone, mail a@b.com', root);
  assert.deepEqual(m.map((x) => [x.path, x.from, x.to]), [['src/app.ts', 10, 12], ['README.md', undefined, undefined]]);
});

test('the message keeps what was typed and gets the contents after it, numbered', () => {
  const root = project();
  const out = expandMentions('why does @src/app.ts:10-12 fail?', root);
  assert.match(out, /^why does @src\/app\.ts:10-12 fail\?\n\n\[Attached by o4c for the @ mentions above\]\n--- @src\/app\.ts lines 10-12 ---\n {3}10 {2}line 10\n {3}11 {2}line 11\n {3}12 {2}line 12$/);
  assert.equal(expandMentions('no mentions here', root), 'no mentions here');
  assert.match(expandMentions('@src/app.ts:7', root), /lines 7-7 ---\n {4}7 {2}line 7$/);
});

test('typing @ suggests files, Tab completes the first', () => {
  assert.equal(mentionPrefix('look at @src/a'), 'src/a');
  assert.equal(mentionPrefix('look at @'), '');
  assert.equal(mentionPrefix('done @src/app.ts '), undefined);
  const files = ['src/app.ts', 'src/api.ts', 'test/app.test.ts', 'README.md'];
  assert.deepEqual(mentionCandidates('src/ap', files), ['src/app.ts', 'src/api.ts']);
  assert.deepEqual(mentionCandidates('app', files), ['src/app.ts', 'test/app.test.ts']);
  assert.equal(completeMention('look at @src/a', 'src/app.ts'), 'look at @src/app.ts ');
});
