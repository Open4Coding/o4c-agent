import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyBytes, ptyTool, stopAllPty } from '../tools/pty.js';

after(stopAllPty);

test('key names map to the bytes a terminal sends', () => {
  assert.equal(keyBytes('enter'), '\r');
  assert.equal(keyBytes('Ctrl+C'), '\x03');
  assert.equal(keyBytes('ctrl+d'), '\x04');
  assert.equal(keyBytes('up'), '\x1b[A');
  assert.equal(keyBytes('hyper+x'), undefined);
});

test('drives an interactive program: start, type, press enter, read the screen, stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-pty-'));
  try {
    // A tiny line-oriented "REPL": prints a prompt, echoes each line doubled, quits on "bye".
    const script = join(dir, 'repl.mjs');
    writeFileSync(
      script,
      "import readline from 'node:readline'; const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'calc> ' }); rl.prompt(); rl.on('line', (l) => { if (l.trim() === 'bye') { console.log('ciao'); process.exit(0); } console.log('= ' + Number(l) * 2); rl.prompt(); });",
    );
    const started = await ptyTool.execute({ action: 'start', command: `node "${script}"` });
    const id = Number(/\[pty (\d+):/.exec(started)![1]);
    assert.match(started, /calc>/);
    const after21 = await ptyTool.execute({ action: 'send', id, text: '21', keys: ['enter'] });
    assert.match(after21, /= 42/);
    assert.match(after21, /cursor row \d+, col \d+/);
    assert.match(await ptyTool.execute({ action: 'screen', id }), /= 42/);
    assert.match(await ptyTool.execute({ action: 'send', id, keys: ['warp'] }), /Unknown key: warp/);
    const bye = await ptyTool.execute({ action: 'send', id, text: 'bye', keys: ['enter'] });
    assert.match(bye, /ciao/);
    assert.equal(await ptyTool.execute({ action: 'stop', id }), `pty ${id} stopped.`);
    assert.match(await ptyTool.execute({ action: 'screen', id }), /No pty session/);
  } finally {
    stopAllPty();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pty tool is mutating, so every mode treats it like run_shell', () => {
  assert.equal(ptyTool.mutating, true);
});
