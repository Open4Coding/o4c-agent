/** Compares two version strings: negative if a < b, 0 if equal, positive if a > b. */
export function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortVersions(list) {
  return [...list].sort(compare);
}
