export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function roundTo(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
