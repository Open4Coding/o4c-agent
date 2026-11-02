const USERS = Array.from({ length: 237 }, (_, i) => ({ id: i + 1, name: `user${i + 1}`, active: i % 3 !== 0 }));

/** The users matching filter, in id order, and how many match in all. */
export function query(filter = {}, page = { offset: 0, limit: Infinity }) {
  const all = USERS.filter((u) => filter.active === undefined || u.active === filter.active);
  return { total: all.length, rows: all.slice(page.offset, page.offset + page.limit) };
}
