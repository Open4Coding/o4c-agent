import { query } from './db.js';

export function listUsers(filter) {
  return query(filter);
}
