import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpServers, mcpConfigStore, MCP_SERVERS_KEY } from '../mcp/registry.js';

async function withTempDirs(fn: (globalDir: string, projectRoot: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'o4c-mcp-test-'));
  try {
    const globalDir = join(base, 'global');
    const projectRoot = join(base, 'project');
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await fn(globalDir, projectRoot);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** Writes one of the three real files, at the real path the namespace resolves to. */
async function writeMcpConfig(dir: string, file: string, body: unknown): Promise<void> {
  const mcpDir = join(dir, 'mcp');
  await mkdir(mcpDir, { recursive: true });
  await writeFile(join(mcpDir, file), JSON.stringify(body, null, 2), 'utf-8');
}

const STDIO = { transport: 'stdio', command: 'node', args: ['server.js'] };

test('servers are read from the mcp namespace, not from core config', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    // Proving the path, because the whole point of reusing ConfigStore's namespace is that these
    // land in .o4c/mcp/ rather than polluting the core config.json every /set-* command shares.
    await writeMcpConfig(globalDir, 'config.json', { [MCP_SERVERS_KEY]: { memory: STDIO } });
    await writeFile(join(globalDir, 'config.json'), JSON.stringify({ [MCP_SERVERS_KEY]: { decoy: STDIO } }), 'utf-8');

    const { servers, problems } = await loadMcpServers(projectRoot, globalDir);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      servers.map((s) => s.id),
      ['memory'],
      'core config.json must not be read as MCP config',
    );
  });
});

test('the three scopes resolve global -> local -> personal, personal winning', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const localDir = join(projectRoot, '.o4c');
    await writeMcpConfig(globalDir, 'config.json', {
      [MCP_SERVERS_KEY]: { blender: { transport: 'http', url: 'http://127.0.0.1:1111/mcp' }, memory: STDIO },
    });
    await writeMcpConfig(localDir, 'config.json', {
      [MCP_SERVERS_KEY]: { blender: { url: 'http://127.0.0.1:2222/mcp' } },
    });
    await writeMcpConfig(localDir, 'config.local.json', {
      [MCP_SERVERS_KEY]: { blender: { url: 'http://127.0.0.1:3333/mcp' } },
    });

    const { servers, problems } = await loadMcpServers(projectRoot, globalDir);
    assert.deepEqual(problems, []);
    const blender = servers.find((s) => s.id === 'blender');
    assert.equal(blender?.url, 'http://127.0.0.1:3333/mcp', 'personal wins');
    assert.equal(blender?.transport, 'http', 'the global transport survives without being restated');
    assert.ok(servers.some((s) => s.id === 'memory'), 'a global-only server is still loaded');
  });
});

test('no MCP config anywhere is zero servers and no complaint', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    assert.deepEqual(await loadMcpServers(projectRoot, globalDir), { servers: [], problems: [] });
  });
});

test('an untrusted project (no project root) still reads global servers', async () => {
  await withTempDirs(async (globalDir) => {
    await writeMcpConfig(globalDir, 'config.json', { [MCP_SERVERS_KEY]: { memory: STDIO } });
    const { servers } = await loadMcpServers(undefined, globalDir);
    assert.deepEqual(
      servers.map((s) => s.id),
      ['memory'],
    );
  });
});

test('malformed JSON means no MCP servers, not no o4c', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const mcpDir = join(globalDir, 'mcp');
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, 'config.json'), '{ "servers": { "memory": ', 'utf-8');

    const { servers, problems } = await loadMcpServers(projectRoot, globalDir);
    assert.deepEqual(servers, []);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].startsWith('MCP config could not be read'), problems[0]);
  });
});

test('a bad entry in one scope does not discard the good ones from another', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await writeMcpConfig(globalDir, 'config.json', { [MCP_SERVERS_KEY]: { memory: STDIO } });
    await writeMcpConfig(join(projectRoot, '.o4c'), 'config.json', {
      [MCP_SERVERS_KEY]: { broken: { transport: 'stdio' } },
    });

    const { servers, problems } = await loadMcpServers(projectRoot, globalDir);
    assert.deepEqual(
      servers.map((s) => s.id),
      ['memory'],
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('needs a "command"'), problems[0]);
  });
});

test('the store writes where the loader reads, so a future /mcp command round-trips', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = mcpConfigStore(projectRoot, globalDir);
    await store.set('global', MCP_SERVERS_KEY, { memory: STDIO });

    const { servers, problems } = await loadMcpServers(projectRoot, globalDir);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      servers.map((s) => s.id),
      ['memory'],
    );
  });
});
