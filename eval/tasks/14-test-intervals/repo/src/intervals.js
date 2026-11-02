/**
 * Merges overlapping or touching [start, end] intervals ([1, 3] and [3, 5] touch) and returns them
 * sorted by start. The input array and its intervals are not modified.
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].map((i) => [...i]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
