import { packageRoot } from '../packageRoot.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * `/help <question>` (plan 0006 E4): answered from the docs that ship with o4c - `.docs/*.md` and
 * the README - searched locally (SQLite FTS5, built in memory on first use), no model call. Each
 * markdown heading starts a section; the best few sections are shown.
 */
export interface DocSection {
  file: string;
  heading: string;
  body: string;
}


export function docFiles(root = packageRoot()): string[] {
  const out: string[] = [];
  const docsDir = join(root, '.docs');
  if (existsSync(docsDir)) for (const f of readdirSync(docsDir).filter((n) => n.endsWith('.md')).sort()) out.push(join(docsDir, f));
  if (existsSync(join(root, 'README.md'))) out.push(join(root, 'README.md'));
  return out;
}

export function splitSections(file: string, text: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading = file.split(/[\\/]/).pop()!.replace(/\.md$/, '');
  let body: string[] = [];
  const flush = () => {
    const b = body.join('\n').trim();
    if (b) sections.push({ file, heading, body: b });
  };
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^#{1,4}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!.trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

let index: { db: DatabaseSync; fts: boolean; sections: DocSection[] } | undefined;

function build(files: string[]): NonNullable<typeof index> {
  const sections = files.flatMap((f) => {
    try {
      return splitSections(f, readFileSync(f, 'utf-8'));
    } catch {
      return [];
    }
  });
  const db = new DatabaseSync(':memory:');
  let fts = true;
  try {
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(heading, body)');
  } catch {
    fts = false;
    db.exec('CREATE TABLE docs (heading TEXT, body TEXT)');
  }
  const insert = db.prepare('INSERT INTO docs (rowid, heading, body) VALUES (?, ?, ?)');
  sections.forEach((s, i) => insert.run(i + 1, s.heading, s.body));
  return { db, fts, sections };
}

/** For tests: index these files instead of the bundled docs. */
export function useDocFiles(files: string[] | undefined): void {
  index?.db.close();
  index = files ? build(files) : undefined;
}

/** The sections that best answer `question`, best first. */
export function searchDocs(question: string, limit = 3): DocSection[] {
  index ??= build(docFiles());
  const words = (question.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []).filter((w) => !STOP.has(w));
  if (words.length === 0) return [];
  if (index.fts) {
    const query = words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
    const rows = index.db.prepare(`SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 4.0, 1.0) LIMIT ?`).all(query, limit) as Array<{ rowid: number }>;
    return rows.map((r) => index!.sections[Number(r.rowid) - 1]!);
  }
  const scored = index.sections.map((s) => ({ s, n: words.filter((w) => `${s.heading} ${s.body}`.toLowerCase().includes(w)).length })).filter((x) => x.n > 0);
  return scored.sort((a, b) => b.n - a.n).slice(0, limit).map((x) => x.s);
}

/** The docs section about a command, for its /help-<command> page, if the docs have one. */
export function commandSection(name: string): DocSection | undefined {
  index ??= build(docFiles());
  return index.sections.find((s) => s.heading.includes(name) || s.heading.includes(`\`${name}`));
}

export function formatSection(s: DocSection, maxLines = 25): string {
  const lines = s.body.split('\n');
  const shown = lines.slice(0, maxLines).join('\n');
  return `── ${s.heading}  (${s.file.split(/[\\/]/).slice(-2).join('/')})\n${shown}${lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines in that file)` : ''}`;
}

const STOP = new Set(['the', 'and', 'how', 'what', 'can', 'does', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'is', 'do', 'to', 'in', 'on', 'of', 'a', 'an', 'it', 'my', 'me', 'use', 'you', 'when', 'why', 'which', 'where']);
