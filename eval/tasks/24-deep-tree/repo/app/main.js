import { getConfig } from './server/config/index.js';
import { start } from './server/http/start.js';

export function boot(env = process.env) {
  return start(getConfig(env));
}
