import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TRACKED_SESSIONS,
  USAGE_FILE_VERSION,
  UsageStore,
  type SessionSpend,
  type TokenSpend,
} from '../session/usageStore.js';
import { usageFileFor } from '../session/projectContext.js';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-usage-'));
  return join(dir, 'usage.json');
}

/** What a test moves to stand in for `loop.getUsage()`. `requests` is optional so the tests that
 * are only about tokens read the way they did before v3 added it. */
type Spend = TokenSpend & { requests?: number };

/** A store on a frozen clock, advanced only by `clock.ms`: active time is then an exact number in
 * every assertion rather than however long the test itself took to run. */
function storeWith(file: string, spend: Spend, clock = { ms: 0 }): UsageStore {
  return new UsageStore(
    file,
    () => ({ input: spend.input, output: spend.output, requests: spend.requests ?? 0 }),
    () => clock.ms,
  );
}

/** A session's record as `totals()` reports it, for the tests that only care about tokens. */
function spentOnly(input: number, output: number): SessionSpend {
  return { input, output, requests: 0, activeMs: 0 };
}

async function read(file: string): Promise<{ version: number; project: TokenSpend; sessions: Record<string, SessionSpend> }> {
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
    session: spentOnly(0, 0),
  });
  spend.input = 18_600_000;
  spend.output = 1_300_000;
  assert.deepEqual(store.totals(), {
    project: { input: 18_600_000, output: 1_300_000 },
    session: spentOnly(18_600_000, 1_300_000),
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
    session: spentOnly(250, 40),
  });
  b.setSessionId('session-b');
  b.flush();

  const stored = await read(file);
  assert.deepEqual(stored.project, { input: 1_250, output: 240 });
  assert.deepEqual(stored.sessions, {
    'session-a': spentOnly(1_000, 200),
    'session-b': spentOnly(250, 40),
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
    session: spentOnly(5_500, 1_200),
  });
});

test('the session clock survives the per-turn reload', async () => {
  // 0002 item 7, and the whole reason active time is stored at all: the footer clock used to count
  // from process start, so it restarted every turn or two and a long session read as a short one.
  const file = await tempFile();
  const first = { ms: 0 };
  const a = storeWith(file, { input: 10, output: 2 }, first);
  a.load(undefined);
  a.setSessionId('s1');
  first.ms = 90_000; // a turn and a half
  assert.equal(a.totals().session.activeMs, 90_000);
  a.flush();

  // The next process starts its own clock wherever the machine's happens to be - the stored
  // baseline is what carries the first 90 seconds over.
  const second = { ms: 5_000_000 };
  const b = storeWith(file, { input: 0, output: 0 }, second);
  b.load('s1');
  assert.equal(b.totals().session.activeMs, 90_000, 'picks the clock up where it was left');
  second.ms += 30_000;
  assert.equal(b.totals().session.activeMs, 120_000, 'and keeps running');
  b.flush();
  assert.equal((await read(file)).sessions.s1.activeMs, 120_000);
});

test('a resumed session does not count the hours it sat closed', async () => {
  // The decision this encodes (David, 2026-10-10): the clock is time with the app open on this
  // session, not wall time since the session was created. Resuming yesterday's session must not
  // open on "14h 22m" of work nobody did.
  const file = await tempFile();
  const first = { ms: 0 };
  const a = storeWith(file, { input: 5, output: 1 }, first);
  a.load(undefined);
  a.setSessionId('s');
  first.ms = 60_000;
  a.flush();

  const aDayLater = { ms: 24 * 60 * 60 * 1000 };
  const b = storeWith(file, { input: 0, output: 0 }, aDayLater);
  b.load('s');
  assert.equal(b.totals().session.activeMs, 60_000, 'the day it sat closed is not active time');
});

test('requests sent survive the reload too, so /context stops resetting', async () => {
  const file = await tempFile();
  const a = storeWith(file, { input: 100, output: 20, requests: 3 });
  a.load(undefined);
  a.setSessionId('s');
  a.flush();

  const b = storeWith(file, { input: 10, output: 4, requests: 1 });
  b.load('s');
  assert.equal(b.totals().session.requests, 4);
  b.flush();
  assert.equal((await read(file)).sessions.s.requests, 4);
});

test('time alone is worth a write, once there is a session to file it under', async () => {
  // A turn can spend no tokens at all (`/context` itself does not call the model) and the session
  // was still open for it.
  const file = await tempFile();
  const clock = { ms: 0 };
  const store = storeWith(file, { input: 0, output: 0 }, clock);
  store.load(undefined);
  store.setSessionId('s');
  clock.ms = 45_000;
  store.flush();
  const stored = await read(file);
  assert.deepEqual(stored.project, { input: 0, output: 0 }, 'no tokens were spent, and none are claimed');
  assert.deepEqual(stored.sessions.s, { input: 0, output: 0, requests: 0, activeMs: 45_000 });
});

test('a clock that steps backwards never produces a negative', async () => {
  // Wall clocks move: NTP steps them and DST shifts them. `-3s of active time` would render as
  // nonsense and persist as nonsense.
  const file = await tempFile();
  const clock = { ms: 1_000_000 };
  const store = storeWith(file, { input: 1, output: 1 }, clock);
  store.load(undefined);
  store.setSessionId('s');
  clock.ms = 900_000; // the clock stepped back 100 seconds
  assert.equal(store.totals().session.activeMs, 0);
  store.flush();
  assert.equal((await read(file)).sessions.s.activeMs, 0);
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
  // No tokens AND no session id - a process that never got as far as a first save has nowhere to
  // file its seconds either, so it should not create a usage file just to say so.
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
    session: spentOnly(1_210, 2),
  });
  store.flush();
  const stored = await read(file);
  assert.equal(stored.version, USAGE_FILE_VERSION, 'rewritten in the current shape');
  assert.deepEqual(stored.project, { input: 5_010, output: 2 });
});

test('a v2 file starts the two new counters at zero rather than at NaN', async () => {
  // v3 added activeMs and requests. An existing file has neither, which is not an error: the
  // tokens carry over and the clock starts counting from this launch.
  const file = await tempFile();
  await writeFile(
    file,
    JSON.stringify({ version: 2, project: { input: 900, output: 90 }, sessions: { s: { input: 400, output: 40 } } }),
    'utf-8',
  );
  const clock = { ms: 0 };
  const store = storeWith(file, { input: 0, output: 0 }, clock);
  store.load('s');
  assert.deepEqual(store.totals().session, { input: 400, output: 40, requests: 0, activeMs: 0 });
  clock.ms = 10_000;
  store.flush();
  const stored = await read(file);
  assert.equal(stored.version, USAGE_FILE_VERSION);
  assert.deepEqual(stored.sessions.s, { input: 400, output: 40, requests: 0, activeMs: 10_000 });
});

test('a corrupt or hand-edited file degrades to zero instead of NaN forever', async () => {
  const file = await tempFile();
  await writeFile(file, '{ this is not json', 'utf-8');
  const store = storeWith(file, { input: 10, output: 3 });
  store.load(undefined);
  assert.deepEqual(store.totals(), { project: { input: 10, output: 3 }, session: spentOnly(10, 3) });
  store.flush();
  assert.deepEqual((await read(file)).project, { input: 10, output: 3 });

  const bad = await tempFile();
  await writeFile(
    bad,
    JSON.stringify({ version: 3, project: { input: 'lots', output: null }, sessions: { x: { input: 'no', activeMs: 'ages', requests: {} } } }),
    'utf-8',
  );
  const second = storeWith(bad, { input: 5, output: 1 });
  second.load('x');
  assert.deepEqual(second.totals(), { project: { input: 5, output: 1 }, session: spentOnly(5, 1) });
});

test('a file from a newer version is left alone rather than overwritten', async () => {
  const file = await tempFile();
  const future = { version: USAGE_FILE_VERSION + 1, project: { input: 999, output: 99 }, somethingNew: true };
  await writeFile(file, JSON.stringify(future), 'utf-8');
  const store = storeWith(file, { input: 100, output: 10 });
  store.load(undefined);
  // Reports only this process - it will not pretend to understand the stored shape.
  assert.deepEqual(store.totals(), { project: { input: 100, output: 10 }, session: spentOnly(100, 10) });
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
