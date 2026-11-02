/**
 * Best-effort redaction of the credentials o4c itself holds (design §3.4, built 2026-11-02):
 * the local server key (`localApiKey` / `O4C_LOCAL_API_KEY`) and `ANTHROPIC_API_KEY`. Every place
 * o4c writes text to disk - the run logs, `history.db`, session files - passes it through
 * `redactSecrets` first, so a key that shows up in a tool result (a model running `env`, a config
 * file it read) is never stored. Only the values o4c knows are replaced; this is not a general
 * secret scanner.
 *
 * Process-wide on purpose: cli.ts registers the keys once at startup, and the writers deep in the
 * session code read the same set without every constructor having to carry it.
 */

export const REDACTED = '[redacted]';

/** Shorter values are not treated as secrets - replacing a 3-character string everywhere would
 * mangle ordinary text. Real keys are much longer. */
export const MIN_SECRET_LENGTH = 8;

const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
}

/** For tests. */
export function clearSecrets(): void {
  secrets.clear();
}

/** `text` with every registered secret replaced. Also replaces the JSON-escaped form, so a key
 * containing `"` or `\` is caught inside an already-serialised line. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join(REDACTED);
  }
  return out;
}

/** Same as `redactSecrets` for an optional value. */
export function redactOptional<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? redactSecrets(text) : text) as T;
}
