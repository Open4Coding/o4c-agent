/** A request path in canonical form: one leading slash, no repeated slashes, no trailing slash. */
export function normalize(path) {
  return `/${path.split('/').filter(Boolean).join('/')}`;
}
