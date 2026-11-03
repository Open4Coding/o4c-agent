import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Autosuggest (plan 0006 L2, design §1.6): after a turn, a dimmed guess at the next message, shown in
 * the empty input box with a visible marker and an "→ accept" hint - not dim colour alone, which
 * terminals without SGR 2 render at full brightness. Right-arrow takes it into the box to edit or
 * send; typing anything else hides it.
 *
 * Off by default (`autosuggest`, `/config-autosuggest on|off`): it costs one extra request per turn.
 * That request is kept small on purpose - no thinking, no tools, and only the last exchange rather
 * than the whole conversation, so it stays a few hundred tokens whatever the session's size. Its
 * tokens are counted in usage like any other request.
 */
export const AUTOSUGGEST_KEY = 'autosuggest';

/** The longest suggestion shown; a guess longer than this is not a quick next message anyway. */
export const SUGGESTION_MAX_CHARS = 120;

const clip = (text: string, max: number) => (text.length > max ? `...${text.slice(text.length - max)}` : text);

export function suggestionPrompt(userMessage: string, reply: string): string {
  return [
    'Here is the end of a coding session between a user and an assistant.',
    '',
    `User: ${clip(userMessage.trim(), 1500)}`,
    '',
    `Assistant: ${clip(reply.trim(), 2000)}`,
    '',
    "Write the single most likely next message the user will send: a short instruction in the user's own",
    'voice, at most 15 words. Reply with that message only - no quotes, no preamble. If there is no obvious',
    'next step, reply with NONE.',
  ].join('\n');
}

/** The model's answer made into one suggestion line, or undefined when it has none to give. */
export function cleanSuggestion(raw: string): string | undefined {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return undefined;
  const text = line
    .replace(/^(user|next message|suggestion)\s*:\s*/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim();
  if (!text || /^none\.?$/i.test(text)) return undefined;
  return text.length > SUGGESTION_MAX_CHARS ? `${text.slice(0, SUGGESTION_MAX_CHARS - 3).trimEnd()}...` : text;
}

/**
 * Carried across the per-turn reload (a fresh process repaints the session): written just before
 * the restart, read and deleted once by the new process. A file in the temp dir rather than the
 * session itself - it is a hint for the next few seconds, not history.
 */
function suggestionFile(sessionId: string, dir = tmpdir()): string {
  return join(dir, `o4c-suggest-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
}

export function saveSuggestion(sessionId: string, text: string, dir?: string): void {
  try {
    writeFileSync(suggestionFile(sessionId, dir), text, 'utf-8');
  } catch {
    // A suggestion that cannot be carried over is simply not shown.
  }
}

export function takeSuggestion(sessionId: string | undefined, dir?: string): string | undefined {
  if (!sessionId) return undefined;
  const file = suggestionFile(sessionId, dir);
  try {
    const text = readFileSync(file, 'utf-8').trim();
    rmSync(file, { force: true });
    return text || undefined;
  } catch {
    return undefined;
  }
}
