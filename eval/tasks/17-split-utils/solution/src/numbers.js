export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function roundTo(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
