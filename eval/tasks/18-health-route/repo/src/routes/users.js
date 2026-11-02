export const userRoutes = [
  { method: 'GET', path: '/users', handler: () => ({ status: 200, body: [{ id: 1, name: 'Ada' }] }) },
];
