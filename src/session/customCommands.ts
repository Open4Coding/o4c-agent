import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Custom commands (plan 0006 G1): a markdown file in `.o4c/commands/` (this project) or
 * `~/.o4c/commands/` (everywhere) becomes a `/name` command - `review-diff.md` is `/review-diff`.
 *
 *   ---
 *   description: Review a file for bugs
 *   args: path, focus
 *   ---
 *   Review $path for bugs, paying most attention to $focus. Everything typed: $ARGUMENTS
 *
 * Running it puts the expanded body in the input box to read and edit - it is never sent on its
 * own, the same rule as MCP prompts. Placeholders: `$ARGUMENTS` (everything after the name), `$1`
 * to `$9` (space-separated words), and `$<arg>` for each declared arg, filled in order with the last
 * one taking the rest of the line. A project command wins over a global one of the same name; a
 * name that is already a built-in command is skipped and reported, never shadowing it.
 */
export interface CustomCommand {
  name: string;
  description: string;
  args: string[];
  body: string;
  file: string;
  scope: 'project' | 'global';
}

export function parseCommandFile(text: string): { description?: string; args: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { args: [], body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!;
  }
  const args = (meta.args ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((a) => a.trim().replace(/^["']|["']$/g, ''))
    .filter((a) => /^[A-Za-z_][\w-]*$/.test(a));
  return { description: meta.description?.replace(/^["']|["']$/g, ''), args, body: m[2]!.trim() };
}

function readDir(dir: string, scope: CustomCommand['scope']): CustomCommand[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const n of names.sort()) {
    const slug = n.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) continue;
    try {
      const parsed = parseCommandFile(readFileSync(join(dir, n), 'utf-8'));
      if (!parsed.body) continue;
      out.push({ name: `/${slug}`, description: parsed.description ?? `Custom command (${scope}): ${n}`, args: parsed.args, body: parsed.body, file: join(dir, n), scope });
    } catch {
      // An unreadable file is simply not a command.
    }
  }
  return out;
}

/** Every custom command, project over global; `taken` are names that must not be shadowed. */
export function loadCustomCommands(projectRoot: string | undefined, taken: ReadonlySet<string>, home = homedir()): { commands: CustomCommand[]; skipped: string[] } {
  const byName = new Map<string, CustomCommand>();
  for (const c of readDir(join(home, '.o4c', 'commands'), 'global')) byName.set(c.name, c);
  if (projectRoot) for (const c of readDir(join(projectRoot, '.o4c', 'commands'), 'project')) byName.set(c.name, c);
  const commands: CustomCommand[] = [];
  const skipped: string[] = [];
  for (const c of byName.values()) {
    if (taken.has(c.name)) skipped.push(`${c.name} (${c.file}) - a built-in command already has that name`);
    else commands.push(c);
  }
  return { commands, skipped };
}

/** The body with its placeholders filled from what was typed after the name. */
export function expandCustomCommand(cmd: { readonly args: readonly string[]; readonly body: string }, rest: string): string {
  const all = rest.trim();
  const words = all ? all.split(/\s+/) : [];
  const named: Record<string, string> = {};
  cmd.args.forEach((a, i) => {
    named[a] = i === cmd.args.length - 1 ? words.slice(i).join(' ') : (words[i] ?? '');
  });
  const names = Object.keys(named).sort((a, b) => b.length - a.length);
  let out = cmd.body.replace(/\$ARGUMENTS/g, all).replace(/\$([1-9])/g, (_, d: string) => words[Number(d) - 1] ?? '');
  for (const n of names) out = out.split(`$${n}`).join(named[n]!);
  return out;
}
