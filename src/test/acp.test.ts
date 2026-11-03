import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { O4cAcpAgent, toolKind, toolTitle, type AcpRunner } from '../acp/agent.js';
import type { RunOptions } from '../agent/loop.js';
import type { Tool } from '../tools/types.js';
import { killTree } from '../tools/shellRunner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const writeTool = { name: 'write_file', mutating: true } as unknown as Tool;
const readTool = { name: 'read_file' } as unknown as Tool;

/** A runner that streams, calls the two tools through the policy, and answers. */
function scriptedRunner(log: string[]): AcpRunner {
  return {
    async run(message: string, o: RunOptions) {
      o.onEvent?.({ type: 'delta', kind: 'think', text: 'thinking...' });
      for (const [tool, input] of [[readTool, { path: 'a.ts' }], [writeTool, { path: 'b.ts', content: 'x' }]] as const) {
        o.onEvent?.({ type: 'tool_call', toolName: tool.name, toolInput: input });
        const verdict = await o.toolPolicy!(tool, input);
        log.push(`${tool.name}:${typeof verdict === 'string' ? verdict : verdict.verdict}`);
        o.onEvent?.({ type: 'tool_result', toolName: tool.name, toolOutput: typeof verdict === 'string' && verdict === 'allow' ? 'ok' : 'Denied' });
      }
      o.onEvent?.({ type: 'delta', kind: 'text', text: `done: ${message}` });
      if (o.signal?.aborted) throw new Error('aborted');
      return 'done';
    },
  };
}

test('tool kinds and titles for the editor', () => {
  assert.equal(toolKind('run_shell'), 'execute');
  assert.equal(toolKind('edit_file'), 'edit');
  assert.equal(toolKind('mcp__x__y'), 'other');
  assert.equal(toolTitle('run_shell', { command: 'npm test' }), 'run_shell: npm test');
  assert.equal(toolTitle('ask_user'), 'ask_user');
});

test('a prompt streams updates, asks the editor before a write, and remembers "always"', async () => {
  const updates: Record<string, unknown>[] = [];
  const asked: string[] = [];
  let answer = 'always';
  const conn = {
    sessionUpdate: async (n: { update: Record<string, unknown> }) => void updates.push(n.update),
    requestPermission: async (r: { toolCall: { title: string } }) => {
      asked.push(r.toolCall.title);
      return { outcome: { outcome: 'selected', optionId: answer } };
    },
  };
  const log: string[] = [];
  const agent = new O4cAcpAgent(conn as never, {
    newRunner: () => scriptedRunner(log),
    decide: async (tool) => (tool.mutating ? 'ask' : 'allow'),
  });
  const init = (await agent.initialize()) as { protocolVersion: number };
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  const { sessionId } = (await agent.newSession({ cwd: process.cwd() })) as { sessionId: string };
  const r1 = (await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })) as { stopReason: string };
  assert.equal(r1.stopReason, 'end_turn');
  assert.deepEqual(log, ['read_file:allow', 'write_file:allow']);
  assert.deepEqual(asked, ['write_file: b.ts'], 'only the write is asked about');
  const kinds = updates.map((u) => u.sessionUpdate);
  assert.deepEqual(kinds, ['agent_thought_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  assert.equal((updates[1] as { kind: string }).kind, 'read');
  assert.equal((updates[4] as { status: string }).status, 'completed');
  // "Always" was chosen: the next write in this session is not asked about.
  answer = 'reject';
  await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] });
  assert.equal(asked.length, 1);
});

test('a rejected permission becomes a declined tool call; cancel ends the prompt as cancelled', async () => {
  const log: string[] = [];
  const conn = { sessionUpdate: async () => undefined, requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }) };
  const agent = new O4cAcpAgent(conn as never, { newRunner: () => scriptedRunner(log), decide: async (t) => (t.mutating ? 'ask' : 'allow') });
  const { sessionId } = (await agent.newSession({ cwd: process.cwd() })) as { sessionId: string };
  await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
  assert.deepEqual(log, ['read_file:allow', 'write_file:declined']);

  const slow: AcpRunner = { run: (_m, o) => new Promise((_res, rej) => o.signal!.addEventListener('abort', () => rej(new Error('aborted')))) };
  const agent2 = new O4cAcpAgent(conn as never, { newRunner: () => slow, decide: async () => 'allow' });
  const s2 = (await agent2.newSession({ cwd: process.cwd() })) as { sessionId: string };
  const pending = agent2.prompt({ sessionId: s2.sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await agent2.cancel({ sessionId: s2.sessionId });
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
});

test('the real `o4c acp` speaks the protocol on stdio: initialize, new session, a prompt with updates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'o4c-acp-'));
  const child = spawn(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli.ts'), 'acp', '--provider', 'mock'], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, O4C_LOCAL_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  try {
    const updates: string[] = [];
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async (n: { update: { sessionUpdate: string } }) => void updates.push(n.update.sessionUpdate),
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
      }) as never,
      ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    );
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } as never);
    assert.equal((init as { protocolVersion: number }).protocolVersion, PROTOCOL_VERSION, stderr);
    const { sessionId } = await client.newSession({ cwd: home, mcpServers: [] } as never);
    const res = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'read something' }] } as never);
    assert.equal((res as { stopReason: string }).stopReason, 'end_turn');
    assert.ok(updates.includes('tool_call') && updates.includes('tool_call_update'), JSON.stringify(updates));
    assert.ok(updates.includes('agent_message_chunk'), JSON.stringify(updates));
  } finally {
    // tsx runs o4c in a child of its own, so the whole tree has to go, or it keeps the folder open.
    const exited = new Promise((r) => child.once('exit', r));
    killTree(child);
    await exited;
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(home, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});
