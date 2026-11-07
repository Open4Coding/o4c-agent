import assert from 'node:assert/strict';
import { atCommit, changedFiles, check, exists, finish, pathsIn, read, run } from '../../lib/check.mjs';

await check('the whole chain, in order', () => {
  const a = read('ANSWER.md');
  const chain = ['CustomEditorInput', 'LazilyResolvedWebviewEditorInput', 'WebviewInput', 'EditorInput', 'AbstractEditorInput', 'Disposable'];
  let at = -1;
  for (const name of chain) {
    const next = a.slice(at + 1).search(new RegExp(`\\b${name}\\b`));
    assert.ok(next >= 0, `${name} missing or out of order`);
    at += 1 + next;
  }
  for (const f of ['src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts', 'src/vs/workbench/common/editor/editorInput.ts', 'src/vs/base/common/lifecycle.ts']) {
    assert.ok(a.includes(f), `file ${f}`);
  }
});
await check('nothing but ANSWER.md changed', () => assert.deepEqual(changedFiles(), ['ANSWER.md']));
finish();
