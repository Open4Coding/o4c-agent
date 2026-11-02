/**
 * A light repair for tool-call arguments that are almost JSON (plan 0006 B3): raw newlines, tabs and
 * carriage returns inside strings, and trailing commas before `}` or `]` - the two slips models make
 * most when writing file contents into a JSON string. Nothing is guessed beyond that: a repair that
 * still does not parse returns undefined, and the caller reports the error to the model.
 */
export function repairJson(text: string): Record<string, unknown> | undefined {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n') {
        out += '\\n';
        continue;
      } else if (ch === '\r') {
        out += '\\r';
        continue;
      } else if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  out = removeTrailingCommas(out);
  try {
    const parsed = JSON.parse(out) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Drops a comma followed only by whitespace and a closing bracket, outside strings. */
function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += ch;
  }
  return out;
}

/** The parser's complaint about `text`, for the message the model gets back. */
export function jsonError(text: string): string {
  try {
    JSON.parse(text);
    return 'not an object';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
