import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_PROFILES, childSystemPrompt, createTaskTool, loadProfiles, setTaskRuntime } from '../agent/subAgents.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

afterEach(() => setTaskRuntime(undefined));

/** First call: one call to the tool named; second call: a final answer that quotes what it saw. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  requests: CompletionRequest[] = [];
  constructor(private readonly toolName: string) {}
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const toolResult = [...request.messages].reverse().find((m) => m.role === 'tool');
    if (!toolResult) {
      return { content: '', toolCalls: [{ id: 'c1', name: this.toolName, input: { pattern: 'avg' } }], stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 } } as unknown as CompletionResponse;
    }
    return { content: `Found it: ${toolResult.content}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 20 } } as unknown as CompletionResponse;
  }
}

function tool(name: string, mutating = false): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, ...(mutating ? { mutating: true } : {}), execute: async () => `${name} result: src/avg.ts:3` };
}

const ALL = [tool('read_file'), tool('grep_files'), tool('glob_files'), tool('write_file', true), tool('run_shell', true), tool('job_output')];

test('built-in explore is read-only and verify can run commands; user profiles load project over global', () => {
  const explore = BUILT_IN_PROFILES.find((p) => p.name === 'explore')!;
  assert.ok(!explore.tools.includes('write_file') && !explore.tools.includes('run_shell') && !explore.tools.includes('edit_file'));
  assert.ok(BUILT_IN_PROFILES.find((p) => p.name === 'verify')!.tools.includes('run_shell'));
  const root = mkdtempSync(join(tmpdir(), 'o4c-agents-'));
  try {
    mkdirSync(join(root, 'home', '.o4c', 'agents'), { recursive: true });
    mkdirSync(join(root, 'proj', '.o4c', 'agents'), { recursive: true });
    writeFileSync(join(root, 'home', '.o4c', 'agents', 'docs.md'), '---\ndescription: global docs\n---\nglobal');
    writeFileSync(join(root, 'proj', '.o4c', 'agents', 'docs.md'), '---\ndescription: Writes docs\ntools: read_file, write_file\nmax-iterations: 8\n---\nWrite the docs.');
    const profiles = loadProfiles(join(root, 'proj'), join(root, 'home'));
    const docs = profiles.find((p) => p.name === 'docs')!;
    assert.deepEqual([docs.scope, docs.description, docs.tools, docs.maxIterations, docs.prompt], ['project', 'Writes docs', ['read_file', 'write_file'], 8, 'Write the docs.']);
    assert.deepEqual(profiles.map((p) => p.name).sort(), ['docs', 'explore', 'verify']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the task tool runs a child with only its profile tools and an empty context, and returns its answer', async () => {
  const provider = new ScriptedProvider('grep_files');
  const recorded: string[] = [];
  let finished = 0;
  setTaskRuntime({
    provider,
    tools: () => [...ALL, tool('task')],
    environment: ['Working directory: /p'],
    record: () => ({ onEntry: (e) => void recorded.push(`${e.type}/${e.sub_type}`), finish: () => void finished++ }),
  });
  const progress: string[] = [];
  const task = createTaskTool(BUILT_IN_PROFILES);
  const out = await task.execute({ agent: 'explore', task: 'Where is avg defined?' }, { onOutput: (t) => void progress.push(t) });
  assert.match(out, /^Found it: grep_files result: src\/avg\.ts:3/);
  assert.match(out, /\(explore sub-agent: 1 tool call, 220 prompt \/ 30 generated tokens\)/);
  const first = provider.requests[0]!;
  assert.deepEqual(first.tools.map((t) => t.name).sort(), ['glob_files', 'grep_files', 'read_file'], 'explore gets no write, shell or task');
  assert.equal(first.messages.length, 1, 'a fresh context: only the job');
  assert.equal(first.messages[0]!.content, 'Where is avg defined?');
  assert.match(first.systemPrompt ?? '', /research sub-agent[\s\S]*# Environment\nWorking directory: \/p/);
  assert.deepEqual(progress, ['[explore] started\n', '[explore] grep_files\n']);
  assert.ok(recorded.includes('user/input') && recorded.includes('ai/response'), 'the run is recorded for history');
  assert.equal(finished, 1);
});

test("a child's tool calls go through the parent's policy", async () => {
  const provider = new ScriptedProvider('run_shell');
  const asked: string[] = [];
  setTaskRuntime({
    provider,
    tools: () => ALL,
    environment: [],
    policy: async (t) => {
      asked.push(t.name);
      return { verdict: 'deny', reason: 'Plan mode is read-only' };
    },
  });
  const out = await createTaskTool(BUILT_IN_PROFILES).execute({ agent: 'verify', task: 'run the tests' });
  assert.deepEqual(asked, ['run_shell']);
  assert.match(out, /Found it: .*Plan mode is read-only/s);
});

test('bad input is answered plainly; no runtime means no sub-agents', async () => {
  const task = createTaskTool(BUILT_IN_PROFILES);
  assert.match(await task.execute({ agent: 'nobody', task: 'x' }), /No sub-agent "nobody"\. Agents: explore, verify\./);
  assert.match(await task.execute({ agent: 'explore', task: '  ' }), /The task is empty/);
  assert.match(await task.execute({ agent: 'explore', task: 'x' }), /not available/);
  assert.match(task.description, /- explore: Read-only search/);
  assert.equal(childSystemPrompt(BUILT_IN_PROFILES[0]!, []).includes('# Environment'), false);
});
