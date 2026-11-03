import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combinePrompt, exitCodeFor, parseAllowedTools, parseOutputFormat, parsePermissionMode, resultObject } from '../headless.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

test('option parsing and exit-code rules', () => {
  assert.equal(parseOutputFormat(undefined), 'text');
  assert.equal(parseOutputFormat('stream-json'), 'stream-json');
  assert.equal(parseOutputFormat('yaml'), undefined);
  assert.equal(parsePermissionMode(undefined), 'deny-ask');
  assert.equal(parsePermissionMode('auto'), undefined);
  assert.deepEqual(parseAllowedTools('read_file, grep_files'), ['read_file', 'grep_files']);
  assert.equal(exitCodeFor({ refusals: [], stepLimit: false }), 0);
  assert.equal(exitCodeFor({ error: 'x', refusals: ['y'], stepLimit: true }), 1);
  assert.equal(exitCodeFor({ refusals: ['y'], stepLimit: true }), 2);
  assert.equal(exitCodeFor({ refusals: [], stepLimit: true }), 3);
  assert.equal(combinePrompt('', ' piped \n'), 'piped');
  assert.equal(combinePrompt('explain', 'some code'), 'explain\n\nsome code');
  assert.equal(combinePrompt('just this', undefined), 'just this');
  const r = resultObject({ result: 'hi', facts: { refusals: [], stepLimit: false }, usage: { requests: 1, inputTokens: 2, outputTokens: 3, cachedTokens: 0 }, toolCalls: 0 });
  assert.deepEqual([r.type, r.exit_code, r.is_error, r.result], ['result', 0, false, 'hi']);
});

function run(args: string[], input?: string): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-headless-'));
  try {
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, O4C_LOCAL_API_KEY: '' };
    const r = spawnSync(process.execPath, [TSX, CLI, '--provider', 'mock', ...args], { cwd: dir, env, input: input ?? '', encoding: 'utf-8', timeout: 90_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--output-format json: one result object on stdout, exit 0', () => {
  const r = run(['--output-format', 'json', 'read something']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'nothing else on stdout');
  const o = JSON.parse(lines[0]!);
  assert.equal(o.type, 'result');
  assert.equal(o.exit_code, 0);
  assert.equal(o.tool_calls, 1);
  assert.match(String(o.result), /\[mock\]/);
});

test('--allowed-tools refuses the rest and exits 2; stdin is the prompt when none is given', () => {
  const r = run(['--output-format', 'json', '--allowed-tools', 'glob_files'], 'read something');
  assert.equal(r.code, 2, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.match(o.refusals[0], /^read_file: not in --allowed-tools/);
});

test('--max-turns hit: the summary still comes back, exit 3; stream-json is one line per event then the result', () => {
  const r = run(['--output-format', 'stream-json', '--max-turns', '1', 'read something']);
  assert.equal(r.code, 3, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'event' && l.event.type === 'tool_call'));
  const last = lines[lines.length - 1];
  assert.equal(last.type, 'result');
  assert.equal(last.step_limit_reached, true);
});

test('bad option values exit 1 with the reason', () => {
  const r = run(['--output-format', 'yaml', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--output-format must be text, json or stream-json/);
});

test('--json-schema with an unreadable file exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-schema-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    const r = run(['--json-schema', join(dir, 'bad.json'), 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--json-schema: could not read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
