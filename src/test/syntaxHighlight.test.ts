import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grammarFor, grammarForPath, highlightCode, parseHighlighted, plainLines } from '../ui/syntaxHighlight.js';
import { styleCodePreview, styleDiff, wordChanges, WORD_DIFF_LIMIT } from '../ui/diffStyle.js';
import { diffLines, clipDiff, ELISION } from '../ui/lineDiff.js';
import { diffColors, scopeColor, syntax } from '../ui/theme.js';

/**
 * Item 9: syntax colouring, done the way Claude Code does it. Colour cannot be read off an
 * ink-testing-library frame, so these tests read the structure the dialog draws from.
 */

const text = (line: readonly { text: string }[]) => line.map((s) => s.text).join('');

// ------------------------------------------------------------------ highlighting

test('a file is highlighted by its extension, and plain when there is no grammar for it', () => {
  assert.equal(grammarForPath('src/a.ts'), 'typescript');
  assert.equal(grammarForPath('lib/x.rs'), 'rust');
  assert.equal(grammarForPath('Dockerfile'), 'dockerfile');
  assert.equal(grammarFor('TS'), 'typescript', 'a fence tag is matched case-insensitively');
  assert.equal(grammarForPath('notes.unknownext'), undefined);
  assert.deepEqual(highlightCode('a\nb', undefined), plainLines('a\nb'));
});

test('highlighting keeps the text and the line count exactly', () => {
  const code = 'const a = 1;\n\n/* two\n   lines */\nfunction f() { return `x${a}`; }\n';
  const lines = highlightCode(code, 'typescript');
  assert.equal(lines.length, code.split('\n').length);
  assert.deepEqual(lines.map(text), code.split('\n'));
});

test('keywords, strings and comments get their scopes, and a comment stays one across lines', () => {
  const lines = highlightCode('const s = "hi"; /* a\nb */ x', 'typescript');
  const scopeOf = (line: number, t: string) => lines[line].find((s) => s.text.includes(t))?.scope;
  assert.equal(scopeOf(0, 'const'), 'keyword');
  assert.equal(scopeOf(0, '"hi"'), 'string');
  assert.equal(scopeOf(0, '/* a'), 'comment');
  assert.equal(scopeOf(1, 'b */'), 'comment', 'the open span carries over the newline');
  assert.equal(scopeOf(1, ' x'), undefined);
});

test('the HTML parser unescapes entities and takes the innermost scope', () => {
  const lines = parseHighlighted(
    '<span class="hljs-string">`a &amp; &lt;b&gt; <span class="hljs-subst">${c}</span>`</span>',
  );
  assert.equal(text(lines[0]), '`a & <b> ${c}`');
  assert.equal(lines[0].find((s) => s.text === '${c}')?.scope, 'subst');
  assert.equal(parseHighlighted('<span class="hljs-title function_">f</span>')[0][0].scope, 'title.function');
});

test('a scope falls back to its first part for its colour', () => {
  assert.equal(scopeColor('title.function'), syntax.title);
  assert.equal(scopeColor('title.class'), syntax['title.class']);
  assert.equal(scopeColor(undefined), undefined);
  assert.equal(scopeColor('no-such-scope'), undefined);
});

test('an unknown grammar or a highlighter failure falls back to plain lines', () => {
  assert.deepEqual(highlightCode('x', 'not-a-grammar'), plainLines('x'));
});

// ------------------------------------------------------------------ word changes

test('a small change to a line marks only the words that changed', () => {
  const changes = wordChanges('const total = price * 2;', 'const total = price * 3;');
  assert.ok(changes);
  assert.deepEqual(changes[0], [{ start: 22, end: 23 }]);
  assert.deepEqual(changes[1], [{ start: 22, end: 23 }]);
});

test('a rewritten line gets no word ranges', () => {
  // Past the limit the bright background would cover most of both lines and point at nothing.
  assert.equal(wordChanges('return a + b;', 'throw new Error("no");'), undefined);
  assert.ok(WORD_DIFF_LIMIT > 0 && WORD_DIFF_LIMIT < 1);
});

// ------------------------------------------------------------------ the styled diff

test('a styled diff numbers lines from their own side and keeps the markers in the text', () => {
  const before = 'keep\nold value\ntail';
  const after = 'keep\nnew value\ntail';
  const lines = styleDiff(diffLines(before, after));
  const rows = lines.map((l) => `${l.gutter} ${l.marker}${text(l.segments)}`);
  assert.deepEqual(rows, ['1  keep', '2 -old value', '2 +new value', '3  tail']);
  assert.equal(lines[1].lineBackground, diffColors.removedLine);
  assert.equal(lines[2].lineBackground, diffColors.addedLine);
  assert.equal(lines[0].lineBackground, undefined, 'context lines have no background');
});

test('the changed word gets the bright background and the rest of the line the dim one', () => {
  const lines = styleDiff(diffLines('let x = 1;', 'let x = 2;'));
  const added = lines.find((l) => l.kind === 'added')!;
  assert.equal(added.segments.find((s) => s.text === '2')?.backgroundColor, diffColors.addedWord);
  assert.ok(added.segments.filter((s) => s.text !== '2').every((s) => s.backgroundColor === diffColors.addedLine));
});

test('syntax colours come from the version each line belongs to', () => {
  const before = 'const a = 1;';
  const after = 'let a = 1;';
  const lines = styleDiff(
    diffLines(before, after),
    highlightCode(before, 'typescript'),
    highlightCode(after, 'typescript'),
  );
  const removed = lines.find((l) => l.kind === 'removed')!;
  const added = lines.find((l) => l.kind === 'added')!;
  assert.equal(removed.segments.find((s) => s.text === 'const')?.color, syntax.keyword);
  assert.equal(added.segments.find((s) => s.text === 'let')?.color, syntax.keyword);
  assert.equal(text(added.segments), after);
});

test('an elision marker has no line number and no background', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const lines = styleDiff(clipDiff(diffLines(before, after), 16));
  const elisions = lines.filter((l) => l.elision);
  assert.ok(elisions.length > 0);
  for (const e of elisions) {
    assert.equal(e.gutter.trim(), '');
    assert.equal(text(e.segments), ELISION);
    assert.equal(e.lineBackground, undefined);
  }
});

test('tabs are drawn as spaces so the row can be padded to the dialog edge', () => {
  const lines = styleDiff(diffLines('\tx', '\ty'));
  assert.ok(lines.every((l) => !text(l.segments).includes('\t')));
});

// ------------------------------------------------------------------ the new-file preview

test('a new-file preview is numbered, coloured, and says how much is not shown', () => {
  const code = highlightCode(['const a = 1;', 'let b = 2;', 'let c = 3;'].join(String.fromCharCode(10)), 'typescript');
  const rows = styleCodePreview(code, 300, 80);
  assert.deepEqual(
    rows.map((r) => `${r.gutter} ${r.marker}${text(r.segments)}`),
    ['1  const a = 1;', '2  let b = 2;', '3  let c = 3;', '   ... (+297 more lines)'],
  );
  assert.equal(rows[0].segments.find((s) => s.text === 'const')?.color, syntax.keyword);
  assert.ok(rows.every((r) => r.lineBackground === undefined), 'a preview is not a change');
});

test('a preview row is clipped to the width rather than wrapped', () => {
  const rows = styleCodePreview(highlightCode('x'.repeat(200), 'typescript'), 1, 40);
  const shown = text(rows[0].segments);
  assert.ok(shown.endsWith('...'));
  assert.ok(`${rows[0].gutter} ${rows[0].marker}${shown}`.length <= 40, shown);
});
