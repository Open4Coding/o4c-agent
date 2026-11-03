import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardCommands, copyToClipboard, osc52, replyBack } from '../ui/clipboard.js';
import type { Message } from '../providers/types.js';

const msgs = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'first reply' },
  { role: 'assistant', content: '' },
  { role: 'tool', content: 'tool output' },
  { role: 'assistant', content: '  second reply  ' },
] as unknown as Message[];

test('replyBack picks the Nth non-empty assistant reply from the end', () => {
  assert.equal(replyBack(msgs), 'second reply');
  assert.equal(replyBack(msgs, 2), 'first reply');
  assert.equal(replyBack(msgs, 3), undefined);
  assert.equal(replyBack([]), undefined);
});

test('copyToClipboard uses the first command that works and also writes OSC 52', () => {
  const tried: string[] = [];
  const written: string[] = [];
  const via = copyToClipboard('héllo', {
    platform: 'linux',
    runner: (cmd) => (tried.push(cmd), cmd === 'xclip'),
    writeTerminal: (s) => written.push(s),
  });
  assert.equal(via, 'xclip');
  assert.deepEqual(tried, ['wl-copy', 'xclip']);
  assert.deepEqual(written, [osc52('héllo')]);
});

test('Windows clip gets UTF-16 with a byte-order mark', () => {
  let got: Buffer | undefined;
  copyToClipboard('é', { platform: 'win32', runner: (_c, _a, input) => ((got = input), true), writeTerminal: () => {} });
  assert.deepEqual([...got!], [0xff, 0xfe, 0xe9, 0x00]);
});

test('falls back to OSC 52 alone, or reports nothing worked', () => {
  assert.equal(copyToClipboard('x', { platform: 'darwin', runner: () => false, writeTerminal: () => {} }), 'the terminal (OSC 52)');
  assert.deepEqual(clipboardCommands('darwin').map((c) => c.cmd), ['pbcopy']);
});
