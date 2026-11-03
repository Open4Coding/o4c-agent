import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeHooks,
  hookToolInput,
  matches,
  parseHooks,
  postToolHooksComponent,
  preToolHookVerdict,
  runHooks,
  setHooks,
  type HookRunner,
} from '../session/hooks.js';

afterEach(() => setHooks({ hooks: {}, problems: [] }));

const cmd = (command: string, timeout?: number) => ({ type: 'command', command, ...(timeout ? { timeout } : {}) });

test('parseHooks keeps valid groups and reports the rest by name', () => {
  const { hooks, problems } = parseHooks({
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a', 5)] }, { matcher: '(', hooks: [cmd('b')] }, { hooks: [{ type: 'prompt', prompt: 'x' }] }],
    OnLunch: [],
    Stop: 'nope',
  });
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ command: 'a', timeoutMs: 5000 }] }]);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /not a valid regular expression/);
  assert.match(problems.join('\n'), /needs "type": "command"/);
  assert.match(problems.join('\n'), /Unknown hook event "OnLunch"/);
  assert.match(problems.join('\n'), /hooks\.Stop must be a list/);
});

test("matchers accept o4c's tool names and Claude Code's", () => {
  assert.equal(matches({ matcher: 'Bash', hooks: [] }, 'run_shell'), true);
  assert.equal(matches({ matcher: 'Edit|Write', hooks: [] }, 'write_file'), true);
  assert.equal(matches({ matcher: 'run_shell', hooks: [] }, 'run_shell'), true);
  assert.equal(matches({ matcher: 'Bash', hooks: [] }, 'bash_helper'), false, 'anchored, not a substring match');
  assert.equal(matches({ hooks: [] }, 'anything'), true);
  assert.deepEqual(hookToolInput({ path: 'a.ts' }), { path: 'a.ts', file_path: 'a.ts' });
});

function fake(results: Record<string, { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>, seen?: string[]): HookRunner {
  return async (command, stdin) => {
    seen?.push(stdin);
    const r = results[command]!;
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.timedOut ?? false };
  };
}

test('exit 2 blocks with stderr; JSON decisions fold together, strictest permission wins', async () => {
  const config = parseHooks({
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('allow'), cmd('deny'), cmd('ask')] }],
    UserPromptSubmit: [{ hooks: [cmd('ctx'), cmd('plain'), cmd('fail'), cmd('slow')] }],
    Stop: [{ hooks: [cmd('two')] }],
  }).hooks;
  const runner = fake({
    allow: { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) },
    deny: { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no rm' }, systemMessage: 'checked' }) },
    ask: { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }) },
    ctx: { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'branch is main' } }) },
    plain: { code: 0, stdout: 'today is Monday' },
    fail: { code: 1, stderr: 'oops' },
    slow: { code: null, timedOut: true },
    two: { code: 2, stderr: 'tests are failing' },
  });
  const seen: string[] = [];
  const pre = await runHooks(config, 'PreToolUse', { tool_name: 'run_shell', tool_input: { command: 'rm -rf x' } }, { toolName: 'run_shell', runner: async (c, s, t, w) => (seen.push(s), runner(c, s, t, w)) });
  assert.equal(pre.permission, 'deny');
  assert.equal(pre.permissionReason, 'no rm');
  assert.deepEqual(pre.messages, ['checked']);
  assert.deepEqual(JSON.parse(seen[0]!), { hook_event_name: 'PreToolUse', session_id: '', cwd: process.cwd(), tool_name: 'run_shell', tool_input: { command: 'rm -rf x' } });
  const none = await runHooks(config, 'PreToolUse', {}, { toolName: 'read_file', runner });
  assert.equal(none.permission, undefined, 'the Bash matcher does not apply to read_file');
  const prompt = await runHooks(config, 'UserPromptSubmit', { prompt: 'hi' }, { runner });
  assert.deepEqual(prompt.additionalContext, ['branch is main', 'today is Monday']);
  assert.equal(prompt.messages.length, 2);
  assert.match(prompt.messages[0]!, /failed \(exit 1\): oops/);
  assert.match(prompt.messages[1]!, /timed out after 60 s/);
  assert.equal((await runHooks(config, 'Stop', {}, { runner })).block, 'tests are failing');
});

test('real hook scripts: stdin JSON in, a deny out; PostToolUse appends to the tool result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-hooks-'));
  try {
    const pre = join(dir, 'pre.mjs');
    writeFileSync(
      pre,
      `let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => { const j = JSON.parse(s); if (j.tool_input.command.includes('rm ')) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'rm is not allowed' } })); } });`,
    );
    const post = join(dir, 'post.mjs');
    const log = join(dir, 'post-log.json');
    writeFileSync(post, `let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => { require; });`.replace('require;', `import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(log)}, s); console.log(JSON.stringify({ decision: 'block', reason: 'lint found 2 errors' })); });`));
    setHooks(parseHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd(`node "${pre}"`)] }], PostToolUse: [{ matcher: 'Write', hooks: [cmd(`node "${post}"`)] }] }));
    const verdict = await preToolHookVerdict('run_shell', { command: 'rm -rf build' }, dir, () => {});
    assert.deepEqual(verdict, { verdict: 'deny', reason: 'a PreToolUse hook denied it: rm is not allowed' });
    assert.equal(await preToolHookVerdict('run_shell', { command: 'ls' }, dir, () => {}), undefined);
    const component = postToolHooksComponent({ cwd: dir });
    const out = await component.aroundTool({ tool: { name: 'write_file' }, input: { path: 'a.ts', content: 'x' } }, async () => 'Wrote a.ts');
    assert.equal(out, 'Wrote a.ts\n\n[PostToolUse hook] lint found 2 errors');
    const got = JSON.parse(readFileSync(log, 'utf-8'));
    assert.equal(got.hook_event_name, 'PostToolUse');
    assert.equal(got.tool_input.file_path, 'a.ts');
    assert.equal(got.tool_response, 'Wrote a.ts');
    assert.equal(await component.aroundTool({ tool: { name: 'read_file' }, input: {} }, async () => 'read'), 'read', 'the Write matcher skips read_file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/hooks lists what is configured and what was rejected', () => {
  const parsed = parseHooks({ Stop: [{ hooks: [cmd('npm test', 120)] }], Nope: [] });
  const text = describeHooks(parsed.hooks, parsed.problems).join('\n');
  assert.match(text, /Stop {14}\* {14}npm test {2}\(timeout 120 s\)/);
  assert.match(text, /Unknown hook event "Nope"/);
  assert.match(describeHooks({}, []).join('\n'), /none configured/);
});
