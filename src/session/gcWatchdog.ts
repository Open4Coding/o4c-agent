/**
 * Proactively forces a garbage-collection pass once resident memory crosses a chosen watermark,
 * instead of only ever trusting V8's own internal heuristics for when collection is worthwhile.
 *
 * Real need found via direct user report + live monitoring, 2026-09-30: a long, verbose local-
 * model turn pushed RSS to 4+GB and crashed with a real "JavaScript heap out of memory" - mainly
 * caused by an O(n²) render-cost bug (see `loop.ts`'s own delta-throttling fix), which starved
 * V8's own GC of the chance to run at all during a long enough turn. Throttling render cost gives
 * GC a *fair chance* to run again, but doesn't make it run *proactively* at any particular number
 * - for anyone who wants memory kept down near a specific ceiling regardless (an older/lower-RAM
 * machine, in particular), this forces the issue on a fixed schedule rather than waiting to see if
 * V8 decides to collect on its own.
 *
 * Every dependency is injectable so this is fully testable without touching the real process's
 * actual memory or a real `global.gc` - see `defaultGcWatchdogDeps` for what production uses.
 */
export interface GcWatchdogDeps {
  getRssBytes: () => number;
  /** `global.gc` only exists at all when the process was started with Node's `--expose-gc` flag
   * (e.g. `NODE_OPTIONS=--expose-gc`) - undefined otherwise, which this treats as "nothing to call
   * yet", not an error. */
  getGc: () => (() => void) | undefined;
  setInterval: (callback: () => void, ms: number) => { unref?: () => void };
  clearInterval: (handle: unknown) => void;
}

export const defaultGcWatchdogDeps: GcWatchdogDeps = {
  getRssBytes: () => process.memoryUsage().rss,
  getGc: () => (global as { gc?: () => void }).gc,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Installs the watchdog. Checks every `intervalMs` (default 2s - frequent enough to catch a fast
 * climb, cheap enough that the check itself (one `memoryUsage()` call) is never the bottleneck)
 * and calls `global.gc()` whenever RSS is over `thresholdMB`. If `global.gc` isn't available at
 * all, warns exactly once via `onWarnUnavailable` (rather than silently doing nothing forever) and
 * keeps checking in case a later restart-with-the-flag scenario ever changes that - cheap to keep
 * polling, and simpler than trying to detect "this will never become available" reliably.
 *
 * Returns an uninstall function (clears the interval - always safe to call, including on a
 * process that never actually found `global.gc`).
 */
export function installGcWatchdog(
  thresholdMB: number,
  onWarnUnavailable: (message: string) => void,
  intervalMs = 2000,
  deps: GcWatchdogDeps = defaultGcWatchdogDeps,
): () => void {
  const thresholdBytes = thresholdMB * 1024 * 1024;
  let warned = false;
  const timer = deps.setInterval(() => {
    const gc = deps.getGc();
    if (typeof gc !== 'function') {
      if (!warned) {
        warned = true;
        onWarnUnavailable(
          `gcThresholdMB is configured (${thresholdMB}MB) but this process has no global.gc - ` +
            'start o4c with NODE_OPTIONS=--expose-gc (or set it on the environment permanently) ' +
            'for this setting to actually do anything.',
        );
      }
      return;
    }
    if (deps.getRssBytes() > thresholdBytes) gc();
  }, intervalMs);
  timer.unref?.();
  return () => deps.clearInterval(timer);
}
