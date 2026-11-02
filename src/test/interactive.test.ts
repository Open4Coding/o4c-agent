import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interactiveReason } from '../tools/interactive.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 B23: commands that can only hang are refused with what to do instead. */

test('editors, pagers, monitors, bare REPLs and interactive git/ssh are refused', () => {
  const refused: Array<[string, RegExp]> = [
    ['vim src/a.js', /edit_file/],
    ['notepad.exe notes.txt', /editor/],
    ['git log | less', /pager/],
    ['type big.txt | more', /pager/],
    ['top', /one sample/],
    ['python', /python -c/],
    ['node', /node -e/],
    ['C:\\Python312\\python.exe', /prompt/],
    ['git rebase -i HEAD~3', /without -i/],
    ['git add -p', /git add <path>/],
    ['git commit', /-m/],
    ['npm test && git commit', /-m/],
    ['ssh dual3090', /ssh host "command"/],
  ];
  for (const [cmd, why] of refused) assert.match(interactiveReason(cmd) ?? 'ALLOWED', why, cmd);
});

test('ordinary commands are allowed', () => {
  for (const cmd of [
    'node --test',
    'node -e "console.log(1)"',
    'python script.py',
    'echo "| less"',
    'git commit -m "fix: x"',
    'git commit -am "x"',
    'git add src/a.js',
    'git rebase main',
    'ssh dual3090 "docker ps"',
    'more --help > out.txt',
    'cat a | grep b',
    'npm run build && node dist/cli.js',
    'code --version',
  ]) {
    assert.equal(interactiveReason(cmd), undefined, cmd);
  }
});

test('run_shell refuses before running, and runs others without prompts or colour', async () => {
  assert.match(await runShellTool.execute({ command: 'git rebase -i HEAD~1' }), /^Command not run: git rebase -i opens an editor/);
  const env = await runShellTool.execute({ command: 'node -e "console.log(process.env.CI, process.env.GIT_TERMINAL_PROMPT, process.env.NO_COLOR)"' });
  assert.equal(env, '1 0 1');
});
