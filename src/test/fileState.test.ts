import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStateComponent } from '../session/fileState.js';
import { readFileTool } from '../tools/readFile.js';
import { editFileTool } from '../tools/editFile.js';
import { writeFileTool } from '../tools/writeFile.js';
import type { Tool } from '../tools/types.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-filestate-'));
  const path = join(dir, 'a.js');
  writeFileSync(path, 'const a = 1;\nconst b = 2;\n');
  const store = join(dir, '.o4c', 'filestate', 's1.json');
  const component = fileStateComponent({ file: store, cwd: dir });
  // The component resolves against its cwd (the temp dir); the tools against the process's, so they
  // get the absolute path - in o4c the two are the same directory.
  const call = (c: ReturnType<typeof fileStateComponent>, tool: Tool, input: Record<string, unknown>) =>
    c.aroundTool!({ tool, input }, () => tool.execute({ ...input, path: join(dir, String(input.path)) }));
  return { dir, path, store, component, call };
}

test('edit or overwrite of a file not read this session is refused; reading first allows it', async () => {
  const { component, call } = setup();
  assert.match(await call(component, editFileTool, { path: 'a.js', old_string: 'a = 1', new_string: 'a = 10' }), /a\.js has not been read in this session.*Nothing was changed/);
  assert.match(await call(component, writeFileTool, { path: 'a.js', content: 'x\n' }), /has not been read in this session/);
  assert.match(await call(component, writeFileTool, { path: 'new.js', content: 'const n = 1;\n' }), /^Wrote/);
  await call(component, readFileTool, { path: 'a.js' });
  assert.match(await call(component, editFileTool, { path: 'a.js', old_string: 'a = 1', new_string: 'a = 10' }), /^Edited/);
  // Its own edit keeps the record current: a second edit needs no re-read.
  assert.match(await call(component, editFileTool, { path: 'a.js', old_string: 'b = 2', new_string: 'b = 20' }), /^Edited/);
  assert.match(await call(component, editFileTool, { path: 'new.js', old_string: 'n = 1', new_string: 'n = 2' }), /^Edited/);
});

test('a file changed on disk since it was read is refused, and noted once at the next turn', async () => {
  const { path, component, call } = setup();
  await call(component, readFileTool, { path: 'a.js' });
  writeFileSync(path, 'const a = 1;\nconst b = 3;\n');
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  assert.match(await call(component, editFileTool, { path: 'a.js', old_string: 'a = 1', new_string: 'a = 5' }), /has changed on disk since you last read or wrote it/);
  assert.match(component.turnNote!({ message: 'next' })!, /Changed outside o4c since you last read them: a\.js\./);
  assert.equal(component.turnNote!({ message: 'again' }), undefined, 'reported once');
  await call(component, readFileTool, { path: 'a.js' });
  assert.match(await call(component, editFileTool, { path: 'a.js', old_string: 'a = 1', new_string: 'a = 5' }), /^Edited/);
});

test('an identical re-read of an unchanged file in the same turn gets a stub, once', async () => {
  const { component, call } = setup();
  const first = await call(component, readFileTool, { path: 'a.js' });
  assert.match(first, /const a = 1/);
  assert.match(await call(component, readFileTool, { path: 'a.js' }), /^\[o4c\] a\.js has not changed since you read these same lines 1 tool call\(s\) ago/);
  assert.equal(await call(component, readFileTool, { path: 'a.js' }), first, 'asked again right after the stub: the real content');
  assert.match(await call(component, readFileTool, { path: 'a.js', offset: 2 }), /const b = 2/, 'different lines: real content');
  component.turnNote!({ message: 'new turn' });
  assert.equal(await call(component, readFileTool, { path: 'a.js' }), first, 'a new turn: real content');
});

test('what was read survives a reload of the process (persisted per session)', async () => {
  const { dir, store, component, call } = setup();
  await call(component, readFileTool, { path: 'a.js' });
  const reloaded = fileStateComponent({ file: store, cwd: dir });
  assert.match(await call(reloaded, editFileTool, { path: 'a.js', old_string: 'a = 1', new_string: 'a = 7' }), /^Edited/);
  const fresh = fileStateComponent({ file: join(dir, '.o4c', 'filestate', 'other.json'), cwd: dir });
  assert.match(await call(fresh, editFileTool, { path: 'a.js', old_string: 'a = 7', new_string: 'a = 8' }), /has not been read/);
});
