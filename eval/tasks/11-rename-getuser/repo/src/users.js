const USERS = new Map([
  [1, { id: 1, name: 'Ada' }],
  [2, { id: 2, name: 'Linus' }],
]);

export function getUsr(id) {
  const user = USERS.get(id);
  if (!user) throw new Error(`no user ${id}`);
  return user;
}
