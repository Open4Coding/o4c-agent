(struct_specifier name: (type_identifier) @name.definition.class body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name.definition.class)) @definition.class

(function_declarator declarator: (identifier) @name.definition.function) @definition.function

(type_definition declarator: (type_identifier) @name.definition.type) @definition.type

(enum_specifier name: (type_identifier) @name.definition.type) @definition.type

; Call references, authored 2026-10-18. aider's c-tags.scm captures 5 definition
; patterns and no references at all, which would yield a graph with nodes and no
; edges. Node shapes read off the real grammar, not guessed.
; Known hole: tree-sitter does not expand macros, so macro-defined call sites are
; invisible here. That is structural - no query fixes it - and it is why
; macro-heavy C measures poorly (0.58 vs a 1.00 grep baseline in the
; codebase-memory paper). Record it, do not paper over it.
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call
