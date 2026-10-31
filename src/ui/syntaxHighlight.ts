import { createRequire } from 'node:module';
import { basename, extname } from 'node:path';
import type { HLJSApi, LanguageFn } from 'highlight.js';

/**
 * Syntax colouring for code shown in the terminal - checklist item 9, decided 2026-10-30: do it
 * the way Claude Code does (highlight.js, coloured diffs, coloured new-file previews, coloured code
 * blocks), built clean-room from its observed behaviour, not its code.
 *
 * highlight.js is the first dependency this project took for rendering. It has none of its own and
 * is BSD-3. Two things keep its cost down:
 *
 * - **Only the core is loaded, and each grammar on first use.** The full bundle registers 190+
 *   grammars at require time; Claude Code measured that at 100-200 ms on macOS and several times
 *   that on Windows. Here a session that never shows a Rust file never loads the Rust grammar.
 * - **No `cli-highlight`.** That wrapper turns highlight.js's HTML into ANSI, and pulls in yargs,
 *   parse5 and an older highlight.js to do it. `parseHighlighted` below is the same job in forty
 *   lines, and returns structure rather than escape codes - Ink wants `<Text color>` segments, and
 *   a test wants something it can read, since ink-testing-library strips colour from its frames.
 */

/** One run of text and the highlight.js scope it sits in (`keyword`, `title.function`, ...). */
export interface CodeSpan {
  readonly text: string;
  /** Absent for text no rule matched - identifiers, operators, whitespace. */
  readonly scope?: string;
}

export type CodeLine = readonly CodeSpan[];

/**
 * Past this, code is shown plain. highlight.js is linear but not free, and the dialogs that show
 * code only ever display a few dozen lines of it - the same reasoning as `MAX_DIFF_LINES`.
 */
export const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * Names a file extension or a code-fence tag may use, mapped to the highlight.js grammar module
 * that defines it. Ours rather than highlight.js's own alias table, because that table is only
 * readable once a grammar is loaded - which is the step this exists to defer.
 */
const GRAMMARS: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', typescript: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  py: 'python', pyi: 'python', python: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  cs: 'csharp', csharp: 'csharp',
  java: 'java',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', h: 'cpp', 'c++': 'cpp',
  c: 'c',
  php: 'php',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  rb: 'ruby', ruby: 'ruby',
  dart: 'dart',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin', kotlin: 'kotlin',
  lua: 'lua',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql',
  ps1: 'powershell', psm1: 'powershell', powershell: 'powershell', pwsh: 'powershell',
  bat: 'dos', cmd: 'dos',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  makefile: 'makefile', make: 'makefile', mk: 'makefile',
  diff: 'diff', patch: 'diff',
};

const require = createRequire(import.meta.url);
let core: HLJSApi | undefined;
const loaded = new Set<string>();

/** The core, loaded once on first use. */
function hljs(): HLJSApi {
  core ??= require('highlight.js/lib/core') as HLJSApi;
  return core;
}

/** The grammar for a fence tag or an extension (no dot), or `undefined` for one we do not map. */
export function grammarFor(name: string): string | undefined {
  return GRAMMARS[name.toLowerCase()];
}

/** The grammar for a file path: its extension, or its whole name for `Dockerfile` and `Makefile`. */
export function grammarForPath(path: string): string | undefined {
  const ext = extname(path).slice(1);
  return ext ? grammarFor(ext) : grammarFor(basename(path));
}

/** Registers a grammar the first time it is asked for. False if it cannot be loaded. */
function ensureGrammar(grammar: string): boolean {
  if (loaded.has(grammar)) return true;
  try {
    const module = require(`highlight.js/lib/languages/${grammar}`) as LanguageFn | { default: LanguageFn };
    hljs().registerLanguage(grammar, typeof module === 'function' ? module : module.default);
    loaded.add(grammar);
    return true;
  } catch {
    return false;
  }
}

/** Code split into lines, without a highlighter: what is shown when there is no grammar. */
export function plainLines(code: string): CodeLine[] {
  return code.split('\n').map((text) => (text === '' ? [] : [{ text }]));
}

/**
 * `code` as coloured lines. Falls back to plain lines - never throws - for an unknown grammar,
 * oversized input or a highlighter error: colour is an aid to reading, and a dialog that fails
 * to appear because of it would be the opposite.
 *
 * Highlighted as one text rather than line by line, because a block comment or a template string
 * spans lines and only the whole text knows where it ends. The line count always equals
 * `code.split('\n').length`, so callers can index lines by number.
 */
export function highlightCode(code: string, grammar: string | undefined): CodeLine[] {
  if (!grammar || code.length > MAX_HIGHLIGHT_CHARS || !ensureGrammar(grammar)) return plainLines(code);
  try {
    return parseHighlighted(hljs().highlight(code, { language: grammar, ignoreIllegals: true }).value);
  } catch {
    return plainLines(code);
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

/**
 * highlight.js's HTML output as lines of scoped spans.
 *
 * The output is a narrow, regular dialect - `<span class="hljs-x">`, `</span>`, and escaped text,
 * nothing else - which is why a tag regex is enough. The open-span stack carries across newlines,
 * so the second line of a block comment is still a comment. A nested span takes the innermost
 * scope: `${b}` inside a template string is a substitution, not string.
 *
 * Class names become scopes: `hljs-title function_` is `title.function`, which `scopeColor` can
 * match exactly or fall back to `title`.
 */
export function parseHighlighted(html: string): CodeLine[] {
  const lines: CodeSpan[][] = [[]];
  const stack: string[] = [];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    const token = match[0];
    if (match[1] !== undefined) {
      stack.push(scopeOf(match[1]));
      continue;
    }
    if (token === '</span>') {
      stack.pop();
      continue;
    }
    const text = token.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]);
    const scope = stack.length > 0 ? stack[stack.length - 1] : undefined;
    text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push(scope ? { text: part, scope } : { text: part });
    });
  }
  return lines;
}

function scopeOf(classes: string): string {
  return classes
    .split(' ')
    .filter((c) => c !== '')
    .map((c) => c.replace(/^hljs-/, '').replace(/_+$/, ''))
    .join('.');
}
