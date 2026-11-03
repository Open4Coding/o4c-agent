import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bangCommand, runBang, withShellNotes } from '../ui/bangCommand.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 E7: !command runs it directly; the model gets the output with the next message. */

test('recognised only at the start; output becomes a note in front of the next message', async () => {
  assert.equal(bangCommand('!git status'), 'git status');
  assert.equal(bangCommand('  ! echo hi '), 'echo hi');
  assert.equal(bangCommand('why does ! fail'), undefined);
  assert.equal(bangCommand('!'), undefined);
  const { output, note } = await runBang('echo hello-bang', runShellTool);
  assert.match(output, /hello-bang/);
  assert.match(note, /^\[The user ran this shell command themselves: echo hello-bang\]\nhello-bang/);
  assert.equal(withShellNotes([note], 'now fix it'), `${note}\n\nnow fix it`);
  assert.equal(withShellNotes([], 'plain'), 'plain');
});
