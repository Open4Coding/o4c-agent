import { query } from './db.js';

export function listUsers(filter, page) {
  return query(filter, page);
}
