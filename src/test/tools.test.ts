import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from '../tools/readFile.js';
import { runShellTool } from '../tools/runShell.js';
import { maxToolOutputChars, truncateToolOutput } from '../tools/toolOutput.js';

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-tools-'));
  const path = join(dir, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

test('read_file returns a short file byte-identical, with no header', async () => {
  const content = 'line one\nline two\nline three\n';
  const path = await tempFile('small.txt', content);
  assert.equal(await readFileTool.execute({ path }), content);
});

test('read_file caps a long file at 2000 lines and says what it showed', async () => {
  const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n');
  const path = await tempFile('long.txt', content);

  const out = await readFileTool.execute({ path });
  const lines = out.split('\n');
  assert.match(lines[0], /^\[read_file: lines 1-2,000 of 5,000 in /);
  assert.equal(lines[1], 'line 1');
  assert.equal(lines[2_000], 'line 2000');
  assert.equal(lines.length, 2_001, 'header plus exactly 2000 lines');
});

test('read_file reads an explicit range, which is how the spill file gets read back', async () => {
  const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n');
  const path = await tempFile('range.txt', content);

  const out = await readFileTool.execute({ path, offset: 4_990, limit: 5 });
  const lines = out.split('\n');
  assert.match(lines[0], /^\[read_file: lines 4,990-4,994 of 5,000 in /);
  assert.equal(lines[1], 'line 4990');
  assert.equal(lines[5], 'line 4994');
  assert.equal(lines.length, 6);
});

test('read_file reports an offset past the end instead of returning nothing', async () => {
  const path = await tempFile('three.txt', 'a\nb\nc\n');
  const out = await readFileTool.execute({ path, offset: 99 });
  assert.match(out, /has 3 lines; offset 99 is past the end/);
});

test('read_file ignores a nonsense range rather than failing the call', async () => {
  const content = 'a\nb\nc\n';
  const path = await tempFile('junk.txt', content);
  assert.equal(await readFileTool.execute({ path, offset: 0, limit: -5 }), content);
  assert.equal(await readFileTool.execute({ path, offset: 'abc', limit: null }), content);
});

test('read_file still reports a missing file as an error string', async () => {
  const out = await readFileTool.execute({ path: join(tmpdir(), 'o4c-does-not-exist-12345.txt') });
  assert.match(out, /^Error reading file /);
});

test('read_file on a 4.5MB single-purpose transcript stays bounded', async () => {
  // The shape that would otherwise repeat the 2026-10-06 failure through a different tool:
  // docs/context window/fullContextWindow.txt is 4.5 MB.
  const content = `${'x'.repeat(300)}\n`.repeat(15_000); // ~4.5 MB over 15,000 lines
  const path = await tempFile('huge.txt', content);
  const out = await readFileTool.execute({ path });
  assert.ok(out.length < content.length / 7, `returned ${out.length} of ${content.length} chars`);
});

test('run_shell returns normal output unchanged', async () => {
  const out = await runShellTool.execute({ command: 'echo hello-from-shell' });
  assert.match(out, /hello-from-shell/);
});

test('run_shell reports a failing command without dumping its whole buffer', async () => {
  const out = await runShellTool.execute({ command: 'exit 3' });
  assert.match(out, /^Command failed:/);
  assert.ok(out.length < 2_000, `failure message was ${out.length} chars`);
});

test('a command that floods stdout fails fast and says how to work around it', async () => {
  // The real failing shape: more output than the buffer holds. Node's own `yes`-equivalent, portable
  // across the Windows/POSIX split this project runs on.
  const flood = 'node -e "const s=\'x\'.repeat(1024);for(let i=0;i<8000;i++)process.stdout.write(s)"';
  const out = await runShellTool.execute({ command: flood });

  assert.match(out, /maxBuffer length exceeded/);
  assert.match(out, /Narrow it .*or redirect it to a file and read ranges with read_file/);
  // Before the fix this returned the entire 10 MB buffer; now the failure itself is small, and the
  // loop's window-derived cap would bound it again regardless.
  assert.ok(out.length <= 250_000, `failure output was ${out.length} chars`);
  assert.ok(truncateToolOutput(out, maxToolOutputChars(229_376)).text.length <= 40_000);
});
