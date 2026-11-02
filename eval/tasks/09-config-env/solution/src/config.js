/** The app's settings: the defaults, then APP_<KEY> env vars, then explicit overrides. */
export function loadConfig(defaults, overrides = {}, env = process.env) {
  const fromEnv = {};
  for (const [key, value] of Object.entries(defaults)) {
    const raw = env[`APP_${key.toUpperCase()}`];
    if (raw === undefined) continue;
    if (typeof value === 'number') fromEnv[key] = Number(raw);
    else if (typeof value === 'boolean') fromEnv[key] = raw === 'true';
    else fromEnv[key] = raw;
  }
  return { ...defaults, ...fromEnv, ...overrides };
}
