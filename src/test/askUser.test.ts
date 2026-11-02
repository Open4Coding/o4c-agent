import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askUserTool, setAskUserHandler } from '../tools/askUser.js';

/** Plan 0006 C7: one question to the user; headless runs are told to decide. */

test('headless: the model is told nobody can answer and to state its assumption', async () => {
  setAskUserHandler(undefined);
  assert.match(await askUserTool.execute({ question: 'Which database?' }), /No user is available.*say in your final answer what you assumed/);
  assert.match(await askUserTool.execute({ question: '  ' }), /needs a "question"/);
});

test('interactive: the question and options reach the handler; the answer comes back', async () => {
  const seen: Array<[string, string[]]> = [];
  setAskUserHandler(async (q, options) => (seen.push([q, options]), 'Postgres'));
  try {
    assert.equal(await askUserTool.execute({ question: 'Which database?', options: ['Postgres', 'SQLite', ''] }), 'The user answered: Postgres');
    assert.deepEqual(seen, [['Which database?', ['Postgres', 'SQLite']]]);
    setAskUserHandler(async () => undefined);
    assert.match(await askUserTool.execute({ question: 'Name?' }), /did not answer\. Decide yourself/);
  } finally {
    setAskUserHandler(undefined);
  }
});
