import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_POLL_MS, serverDownRows, serverDownTitle } from '../ui/ServerDownPicker.js';

test('the title says what is wrong and offers the two ways out', () => {
  assert.ok(serverDownTitle('down').startsWith('Server is down, wait or choose another model'));
  assert.ok(serverDownTitle('loading').startsWith('Server is loading the model, wait or choose another model'));
  assert.ok(serverDownTitle('down').includes('Esc to close'));
});

test('the rows are Wait first (the default) and Choose another model second', () => {
  const rows = serverDownRows(0);
  assert.deepEqual(rows.map((r) => r.choice), ['wait', 'choose']);
  assert.equal(rows[1].text, 'Choose another model');
});

test('the Wait row says how often it checks and how many checks have run, so a long wait visibly keeps going', () => {
  assert.equal(serverDownRows(0)[0].text, 'Wait for the server (checking every 5 s)');
  assert.equal(serverDownRows(1)[0].text, 'Wait for the server (checked 1 time, every 5 s)');
  assert.equal(serverDownRows(12)[0].text, 'Wait for the server (checked 12 times, every 5 s)');
  assert.equal(SERVER_POLL_MS, 5000);
});

test('there is no time limit on waiting: the rows never offer to give up on a timer', () => {
  assert.equal(serverDownRows(10_000).some((r) => /time ?out|giving up|gave up/i.test(r.text)), false);
});
