import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandCustomCommand, loadCustomCommands, parseCommandFile } from '../session/customCommands.js';

test('parseCommandFile reads description and args from frontmatter; no frontmatter is all body', () => {
  const p = parseCommandFile('---\ndescription: "Review a file"\nargs: [path, focus]\n---\nReview $path.\n');
  assert.deepEqual(p, { description: 'Review a file', args: ['path', 'focus'], body: 'Review $path.' });
  assert.deepEqual(parseCommandFile('args: a, b\njust text'), { args: [], body: 'args: a, b\njust text' });
  assert.deepEqual(parseCommandFile('---\nargs: one two\n---\nx').args, ['one', 'two']);
});

test('expandCustomCommand fills $ARGUMENTS, $1..$9 and named args (the last named takes the rest)', () => {
  const cmd = { args: ['path', 'focus'], body: 'File $path, focus on $focus. All: $ARGUMENTS. First: $1, third: $3.' };
  assert.equal(expandCustomCommand(cmd, ' src/a.ts error handling '), 'File src/a.ts, focus on error handling. All: src/a.ts error handling. First: src/a.ts, third: handling.');
  assert.equal(expandCustomCommand(cmd, ''), 'File , focus on . All: . First: , third: .');
  assert.equal(expandCustomCommand({ args: ['p', 'path'], body: '$path|$p' }, 'x y'), 'y|x', 'longer names are replaced first');
});

test('loadCustomCommands: project wins over global, built-in names are skipped and reported, odd files ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-cmds-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(join(home, '.o4c', 'commands'), { recursive: true });
    mkdirSync(join(project, '.o4c', 'commands'), { recursive: true });
    writeFileSync(join(home, '.o4c', 'commands', 'deploy.md'), 'global deploy');
    writeFileSync(join(home, '.o4c', 'commands', 'only-global.md'), 'g');
    writeFileSync(join(project, '.o4c', 'commands', 'Deploy.md'), '---\ndescription: project deploy\n---\nproject deploy body');
    writeFileSync(join(project, '.o4c', 'commands', 'clear.md'), 'would shadow /clear');
    writeFileSync(join(project, '.o4c', 'commands', 'empty.md'), '---\ndescription: nothing\n---\n');
    writeFileSync(join(project, '.o4c', 'commands', 'notes.txt'), 'not markdown');
    const { commands, skipped } = loadCustomCommands(project, new Set(['/clear']), home);
    assert.deepEqual(commands.map((c) => `${c.name}:${c.scope}`).sort(), ['/deploy:project', '/only-global:global']);
    assert.equal(commands.find((c) => c.name === '/deploy')!.body, 'project deploy body');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /^\/clear .* a built-in command already has that name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
