export const healthRoutes = [
  { method: 'GET', path: '/health', handler: () => ({ status: 200, body: { status: 'ok', uptime: process.uptime() } }) },
];
