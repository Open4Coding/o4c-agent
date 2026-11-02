/**
 * Which provider a bare `o4c` uses when neither `-p` nor a `provider` config key says (checklist
 * 0006 item 0.5, 2026-11-02). David's rule: a bare `o4c` must use the configured local default -
 * o4c is local-first, and falling back to Anthropic without a key only ends in "No Anthropic API key
 * found". So: any local server configured means local; an Anthropic key in the environment with no
 * local configuration means Anthropic; nothing at all means local (the server-down picker then says
 * what to do).
 */
export function defaultProvider(
  config: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (typeof config.provider === 'string' && config.provider !== '') return config.provider;
  if (typeof config.baseUrl === 'string' || typeof config.localApiKey === 'string' || env.O4C_LOCAL_API_KEY) return 'local';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'local';
}
