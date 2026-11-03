import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyUser, parseNotifyMode, shouldNotifyTurn, toastCommand } from '../ui/notify.js';

test('parseNotifyMode accepts the four modes and defaults to bell', () => {
  assert.equal(parseNotifyMode('toast'), 'toast');
  assert.equal(parseNotifyMode('off'), 'off');
  assert.equal(parseNotifyMode(undefined), 'bell');
  assert.equal(parseNotifyMode('loud'), 'bell');
});

test('a turn notifies only past the threshold and never when off', () => {
  assert.equal(shouldNotifyTurn('bell', 19_000, 20), false);
  assert.equal(shouldNotifyTurn('bell', 20_000, 20), true);
  assert.equal(shouldNotifyTurn('off', 999_000, 20), false);
});

test('bell writes BEL; toast launches the platform notifier with the message in the environment', () => {
  const written: string[] = [];
  const launched: { cmd: string; msg?: string }[] = [];
  const deps = { write: (s: string) => written.push(s), launch: (cmd: string, _a: string[], env: NodeJS.ProcessEnv) => launched.push({ cmd, msg: env.O4C_NOTIFY_MSG }), platform: 'darwin' as const };
  notifyUser('bell', 'done', deps);
  assert.deepEqual(written, [String.fromCharCode(7)]);
  assert.equal(launched.length, 0);
  notifyUser('both', 'Approval needed', deps);
  assert.equal(written.length, 2);
  assert.deepEqual(launched, [{ cmd: 'osascript', msg: 'Approval needed' }]);
  notifyUser('off', 'x', deps);
  assert.equal(written.length, 2);
});

test('toastCommand per platform', () => {
  assert.equal(toastCommand('win32').cmd, 'powershell');
  assert.match(toastCommand('win32').args.at(-1)!, /ShowBalloonTip/);
  assert.equal(toastCommand('linux').cmd, 'sh');
});
