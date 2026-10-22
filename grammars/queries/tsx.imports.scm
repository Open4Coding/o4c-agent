; Import bindings: which local name came from which module. Identical to `typescript.imports.scm`
; - the import syntax is the same node set, and `typescript.scm`/`tsx.scm` are duplicated the
; same way rather than introducing a language-family indirection for two files.
;
; Kept in a separate query file from `typescript.scm` on purpose. The tag query's measured
; precision (99.4-99.7%, `.docs/code-graph-acceptance.md`) is a property of those patterns, and
; editing that file to add imports would put every one of those numbers back in play for a change
; that is not about definitions or references at all. A separate query also means a language can
; have tags without imports, which is the normal case - only the ECMAScript family and Python
; carry the binding information in a shape worth extracting.
;
; Each pattern captures exactly two things: `@name.import`, the name the importing file can use,
; and `@module.import`, the specifier as written. A statement with several specifiers yields one
; match per specifier, each paired with the same module - verified against the real grammar, not
; assumed.
;
; `import type { T } from ...` is captured like any other named import. The binding is real even
; though it only exists at compile time, and it resolves a type annotation the same way.

; import { start } from './host'
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        !alias
        name: (identifier) @name.import)))
  source: (string (string_fragment) @module.import))

; import { start as go } from './host' - the local name is the alias, never the original
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        alias: (identifier) @name.import)))
  source: (string (string_fragment) @module.import))

; import start from './host'
(import_statement
  (import_clause (identifier) @name.import)
  source: (string (string_fragment) @module.import))

; import * as host from './host'
(import_statement
  (import_clause (namespace_import (identifier) @name.import))
  source: (string (string_fragment) @module.import))
