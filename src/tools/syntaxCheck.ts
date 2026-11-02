import type { Node as TsNode } from 'web-tree-sitter';
import { languageForPath } from '../graph/languages.js';
import { parserFor } from '../graph/loadLanguage.js';

/**
 * A syntax check after write_file / edit_file (plan 0006 B8), with the code graph's own bundled
 * tree-sitter grammars: an edit that unbalances a brace or drops a quote is reported in the tool
 * result, with line numbers, instead of surfacing three steps later as a confusing test failure.
 *
 * Only errors the edit introduced are reported - a file that already did not parse (a template, a
 * half-written file the user is in the middle of) does not make every edit look broken. Mode:
 * `warn` (default) writes and reports; `strict` refuses the write; `off` skips the check.
 * Config `syntaxCheck`.
 */
export type SyntaxCheckMode = 'warn' | 'strict' | 'off';

let mode: SyntaxCheckMode = 'warn';

export function setSyntaxCheckMode(next: unknown): void {
  mode = next === 'strict' || next === 'off' ? next : 'warn';
}

export function syntaxCheckMode(): SyntaxCheckMode {
  return mode;
}

export interface SyntaxProblem {
  line: number;
  what: string;
}

const MAX_REPORTED = 3;

/** Syntax problems in `text` parsed as `path`'s language; undefined when no grammar covers it. */
export async function syntaxProblems(path: string, text: string): Promise<SyntaxProblem[] | undefined> {
  const language = languageForPath(path);
  if (!language) return undefined;
  let parser;
  try {
    parser = await parserFor(language.id);
  } catch {
    return undefined;
  }
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    const out: SyntaxProblem[] = [];
    const lines = text.split('\n');
    const visit = (node: TsNode) => {
      if (out.length >= 50) return;
      if (node.isMissing) {
        out.push({ line: node.startPosition.row + 1, what: `missing "${node.type}"` });
        return;
      }
      if (node.type === 'ERROR') {
        const code = (lines[node.startPosition.row] ?? '').trim().slice(0, 80);
        out.push({ line: node.startPosition.row + 1, what: `cannot parse: ${code}` });
        return;
      }
      if (!node.hasError) return;
      for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    return out;
  } finally {
    tree.delete();
  }
}

/**
 * A sentence for the tool result when `after` has more syntax problems than `before`, else
 * undefined. Matched by count, not position: an edit shifts every line number below it.
 */
export async function newSyntaxProblems(path: string, before: string, after: string): Promise<string | undefined> {
  if (mode === 'off') return undefined;
  const now = await syntaxProblems(path, after);
  if (!now || now.length === 0) return undefined;
  const was = before ? ((await syntaxProblems(path, before)) ?? []) : [];
  if (now.length <= was.length) return undefined;
  const language = languageForPath(path)!;
  const shown = now.slice(0, MAX_REPORTED).map((p) => `line ${p.line}: ${p.what}`);
  const more = now.length > MAX_REPORTED ? ` (and ${now.length - MAX_REPORTED} more)` : '';
  return `the result does not parse as ${language.id}${was.length ? ` (it had ${was.length} problem${was.length === 1 ? '' : 's'} before, now ${now.length})` : ''}: ${shown.join('; ')}${more}`;
}
