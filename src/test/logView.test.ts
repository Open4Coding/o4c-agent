import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logToView, newestLog, renderRunLog } from '../session/logView.js';
import { editorCommand, viewInEditor } from '../ui/externalEditor.js';

test('newestLog picks the newest run log, FULLCONTEXT separately, and the fixed-name logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-logview-'));
  try {
    assert.equal(newestLog(dir, 'run'), undefined);
    for (const n of ['2026-10-01T00-00-00-000Z.jsonl', '2026-10-02T00-00-00-000Z.jsonl', '2026-10-03T00-00-00-000Z.FULLCONTEXT.jsonl', 'lifecycle.jsonl']) {
      writeFileSync(join(dir, n), '{}\n');
    }
    assert.equal(newestLog(dir, 'run'), join(dir, '2026-10-02T00-00-00-000Z.jsonl'));
    assert.equal(newestLog(dir, 'full'), join(dir, '2026-10-03T00-00-00-000Z.FULLCONTEXT.jsonl'));
    assert.equal(newestLog(dir, 'lifecycle'), join(dir, 'lifecycle.jsonl'));
    assert.equal(newestLog(dir, 'crash'), undefined);
    assert.match(logToView(dir, 'crash').error ?? '', /No crash\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderRunLog gives each entry a header and its text unescaped, think blocks included', () => {
  const jsonl = [
    JSON.stringify({ ts: '2026-10-30T03:51:18.800Z', event: { type: 'think', text: 'Line one\nline two', streamed: true } }),
    JSON.stringify({ ts: '2026-10-30T03:51:19.000Z', event: { type: 'tool_call', name: 'read_file', input: { path: 'a.ts' } } }),
    'not json',
  ].join('\n');
  const out = renderRunLog(jsonl);
  assert.match(out, /\[03:51:18\] think\nLine one\nline two\n/);
  assert.match(out, /\[03:51:19\] tool_call read_file\n\{\n {2}"input": \{/);
  assert.match(out, /not json/);
});

test('logToView renders the run log to a readable copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-logview-'));
  try {
    writeFileSync(join(dir, '2026-11-02T10-00-00-000Z.jsonl'), `${JSON.stringify({ ts: '2026-11-02T10:00:00.000Z', event: { type: 'text', text: 'hello' } })}\n`);
    const r = logToView(dir, 'run');
    assert.ok(r.path?.endsWith('2026-11-02T10-00-00-000Z.txt'));
    assert.match(readFileSync(r.path!, 'utf-8'), /\[10:00:00\] text\nhello/);
    rmSync(r.path!, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('O4C_EDITOR wins over VISUAL and EDITOR', () => {
  assert.equal(editorCommand({ O4C_EDITOR: 'hx', VISUAL: 'code --wait', EDITOR: 'vim' }, 'linux'), 'hx');
});

test('viewInEditor starts a GUI editor without waiting for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-view-'));
  try {
    const marker = join(dir, 'opened.txt');
    const script = join(dir, 'gui-editor.mjs');
    writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv[2]);`);
    const r = viewInEditor(join(dir, 'log.txt'), { EDITOR: `node "${script}"` });
    assert.equal(r.ok, true);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(readFileSync(marker, 'utf-8'), join(dir, 'log.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
