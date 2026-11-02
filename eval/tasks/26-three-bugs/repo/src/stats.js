/** Arithmetic mean. */
export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Middle value; for an even count, the mean of the two middle values. Does not modify xs. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Most frequent value; on a tie, the smallest of the tied values. */
export function mode(xs) {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best;
  let bestCount = 0;
  for (const [x, c] of counts) {
    if (c > bestCount) {
      best = x;
      bestCount = c;
    }
  }
  return best;
}

/** Sample standard deviation (divides by n - 1). */
export function stddev(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}
