import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkConfigFiles, checkDatabases, checkDisk, checkNode, formatChecks } from '../session/doctor.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

/** Plan 0006 E3: /doctor's checks and the fix each failure comes with. */

test('Node version, config JSON, database integrity and disk', () => {
  assert.equal(checkNode('24.1.0').state, 'ok');
  assert.equal(checkNode('22.5.0').state, 'ok');
  const old = checkNode('20.11.1');
  assert.equal(old.state, 'fail');
  assert.match(old.fix!, /Node\.js 22/);

  const dir = mkdtempSync(join(tmpdir(), 'o4c-doctor-'));
  writeFileSync(join(dir, 'good.json'), '{"a": 1}');
  writeFileSync(join(dir, 'bad.json'), '{"a": 1,}');
  const configs = checkConfigFiles([{ scope: 'global', path: join(dir, 'good.json') }, { scope: 'local', path: join(dir, 'bad.json') }, { scope: 'personal', path: join(dir, 'missing.json') }]);
  assert.deepEqual(configs.map((c) => c.state), ['ok', 'fail']);
  assert.match(configs[1]!.fix!, /trailing comma/);

  const db = new DatabaseSync(join(dir, 'ok.db'));
  db.exec('CREATE TABLE t (x INTEGER)');
  db.close();
  writeFileSync(join(dir, 'broken.db'), 'this is not a database at all, just text that is long enough to look like a header');
  const dbs = checkDatabases([{ label: 'project', dir }]);
  assert.equal(dbs.find((c) => c.name.startsWith('Database ok.db'))!.state, 'ok');
  assert.equal(dbs.find((c) => c.name.startsWith('Database broken.db'))!.state, 'fail');

  assert.equal(checkDisk(dir, 1).state, 'ok');
  const text = formatChecks([old, ...configs]).join('\n');
  assert.match(text, /FAIL Node\.js: v20\.11\.1 is too old.*\n {7}fix: Install Node\.js 22/s);
  assert.match(text, /2 failure\(s\), 0 warning\(s\)\.$/);
});

test('the tool-call round trip: a structured ping passes, prose fails', async () => {
  const good = new AgentLoop(new FakeProvider([{ content: '', toolCalls: [{ id: '1', name: 'ping', input: { n: 1 } }], stopReason: 'tool_use' }]), [], 's');
  assert.match((await good.probeToolCall()).detail, /^ping called with \{"n":1\}/);
  const bad = new AgentLoop(new FakeProvider([{ content: 'I would call ping now.', toolCalls: [], stopReason: 'end_turn' }]), [], 's');
  const r = await bad.probeToolCall();
  assert.equal(r.ok, false);
  assert.match(r.detail, /no structured tool call came back/);
});
