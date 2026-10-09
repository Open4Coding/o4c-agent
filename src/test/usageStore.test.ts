import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TRACKED_SESSIONS, USAGE_FILE_VERSION, UsageStore, type TokenSpend } from '../session/usageStore.js';
import { usageFileFor } from '../session/projectContext.js';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-usage-'));
  return join(dir, 'usage.json');
}

/** A store whose spend is a pair the test moves, standing in for `loop.getUsage()`. */
function storeWith(file: string, spend: TokenSpend): UsageStore {
  return new UsageStore(file, () => spend);
}

async function read(file: string): Promise<{ version: number; project: TokenSpend; sessions: Record<string, TokenSpend> }> {
  return JSON.parse(await readFile(file, 'utf-8'));
}

test('the count is per project and nowhere else', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.equal(usageFileFor(root), join(root, '.o4c', 'usage.json'));
  // No global fallback: "what has this project cost" is the only question being asked, and a
  // figure pooled across every unrelated directory would answer nothing.
  assert.equal(usageFileFor(undefined), undefined);
});

test('prompt and completion are counted apart, not summed', () => {
  // The reason for the split: a measured 8h run sent 18.6M prompt tokens and generated 1.3M, so a
  // single total is 94% prefill and hides the number that tracks output.
  const spend = { input: 0, output: 0 };
  const store = storeWith(join(tmpdir(), 'o4c-usage-nonexistent', 'usage.json'), spend);
  store.load(undefined);
  assert.deepEqual(store.totals(), {
    project: { input: 0, output: 0 },
    session: { input: 0, output: 0 },
  });
  spend.input = 18_600_000;
  spend.output = 1_300_000;
  assert.deepEqual(store.totals(), {
    project: { input: 18_600_000, output: 1_300_000 },
    session: { input: 18_600_000, output: 1_300_000 },
  });
});

test('the project total accumulates across processes while the session total does not', async () => {
  // The case that motivates the whole file: o4c reloads into a fresh process after most turns, so
  // "this process" is about one turn's worth of tokens.
  const file = await tempFile();
  const a = storeWith(file, { input: 1_000, output: 200 });
  a.load(undefined);
  a.setSessionId('session-a');
  a.flush();

  const b = storeWith(file, { input: 250, output: 40 });
  b.load(undefined);
  assert.deepEqual(b.totals(), {
    project: { input: 1_250, output: 240 },
    session: { input: 250, output: 40 },
  });
  b.setSessionId('session-b');
  b.flush();

  const stored = await read(file);
  assert.deepEqual(stored.project, { input: 1_250, output: 240 });
  assert.deepEqual(stored.sessions, {
    'session-a': { input: 1_000, output: 200 },
    'session-b': { input: 250, output: 40 },
  });
});

test('a reloaded session picks its own subtotal back up', async () => {
  const file = await tempFile();
  const a = storeWith(file, { input: 4_000, output: 900 });
  a.load(undefined);
  a.setSessionId('abc123');
  a.flush();

  const b = storeWith(file, { input: 1_500, output: 300 });
  b.load('abc123'); // what `--resume abc123` passes in
  assert.deepEqual(b.totals(), {
    project: { input: 5_500, output: 1_200 },
    session: { input: 5_500, output: 1_200 },
  });
});

test('flushing twice does not count this process twice', async () => {
  const file = await tempFile();
  const store = storeWith(file, { input: 777, output: 111 });
  store.load(undefined);
  store.setSessionId('s');
  store.flush();
  store.flush();
  store.flush();
  assert.deepEqual((await read(file)).project, { input: 777, output: 111 });
});

test('two concurrent sessions in one project are additive, not last-writer-wins', async () => {
  const file = await tempFile();
  const a = storeWith(file, { input: 300, output: 30 });
  const b = storeWith(file, { input: 500, output: 50 });
  a.load(undefined);
  b.load(undefined);
  a.setSessionId('a');
  b.setSessionId('b');
  a.flush();
  b.flush();
  assert.deepEqual((await read(file)).project, { input: 800, output: 80 });
});

test('spending nothing leaves the file untouched', async () => {
  const file = await tempFile();
  const store = storeWith(file, { input: 0, output: 0 });
  store.load(undefined);
  store.flush();
  await assert.rejects(() => readFile(file, 'utf-8'), 'no spend, no file');
});

test('output alone still counts, so a cached-prompt turn is not discarded', async () => {
  const file = await tempFile();
  const store = storeWith(file, { input: 0, output: 64 });
  store.load(undefined);
  store.flush();
  assert.deepEqual((await read(file)).project, { input: 0, output: 64 });
});

test('a v1 file keeps its lifetime figure instead of starting over', async () => {
  // v1 recorded one sum. Attributing it to input is an approximation and is documented as one -
  // prompt tokens were 93.6% of the total in the run that was measured - but silently zeroing
  // someone's lifetime count would be worse.
  const file = await tempFile();
  await writeFile(file, JSON.stringify({ version: 1, projectTokens: 5_000, sessions: { old: 1_200 } }), 'utf-8');
  const store = storeWith(file, { input: 10, output: 2 });
  store.load('old');
  assert.deepEqual(store.totals(), {
    project: { input: 5_010, output: 2 },
    session: { input: 1_210, output: 2 },
  });
  store.flush();
  const stored = await read(file);
  assert.equal(stored.version, USAGE_FILE_VERSION, 'rewritten in the current shape');
  assert.deepEqual(stored.project, { input: 5_010, output: 2 });
});

test('a corrupt or hand-edited file degrades to zero instead of NaN forever', async () => {
  const file = await tempFile();
  await writeFile(file, '{ this is not json', 'utf-8');
  const store = storeWith(file, { input: 10, output: 3 });
  store.load(undefined);
  assert.deepEqual(store.totals(), { project: { input: 10, output: 3 }, session: { input: 10, output: 3 } });
  store.flush();
  assert.deepEqual((await read(file)).project, { input: 10, output: 3 });

  const bad = await tempFile();
  await writeFile(bad, JSON.stringify({ version: 2, project: { input: 'lots', output: null }, sessions: { x: 'no' } }), 'utf-8');
  const second = storeWith(bad, { input: 5, output: 1 });
  second.load('x');
  assert.deepEqual(second.totals(), { project: { input: 5, output: 1 }, session: { input: 5, output: 1 } });
});

test('a file from a newer version is left alone rather than overwritten', async () => {
  const file = await tempFile();
  const future = { version: USAGE_FILE_VERSION + 1, project: { input: 999, output: 99 }, somethingNew: true };
  await writeFile(file, JSON.stringify(future), 'utf-8');
  const store = storeWith(file, { input: 100, output: 10 });
  store.load(undefined);
  // Reports only this process - it will not pretend to understand the stored shape.
  assert.deepEqual(store.totals(), { project: { input: 100, output: 10 }, session: { input: 100, output: 10 } });
  store.flush();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf-8')), future, 'not clobbered');
});

test('the session list stays bounded, keeping the most recent', async () => {
  const file = await tempFile();
  for (let i = 0; i < MAX_TRACKED_SESSIONS + 5; i++) {
    const store = storeWith(file, { input: 1, output: 1 });
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
  assert.deepEqual(stored.project, { input: MAX_TRACKED_SESSIONS + 5, output: MAX_TRACKED_SESSIONS + 5 });
});

test('an unwritable location fails silently rather than breaking the exit', async () => {
  // flush() runs from process.on('exit'); a throw there would be a crash on the way out, over a
  // display counter.
  const dir = await mkdtemp(join(tmpdir(), 'o4c-usage-'));
  const file = join(dir, 'usage.json');
  await mkdir(file, { recursive: true }); // a directory where the file should be
  const store = storeWith(file, { input: 42, output: 7 });
  store.load(undefined);
  assert.doesNotThrow(() => store.flush());
});

test('a session that never gets an id still counts toward the project', async () => {
  // A turn that fails before the first save has no session id; the tokens were still spent.
  const file = await tempFile();
  const store = storeWith(file, { input: 620, output: 80 });
  store.load(undefined);
  store.flush();
  const stored = await read(file);
  assert.deepEqual(stored.project, { input: 620, output: 80 });
  assert.deepEqual(stored.sessions, {});
});
