import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfirmMessage } from '../ui/confirmPreview.js';

const bigFile = Array.from({ length: 260 }, (_, i) => 'const row' + i + ' = ' + JSON.stringify('x'.repeat(40)) + ';').join('\n');

test('write_file shows the path, the size and a short preview - never the whole file', () => {
  const msg = formatConfirmMessage('write_file', { path: 'index.html', content: bigFile }, { cols: 100, rows: 40 });
  const lines = msg.split('\n');
  assert.ok(lines[0].startsWith('Allow write_file(index.html)?'));
  assert.ok(lines[0].includes('260 lines'));
  assert.ok(lines[1].startsWith('const row0 ='));
  assert.ok(lines.at(-1)!.startsWith('... (+'));
  assert.ok(!msg.includes('const row100 ='), 'the body of the file is not shown');
  assert.ok(lines.length <= 1 + 8 + 1);
});

test('a short write_file is shown whole, with no "more lines" note', () => {
  const msg = formatConfirmMessage('write_file', { path: 'a.txt', content: 'one' + '\n' + 'two' }, { cols: 100, rows: 40 });
  assert.equal(msg, 'Allow write_file(a.txt)? 7 characters, 2 lines' + '\n' + 'one' + '\n' + 'two');
});

test('run_shell shows a normal command in full, on its own line', () => {
  const msg = formatConfirmMessage('run_shell', { command: 'npm test -- --watch=false' }, { cols: 100, rows: 40 });
  assert.equal(msg, 'Allow run_shell?' + '\n' + 'npm test -- --watch=false');
});

test('run_shell bounds a huge command (a heredoc embedding a file) and says how long it really is', () => {
  const command = 'cat > f <<EOF' + '\n' + 'y'.repeat(5000) + '\n' + 'EOF';
  const msg = formatConfirmMessage('run_shell', { command }, { cols: 100, rows: 40 });
  assert.ok(msg.length < 1200);
  assert.ok(msg.split('\n').at(-1)!.includes('in total'));
});

test('an unknown tool falls back to a bounded JSON preview', () => {
  const msg = formatConfirmMessage('mystery', { blob: 'z'.repeat(5000) }, { cols: 100, rows: 40 });
  assert.ok(msg.startsWith('Allow mystery('));
  assert.ok(msg.length < 480);
  assert.ok(msg.endsWith('...)?'));
});

test('a long path keeps its file name and the counts stay visible', () => {
  const longPath = '/very/deep/' + 'folder/'.repeat(30) + 'important-file.ts';
  const header = formatConfirmMessage('write_file', { path: longPath, content: 'x' }, { cols: 80, rows: 40 }).split('\n')[0];
  assert.ok(header.includes('important-file.ts)?'));
  assert.ok(header.includes('1 character, 1 line'));
  assert.ok(header.length < 80 * 2);
});

test('the dialog stays small at ANY window size: bounded line count, every preview line fits the width', () => {
  for (const rows of [3, 5, 10, 24, 40, 131, 300]) {
    for (const cols of [20, 40, 80, 177, 300]) {
      const msg = formatConfirmMessage('write_file', { path: 'a/b/c.ts', content: bigFile }, { cols, rows });
      const lines = msg.split('\n');
      const budget = Math.max(20, cols - 8);
      const maxPreview = Math.max(3, Math.min(8, Math.floor(rows / 4)));
      assert.ok(lines.length <= 1 + maxPreview + 1, rows + 'x' + cols + ': ' + lines.length + ' lines');
      for (const l of lines.slice(1)) assert.ok(l.length <= budget, rows + 'x' + cols + ': preview line of ' + l.length);
    }
  }
});
