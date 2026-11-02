/** What grouping needs of a definition: its name, kind and line span. */
export interface Span {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

/**
 * `grep_files` output regrouped under the definition each match sits in (plan 0006 B13):
 *
 *     src/area.ts
 *       computeArea (function, 4-9):
 *         5: return r * r;
 *       (top level):
 *         1: import { pi } from './pi';
 *
 * The path is written once per file instead of once per line, and each match says which function
 * it is in - the question the model usually reads the file to answer. A file the graph has no
 * definitions for (no grammar, or nothing defined) keeps its plain `path:line: text` lines. Any other line (a summary, a notice)
 * passes through untouched, as does an output that has no matches in the usual form.
 */
export function groupGrepByDefinition(output: string, definitionsIn: (path: string) => readonly Span[] | undefined): string {
  const lines = output.split('\n');
  const parsed = lines.map((l) => /^(.+?):(\d+): (.*)$/.exec(l));
  if (!parsed.some(Boolean)) return output;

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = parsed[i];
    if (!m) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // A run of consecutive matches in one file.
    const path = m[1];
    const run: Array<{ line: number; text: string }> = [];
    while (i < lines.length && parsed[i] && parsed[i]![1] === path) {
      run.push({ line: Number(parsed[i]![2]), text: parsed[i]![3] });
      i++;
    }
    const defs = definitionsIn(path);
    if (!defs || defs.length === 0) {
      for (const r of run) out.push(`${path}:${r.line}: ${r.text}`);
      continue;
    }
    out.push(path);
    let current: string | undefined;
    for (const r of run) {
      const inside = defs.filter((d) => d.line <= r.line && d.endLine >= r.line);
      // The innermost: the latest start (a method inside its class).
      const def = inside.sort((a, b) => b.line - a.line)[0];
      const label = def ? `${def.name} (${def.kind}, ${def.line}-${def.endLine})` : '(top level)';
      if (label !== current) {
        out.push(`  ${label}:`);
        current = label;
      }
      out.push(`    ${r.line}: ${r.text}`);
    }
  }
  return out.join('\n');
}
