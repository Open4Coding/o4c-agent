/**
 * Splitting identifiers so that `parse` finds `parseFile`.
 *
 * ## Why this is done in JavaScript rather than in SQLite
 *
 * The design called for "FTS5 with a camelCase/snake_case-aware tokenizer", after
 * codebase-memory-mcp's `cbm_camel_split`. That turns out not to be reachable from here:
 * **a custom FTS5 tokenizer is a C callback registered through SQLite's C API**, and
 * `node:sqlite` exposes no way to register one. The options are a native extension - which
 * would end the zero-native-modules property verified in build step 1 - or pre-splitting at
 * insert time.
 *
 * So: pre-split. Each definition stores a `search_text` column holding the original identifier
 * plus its parts, indexed with the stock `unicode61` tokenizer. `parseFile` is stored as
 * `parseFile parse File`, so a search for `parse` matches it. The cost is a slightly larger
 * index and that the splitting rule is fixed at write time rather than query time, which means
 * **changing this function requires a reindex**. Noted here because that is not obvious from
 * the call site.
 */

/**
 * Splits an identifier into its parts, preserving the original.
 *
 * Handles the four conventions that actually occur, including the acronym case that naive
 * camelCase splitting gets wrong:
 *
 * - `parseFile` -> `parseFile`, `parse`, `File`
 * - `parse_file` -> `parse_file`, `parse`, `file`
 * - `parse-file` -> `parse-file`, `parse`, `file`
 * - `HTTPServer` -> `HTTPServer`, `HTTP`, `Server`   (not `H`, `T`, `T`, `P`, `Server`)
 * - `parseHTTPFile` -> `parseHTTPFile`, `parse`, `HTTP`, `File`
 * - `__dunder__` -> `__dunder__`, `dunder`
 *
 * Single-character parts are dropped: they carry no search value and inflate the index. The
 * original is always first, and the result has no duplicates.
 */
export function splitIdentifier(identifier: string): string[] {
  const parts: string[] = [];

  for (const chunk of identifier.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    // Break before a capital that starts a new word, and between an acronym run and the
    // capitalised word that follows it (`HTTPServer` -> `HTTP` + `Server`).
    for (const piece of chunk
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1\u0000$2')
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1\u0000$2')
      .split('\u0000')) {
      if (piece.length > 1) parts.push(piece);
    }
  }

  const unique = new Set<string>();
  const out: string[] = [];
  for (const candidate of [identifier, ...parts]) {
    if (candidate && !unique.has(candidate)) {
      unique.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/** The `search_text` value stored alongside a definition: the identifier and its parts. */
export function searchTextFor(identifier: string): string {
  return splitIdentifier(identifier).join(' ');
}
