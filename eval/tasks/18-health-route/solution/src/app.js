import { healthRoutes } from './routes/health.js';
import { userRoutes } from './routes/users.js';

const routes = [...userRoutes, ...healthRoutes];

/** Finds the route for a request ({ method, path }) and returns its { status, body }. */
export function handle(request) {
  const route = routes.find((r) => r.method === request.method && r.path === request.path);
  if (!route) return { status: 404, body: { error: 'not found' } };
  return route.handler(request);
}
