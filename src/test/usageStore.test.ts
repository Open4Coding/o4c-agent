import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TRACKED_SESSIONS, USAGE_FILE_VERSION, UsageStore } from '../session/usageStore.js';
import { usageFileFor } from '../session/projectContext.js';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-usage-'));
  return join(dir, 'usage.json');
}

/** A store whose "spend" is a number the test moves, standing in for `loop.getUsage()`. */
function storeWith(file: string, spend: { tokens: number }): UsageStore {
  return new UsageStore(file, () => spend.tokens);
}

async function read(file: string): Promise<{ projectTokens: number; sessions: Record<string, number>; version: number }> {
  return JSON.parse(await readFile(file, 'utf-8'));
}

test('the project total is kept in the project .o4c directory', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.equal(usageFileFor(root), join(root, '.o4c', 'usage.json'));
  // An untrusted run still counts somewhere rather than discarding the number.
  assert.ok(usageFileFor(undefined).endsWith(join('.o4c', 'usage.json')));
});

test('with no file yet, both totals are just this process', () => {
  const spend = { tokens: 0 };
  const store = storeWith(join(tmpdir(), 'o4c-usage-nonexistent', 'usage.json'), spend);
  store.load(undefined);
  assert.deepEqual(store.totals(), { projectTokens: 0, sessionTokens: 0 });
  spend.tokens = 1_500;
  assert.deepEqual(store.totals(), { projectTokens: 1_500, sessionTokens: 1_500 });
});

test('the project total accumulates across processes while the session total does not', async () => {
  // The case that motivates the whole file: o4c reloads into a fresh process after most turns, so
  // "this process" is about one turn's worth of tokens.
  const file = await tempFile();
  const first = { tokens: 1_000 };
  const a = storeWith(file, first);
  a.load(undefined);
  a.setSessionId('session-a');
  a.flush();

  // A different session later in the same project.
  const second = { tokens: 250 };
  const b = storeWith(file, second);
  b.load(undefined);
  assert.deepEqual(b.totals(), { projectTokens: 1_250, sessionTokens: 250 }, 'project carries, session starts fresh');
  b.setSessionId('session-b');
  b.flush();

  const stored = await read(file);
  assert.equal(stored.projectTokens, 1_250);
  assert.deepEqual(stored.sessions, { 'session-a': 1_000, 'session-b': 250 });
});

test("a reloaded session picks its own subtotal back up", async () => {
  // The per-turn reload resumes the same session id, so its running total has to survive the
  // process that ends - otherwise the session figure resets to zero every turn or two.
  const file = await tempFile();
  const turnOne = { tokens: 4_000 };
  const a = storeWith(file, turnOne);
  a.load(undefined);
  a.setSessionId('abc123');
  a.flush();

  const turnTwo = { tokens: 1_500 };
  const b = storeWith(file, turnTwo);
  b.load('abc123'); // what `--resume abc123` passes in
  assert.deepEqual(b.totals(), { projectTokens: 5_500, sessionTokens: 5_500 });
  b.flush();
  assert.deepEqual((await read(file)).sessions, { abc123: 5_500 });
});

test('flushing twice does not count this process twice', async () => {
  // process.on('exit') and the explicit call in cli.ts can both fire for one exit.
  const file = await tempFile();
  const spend = { tokens: 777 };
  const store = storeWith(file, spend);
  store.load(undefined);
  store.setSessionId('s');
  store.flush();
  store.flush();
  store.flush();
  assert.equal((await read(file)).projectTokens, 777);
});

test('two concurrent sessions in one project are additive, not last-writer-wins', async () => {
  // Both processes read the same baseline at startup; the one that exits second must still add to
  // what the first wrote, which is why flush() re-reads rather than trusting its own baseline.
  const file = await tempFile();
  const a = storeWith(file, { tokens: 300 });
  const b = storeWith(file, { tokens: 500 });
  a.load(undefined);
  b.load(undefined);
  a.setSessionId('a');
  b.setSessionId('b');
  a.flush();
  b.flush();
  assert.equal((await read(file)).projectTokens, 800);
});

test('spending nothing leaves the file untouched', async () => {
  // Launching and quitting without a turn must not create or rewrite anything.
  const file = await tempFile();
  const store = storeWith(file, { tokens: 0 });
  store.load(undefined);
  store.flush();
  await assert.rejects(() => readFile(file, 'utf-8'), 'no spend, no file');
});

test('a corrupt or hand-edited file degrades to zero instead of NaN forever', async () => {
  const file = await tempFile();
  await writeFile(file, '{ this is not json', 'utf-8');
  const store = storeWith(file, { tokens: 10 });
  store.load(undefined);
  assert.deepEqual(store.totals(), { projectTokens: 10, sessionTokens: 10 });
  store.flush();
  assert.equal((await read(file)).projectTokens, 10, 'the broken file is replaced, not propagated');

  // Nonsense in the individual counters is sanitised rather than arithmetic'd into NaN.
  const bad = await tempFile();
  await writeFile(bad, JSON.stringify({ version: 1, projectTokens: 'lots', sessions: { x: null } }), 'utf-8');
  const second = storeWith(bad, { tokens: 5 });
  second.load('x');
  assert.deepEqual(second.totals(), { projectTokens: 5, sessionTokens: 5 });
});

test('a file from a newer version is left alone rather than overwritten', async () => {
  const file = await tempFile();
  const future = { version: USAGE_FILE_VERSION + 1, projectTokens: 999, somethingNew: true };
  await writeFile(file, JSON.stringify(future), 'utf-8');
  const store = storeWith(file, { tokens: 100 });
  store.load(undefined);
  // Reports only this process - it will not pretend to understand the stored total.
  assert.deepEqual(store.totals(), { projectTokens: 100, sessionTokens: 100 });
  store.flush();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf-8')), future, 'not clobbered');
});

test('the session list stays bounded, keeping the most recent', async () => {
  const file = await tempFile();
  for (let i = 0; i < MAX_TRACKED_SESSIONS + 5; i++) {
    const store = storeWith(file, { tokens: 1 });
    store.load(undefined);
    store.setSessionId(`session-${i}`);
    store.flush();
  }
  const stored = await read(file);
  const ids = Object.keys(stored.sessions);
  assert.equal(ids.length, MAX_TRACKED_SESSIONS);
  assert.ok(ids.includes(`session-${MAX_TRACKED_SESSIONS + 4}`), 'newest kept');
  assert.ok(!ids.includes('session-0'), 'oldest dropped');
  // Trimming the list must never lose tokens from the project total.
  assert.equal(stored.projectTokens, MAX_TRACKED_SESSIONS + 5);
});

test('an unwritable location fails silently rather than breaking the exit', async () => {
  // flush() runs from process.on('exit'); a throw there would be a crash on the way out, over a
  // display counter.
  const dir = await mkdtemp(join(tmpdir(), 'o4c-usage-'));
  // A directory where the file should be: every write to it fails, on every platform.
  const file = join(dir, 'usage.json');
  await mkdir(file, { recursive: true });
  const store = storeWith(file, { tokens: 42 });
  store.load(undefined);
  assert.doesNotThrow(() => store.flush());
});

test('a session that never gets an id still counts toward the project', async () => {
  // A turn that fails before the first save has no session id; the tokens were still spent.
  const file = await tempFile();
  const store = storeWith(file, { tokens: 620 });
  store.load(undefined);
  store.flush();
  const stored = await read(file);
  assert.equal(stored.projectTokens, 620);
  assert.deepEqual(stored.sessions, {});
});
