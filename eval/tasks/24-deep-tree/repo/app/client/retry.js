export function backoff(attempt) {
  return Math.min(3000, 100 * 2 ** attempt);
}
