import { normalize } from './normalize.js';

const routes = new Map([
  ['/users', () => ({ status: 200, body: ['ada'] })],
  ['/', () => ({ status: 200, body: 'home' })],
]);

export function handle(path) {
  const route = routes.get(normalize(path));
  return route ? route() : { status: 404 };
}
