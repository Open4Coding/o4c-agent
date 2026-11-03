import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `/view-log` (plan 0006 E18): a run log, think blocks included, opened in the user's editor rather
 * than drawn in the terminal - it is long, and an editor can search it. The plain run log is turned
 * into readable text first (one header per entry, the text itself unescaped); FULLCONTEXT, the
 * lifecycle log and crash.log open as they are.
 */
export type LogKind = 'run' | 'full' | 'lifecycle' | 'crash';

/** The newest file of that kind in `dir`, or undefined. Run-log names are ISO timestamps, so they sort. */
export function newestLog(dir: string, kind: LogKind): string | undefined {
  if (kind === 'lifecycle') return existing(join(dir, 'lifecycle.jsonl'));
  if (kind === 'crash') return existing(join(dir, 'crash.log'));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const full = kind === 'full';
  const pick = names
    .filter((n) => n.endsWith('.jsonl') && n !== 'lifecycle.jsonl' && n.includes('.FULLCONTEXT.') === full)
    .sort()
    .at(-1);
  return pick ? join(dir, pick) : undefined;
}

function existing(path: string): string | undefined {
  try {
    readFileSync(path, { flag: 'r' }).length;
    return path;
  } catch {
    return undefined;
  }
}

const TEXT_FIELDS = ['text', 'content', 'output', 'message'] as const;

/** One readable block per log entry: `[time] kind`, then its text (or the remaining fields). */
export function renderRunLog(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line, '');
      continue;
    }
    const body = (e.event && typeof e.event === 'object' ? e.event : e) as Record<string, unknown>;
    const kind = [body.type, body.sub_type, body.name].filter((v) => typeof v === 'string' && v).join(' ') || 'entry';
    const time = typeof e.ts === 'string' ? e.ts.slice(11, 19) : '';
    const textField = TEXT_FIELDS.find((f) => typeof body[f] === 'string' && body[f] !== '');
    const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !['type', 'sub_type', 'name', 'ts', 'streamed', textField].includes(k)));
    out.push(`[${time}] ${kind}`);
    if (textField) out.push(String(body[textField]));
    if (Object.keys(rest).length) out.push(JSON.stringify(rest, null, 2));
    out.push('');
  }
  return out.join('\n');
}

/** The file to open for `kind`: a rendered copy of a run log, or the log itself. */
export function logToView(dir: string, kind: LogKind): { path?: string; error?: string } {
  const src = newestLog(dir, kind);
  if (!src) return { error: `No ${kind === 'run' ? 'run log' : kind === 'full' ? 'FULLCONTEXT log' : kind === 'lifecycle' ? 'lifecycle log' : 'crash.log'} in ${dir} yet.` };
  if (kind !== 'run') return { path: src };
  const outDir = join(tmpdir(), 'o4c-logs');
  mkdirSync(outDir, { recursive: true });
  const name = src.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '.txt');
  const path = join(outDir, name);
  writeFileSync(path, `${src}\n\n${renderRunLog(readFileSync(src, 'utf-8'))}`, 'utf-8');
  return { path };
}
