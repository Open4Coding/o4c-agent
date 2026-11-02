const USERS = Array.from({ length: 237 }, (_, i) => ({ id: i + 1, name: `user${i + 1}`, active: i % 3 !== 0 }));

/** The users matching filter, in id order. */
export function query(filter = {}) {
  return USERS.filter((u) => filter.active === undefined || u.active === filter.active);
}
