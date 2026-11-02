import { createPool } from '../pool/create.js';

export function start(config) {
  return { listening: config.port, pool: createPool(config) };
}
