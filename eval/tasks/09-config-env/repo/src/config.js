/** The app's settings: the defaults, with any overrides on top. */
export function loadConfig(defaults, overrides = {}) {
  return { ...defaults, ...overrides };
}
