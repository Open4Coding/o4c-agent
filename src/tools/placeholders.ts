/**
 * Placeholders a model writes in place of code it did not want to repeat - "// ... rest of the file
 * unchanged", "# existing code here" (plan 0006 B6). In a write_file (which replaces the whole file)
 * or an edit_file new_string (which replaces old_string exactly) such a line deletes the real code
 * it stands for, silently. A line only counts when the text being replaced did not already have it,
 * so a file that genuinely contains such a comment can still be rewritten.
 */

const COMMENT = String.raw`(?:\/\/+|#+|\/\*+|\*|<!--|--|;+|%|'|rem\b)`;
const KEYWORDS = String.raw`(?:rest|remaining|existing|other|previous|unchanged|same|more|omitted|original|old|the\s+rest)`;

const PATTERNS: RegExp[] = [
  // "// ... rest of the code", "# ... existing imports", "/* ... */"
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)\s*(?:${KEYWORDS}\b.*)?(?:\*\/|-->)?\s*$`, 'i'),
  // "// rest of the file unchanged", "# existing code here", "<!-- remaining markup as before -->"
  new RegExp(String.raw`^\s*${COMMENT}\s*\(?\s*${KEYWORDS}\s+(?:of\s+(?:the\s+)?)?(?:file|code|function|class|method|implementation|imports|logic|content|lines|body|tests?|markup|styles)\b.*$`, 'i'),
  // "// ... (unchanged)", "# (code omitted for brevity)"
  new RegExp(String.raw`^\s*${COMMENT}.*\b(?:unchanged|omitted for brevity|same as before|as before|remains? the same|stays? the same|left as is|for brevity)\b.*$`, 'i'),
  // a bare "(rest of file unchanged)" or "[... existing code ...]" line
  new RegExp(String.raw`^\s*[[(]\s*(?:\.\.\.\s*)?${KEYWORDS}\b.*(?:code|file|unchanged|here)\b.*[\])]\s*$`, 'i'),
];

/** The first placeholder line in `text` that `before` did not already contain, if any. */
export function findPlaceholder(text: string, before = ''): string | undefined {
  const had = new Set(before.split(/\r?\n/).map((l) => l.trim()));
  for (const line of text.split(/\r?\n/)) {
    if (had.has(line.trim())) continue;
    if (PATTERNS.some((p) => p.test(line))) return line.trim();
  }
  return undefined;
}
