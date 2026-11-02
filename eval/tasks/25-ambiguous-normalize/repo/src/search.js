import { normalize } from './text/normalize.js';

export function query(text) {
  return normalize(text).toLowerCase();
}
