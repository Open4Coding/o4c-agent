import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * `@path` mentions (plan 0006 E6): `@src/app.ts` or `@src/app.ts:10-40` in a message attaches that
 * file (or those lines) to what the model gets, so it does not spend a tool call reading what the
 * user already pointed at. Only a token naming an existing file counts - `@someone` in prose is
 * left alone. What the user typed is kept as typed; the contents follow it.
 */
export interface Mention {
  raw: string;
  path: string;
  from?: number;
  to?: number;
}

const MENTION = /(^|\s)@([^\s@:]+)(?::(\d+)(?:-(\d+))?)?/g;
const MAX_CHARS_PER_FILE = 20_000;
const MAX_CHARS_TOTAL = 60_000;

export function parseMentions(text: string, cwd = process.cwd()): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[2]!.replace(/[.,;)]+$/, '');
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ raw: m[0].trim(), path, ...(m[3] ? { from: Number(m[3]) } : {}), ...(m[4] ? { to: Number(m[4]) } : m[3] ? { to: Number(m[3]) } : {}) });
  }
  return out;
}

/** The message with each mentioned file's content attached after it; unchanged when there are none. */
export function expandMentions(text: string, cwd = process.cwd()): string {
  const mentions = parseMentions(text, cwd);
  if (mentions.length === 0) return text;
  const blocks: string[] = [];
  let total = 0;
  for (const m of mentions) {
    let body: string;
    try {
      body = readFileSync(resolve(cwd, m.path), 'utf-8');
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    const from = m.from ? Math.max(1, m.from) : 1;
    const to = m.to ? Math.min(lines.length, Math.max(from, m.to)) : lines.length;
    let shown = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
    if (shown.length > MAX_CHARS_PER_FILE) shown = `${shown.slice(0, MAX_CHARS_PER_FILE)}\n... (cut - read the rest with read_file)`;
    if (total + shown.length > MAX_CHARS_TOTAL) {
      blocks.push(`--- @${m.path}: not attached (the attachments reached their size limit) - read it with read_file ---`);
      continue;
    }
    total += shown.length;
    const range = m.from ? ` lines ${from}-${to}` : '';
    blocks.push(`--- @${m.path}${range} ---\n${shown}`);
  }
  return blocks.length ? `${text}\n\n[Attached by o4c for the @ mentions above]\n${blocks.join('\n\n')}` : text;
}

/** The `@partial` word at the end of the input, if the user is typing one. */
export function mentionPrefix(input: string): string | undefined {
  const m = /(^|\s)@([^\s@:]*)$/.exec(input);
  return m ? m[2] : undefined;
}

/** Project files for a typed prefix: path starts first, then contains; at most `limit`. */
export function mentionCandidates(prefix: string, files: readonly string[], limit = 5): string[] {
  const p = prefix.toLowerCase().replace(/\\/g, '/');
  const starts = files.filter((f) => f.toLowerCase().startsWith(p));
  const contains = files.filter((f) => !f.toLowerCase().startsWith(p) && f.toLowerCase().includes(p));
  return [...starts, ...contains].slice(0, limit);
}

/** The input with its trailing `@partial` replaced by `@file `. */
export function completeMention(input: string, file: string): string {
  return input.replace(/@([^\s@:]*)$/, `@${file} `);
}

export function toProjectPath(abs: string, cwd = process.cwd()): string {
  return relative(cwd, abs).replace(/\\/g, '/');
}
