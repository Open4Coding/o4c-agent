import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiverKey, receiverTypes } from '../graph/receiverType.js';
import { chooseTarget } from '../graph/resolve.js';
import { extractTags } from '../graph/tags.js';
import type { DefinitionRow } from '../graph/graphStore.js';

test('receiverTypes reads TS/JS declarations, parameters, fields and this-assignments', () => {
  const src = [
    'const host = new McpHost(servers);',
    'let store: GraphStore = open();',
    'function f(loop: AgentLoop, n: number) {}',
    'class A { private readonly cfg: ConfigStore; constructor() { this.cache = new LruCache(); } }',
    'const x = new Foo(); const x2 = 1;',
    'let dup = new One(); dup = new Two();',
  ].join('\n');
  const t = receiverTypes(src, 'typescript');
  assert.equal(t.get('host'), 'McpHost');
  assert.equal(t.get('store'), 'GraphStore');
  assert.equal(t.get('loop'), 'AgentLoop');
  assert.equal(t.get('this.cfg'), 'ConfigStore');
  assert.equal(t.get('this.cache'), 'LruCache');
  assert.equal(t.get('n'), undefined, 'lower-case types are not classes');
  assert.equal(t.get('dup'), undefined, 'two different classes: left untyped');
});

test('receiverTypes reads Python assignments, self fields and annotated parameters', () => {
  const t = receiverTypes('client = HttpClient(url)\nclass S:\n    def __init__(self, db: Database):\n        self.pool = Pool(4)\n', 'python');
  assert.equal(t.get('client'), 'HttpClient');
  assert.equal(t.get('db'), 'Database');
  assert.equal(t.get('this.pool'), 'Pool');
});

test('receiverKey keeps plain names and this/self fields only', () => {
  assert.equal(receiverKey('host'), 'host');
  assert.equal(receiverKey('this.host'), 'this.host');
  assert.equal(receiverKey('self.pool'), 'this.pool');
  assert.equal(receiverKey('this'), undefined);
  assert.equal(receiverKey('a.b.c'), undefined);
  assert.equal(receiverKey('getHost()'), undefined);
});

test('a member call carries its receiver and inferred type out of the parse', async () => {
  const tags = await extractTags('class McpHost { status() { return 1; } }\nconst host = new McpHost();\nhost.status();\nthis.other.go();\n', 'typescript');
  const call = tags.find((t) => t.kind === 'ref' && t.name === 'status');
  assert.equal(call?.receiver, 'host');
  assert.equal(call?.receiverType, 'McpHost');
  const other = tags.find((t) => t.kind === 'ref' && t.name === 'go');
  assert.equal(other?.receiver, 'this.other');
  assert.equal(other?.receiverType, undefined);
});

test('chooseTarget picks the method of the receiver class, and changes nothing without one', () => {
  const def = (path: string, line: number): DefinitionRow => ({ path, name: 'status', kind: 'method', line, endLine: line + 2 }) as unknown as DefinitionRow;
  const hostStatus = def('src/mcp/host.ts', 10);
  const sessionStatus = def('src/session/store.ts', 40);
  const containerOf = (d: DefinitionRow) => (d === hostStatus ? 'McpHost' : 'SessionStore');
  const chosen = chooseTarget([hostStatus, sessionStatus], { fromPath: 'src/cli.ts', isCall: true, callShape: 'member', receiverType: 'McpHost', containerOf });
  assert.equal(chosen?.definition, hostStatus);
  assert.equal(chosen?.route, 'receiver-type');
  assert.equal(chooseTarget([hostStatus, sessionStatus], { fromPath: 'src/cli.ts', isCall: true, callShape: 'member', containerOf }), undefined, 'no receiver type: still ambiguous');
  assert.equal(chooseTarget([hostStatus, sessionStatus], { fromPath: 'src/cli.ts', isCall: true, callShape: 'member', receiverType: 'Other', containerOf }), undefined, 'no member of that class: nothing chosen');
});
