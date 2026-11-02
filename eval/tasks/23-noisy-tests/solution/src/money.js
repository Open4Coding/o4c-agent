/** Cents with tax added, rounded half up to a whole cent. rate is a fraction: 0.2 = 20%. */
export function addTax(cents, rate) {
  return Math.round(cents * (1 + rate));
}

/**
 * Splits cents into `parts` shares that differ by at most one cent and add up to the total; the
 * first shares get the extra cents.
 */
export function split(cents, parts) {
  const share = Math.floor(cents / parts);
  const extra = cents - share * parts;
  return Array.from({ length: parts }, (_, i) => share + (i < extra ? 1 : 0));
}

export function format(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
