(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_annotation
  (type_identifier) @name.reference.type) @reference.type

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(interface_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; Call/reference patterns grafted from aider's javascript-tags.scm: the TypeScript
; grammar is a superset of JavaScript's node types, and aider's typescript query
; captures definitions and type references but no calls at all.
(
  (call_expression
    function: (identifier) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
  arguments: (_) @reference.call)

; Functions assigned to a const, added 2026-10-18. aider's javascript-tags.scm has this
; pattern; its typescript one does not, so `const f = () => {}` was invisible as a
; definition - and in modern TypeScript and React that is most functions. Found by sampling
; unresolved call sites: `pushBlock` in src/ui/App.tsx had 75 call sites and no definition.
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

; The React higher-order-component case: `const f = useCallback(() => {}, [])`. Matching on
; the presence of an arrow-function argument keeps this precise - `const x = compute(1, 2)`
; has a call_expression value too and must NOT be captured as a function definition.
(variable_declarator
  name: (identifier) @name.definition.function
  value: (call_expression
    arguments: (arguments (arrow_function)))) @definition.function
