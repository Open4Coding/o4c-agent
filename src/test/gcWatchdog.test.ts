import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGcWatchdog, type GcWatchdogDeps } from '../session/gcWatchdog.js';

// A fully fake, synchronous "timer" - calling `tick()` runs whatever was last scheduled, exactly
// once, without any real waiting. `clearInterval` records whether the (one) handle it's given
// was ever the one actually installed, so a test can assert uninstall really disarms it.
function fakeDeps(rssSequence: number[]): GcWatchdogDeps & { tick: () => void; gcCalls: number; cleared: boolean } {
  let rssIndex = 0;
  let scheduled: (() => void) | undefined;
  let gcCalls = 0;
  let cleared = false;
  let gcAvailable = true;
  const deps: GcWatchdogDeps & { tick: () => void; gcCalls: number; cleared: boolean } = {
    getRssBytes: () => rssSequence[Math.min(rssIndex++, rssSequence.length - 1)],
    getGc: () => (gcAvailable ? () => gcCalls++ : undefined),
    setInterval: (callback) => {
      scheduled = callback;
      return { unref: () => {} };
    },
    clearInterval: () => {
      cleared = true;
      scheduled = undefined;
    },
    tick: () => scheduled?.(),
    get gcCalls() {
      return gcCalls;
    },
    get cleared() {
      return cleared;
    },
  };
  (deps as unknown as { setGcAvailable: (v: boolean) => void }).setGcAvailable = (v: boolean) => {
    gcAvailable = v;
  };
  return deps;
}

const MB = 1024 * 1024;

test('calls gc() when RSS is over the configured threshold', () => {
  const deps = fakeDeps([600 * MB]);
  installGcWatchdog(500, () => {}, 2000, deps);
  deps.tick();
  assert.equal(deps.gcCalls, 1);
});

test('does not call gc() when RSS stays under the threshold', () => {
  const deps = fakeDeps([400 * MB]);
  installGcWatchdog(500, () => {}, 2000, deps);
  deps.tick();
  assert.equal(deps.gcCalls, 0);
});

test('calls gc() again on a later tick once RSS climbs back over the threshold', () => {
  const deps = fakeDeps([400 * MB, 600 * MB, 300 * MB, 900 * MB]);
  installGcWatchdog(500, () => {}, 2000, deps);
  deps.tick(); // 400MB - under
  deps.tick(); // 600MB - over, gc #1
  deps.tick(); // 300MB - under
  deps.tick(); // 900MB - over, gc #2
  assert.equal(deps.gcCalls, 2);
});

test('warns exactly once when global.gc is unavailable, not once per tick', () => {
  const deps = fakeDeps([600 * MB, 600 * MB, 600 * MB]);
  (deps as unknown as { setGcAvailable: (v: boolean) => void }).setGcAvailable(false);
  let warnings = 0;
  installGcWatchdog(500, () => {
    warnings++;
  }, 2000, deps);
  deps.tick();
  deps.tick();
  deps.tick();
  assert.equal(warnings, 1);
  assert.equal(deps.gcCalls, 0); // never had a real gc to call either
});

test('the returned uninstall function clears the interval', () => {
  const deps = fakeDeps([600 * MB]);
  const uninstall = installGcWatchdog(500, () => {}, 2000, deps);
  uninstall();
  assert.equal(deps.cleared, true);
});
