import { DEFAULTS } from './defaults/index.js';

export function getConfig(env) {
  return {
    port: env.PORT ? Number(env.PORT) : DEFAULTS.port,
    timeoutMs: DEFAULTS.timeoutMs,
    retries: DEFAULTS.retries,
  };
}
