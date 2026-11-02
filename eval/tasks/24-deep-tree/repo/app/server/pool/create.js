// Connections idle for 3000 ms are closed.
export const IDLE_MS = 3000;

export function createPool(config) {
  return { size: 4, idleMs: IDLE_MS, timeoutMs: config.timeoutMs };
}
