import { listUsers } from './service.js';

function int(value, fallback) {
  if (value === undefined) return fallback;
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

/** GET /users?active=true|false&limit=N&offset=N - returns { status, body }. Query values arrive as strings. */
export function handle(req) {
  if (req.method !== 'GET' || req.path !== '/users') return { status: 404, body: { error: 'not found' } };
  const q = req.query ?? {};
  const filter = q.active === undefined ? {} : { active: q.active === 'true' };
  const limit = int(q.limit, 20);
  const offset = int(q.offset, 0);
  if (Number.isNaN(limit) || Number.isNaN(offset) || limit > 100) return { status: 400, body: { error: 'bad limit or offset' } };
  const { total, rows } = listUsers(filter, { limit, offset });
  return { status: 200, body: { users: rows, total } };
}
