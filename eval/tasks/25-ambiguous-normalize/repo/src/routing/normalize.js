/** A request path in canonical form: one leading slash, no repeated slashes. */
export function normalize(path) {
  return `/${path.split('/').filter(Boolean).join('/')}${path.endsWith('/') && path.length > 1 ? '/' : ''}`;
}
