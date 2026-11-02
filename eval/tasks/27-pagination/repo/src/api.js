import { listUsers } from './service.js';

/** GET /users?active=true|false - returns { status, body }. Query values arrive as strings. */
export function handle(req) {
  if (req.method !== 'GET' || req.path !== '/users') return { status: 404, body: { error: 'not found' } };
  const q = req.query ?? {};
  const filter = q.active === undefined ? {} : { active: q.active === 'true' };
  return { status: 200, body: { users: listUsers(filter) } };
}
