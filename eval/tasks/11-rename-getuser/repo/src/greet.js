import { getUsr as lookup } from './users.js';

// getUsr throws for an unknown id, so this falls back to a generic greeting.
export function greeting(id) {
  try {
    return `Hello, ${lookup(id).name}!`;
  } catch {
    return 'Hello!';
  }
}
